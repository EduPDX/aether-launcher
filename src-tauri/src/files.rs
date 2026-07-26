//! Gerenciador de arquivos do cliente.
//!
//! Opera dentro da pasta do jogo do jogador. A divisão de responsabilidades é
//! deliberada e vale a longo prazo:
//!
//! * **Rust garante a segurança** — nenhum caminho pode escapar da pasta do
//!   jogo (sem `..`, sem caminho absoluto), a área interna `.aether-*` é
//!   intocável, e toda exclusão vai para `.aether-trash` (recuperável, o mesmo
//!   mecanismo que o sync usa ao aposentar arquivos).
//! * **O frontend aplica a política** — quais arquivos são do servidor
//!   (via [`fs_manifest`]) e portanto travados para edição/exclusão. Isso é um
//!   guarda-corpo de UX, não uma fronteira de segurança: são os arquivos do
//!   próprio usuário, e mexer num arquivo do servidor é recuperável (o sync o
//!   rebaixa/rebaixa de volta). Por isso não pagamos uma ida à rede a cada
//!   navegação — só ao entrar na seção.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{client, fetch_manifest};

/// Tamanho máximo de um arquivo aberto para edição de texto (1 MiB).
const MAX_EDIT_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Clone)]
pub struct FsEntry {
    name: String,
    /// Caminho relativo à pasta do jogo, com barras normais.
    rel: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize, Clone)]
pub struct ManagedDirDto {
    dir: String,
    patterns: Vec<String>,
    recursive: bool,
}

#[derive(Serialize, Clone)]
pub struct ManifestPaths {
    /// Caminhos exatos que o servidor sincroniza (travados na UI).
    files: Vec<String>,
    /// Pastas onde o sync remove tudo que não estiver no manifesto.
    managed_dirs: Vec<ManagedDirDto>,
}

/// Resolve `base/rel` recusando qualquer componente que escape da pasta do
/// jogo. `base` é canonicalizado (existe sempre — é a pasta do jogo); `rel`
/// pode ainda não existir (caso de criação).
fn resolve(base: &str, rel: &str) -> Result<(PathBuf, PathBuf), String> {
    let base = std::fs::canonicalize(base).map_err(|_| "pasta do jogo inválida".to_string())?;
    let mut full = base.clone();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => full.push(c),
            Component::CurDir => {}
            _ => return Err("caminho inválido".into()),
        }
    }
    Ok((base, full))
}

/// Recusa operações na área interna do launcher (lixeira, temporários).
fn guard_internal(rel: &str) -> Result<(), String> {
    let first = rel.split('/').find(|s| !s.is_empty()).unwrap_or("");
    if first.starts_with(".aether") {
        return Err("área interna do launcher".into());
    }
    Ok(())
}

fn to_rel(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .ok()
        .and_then(|r| r.to_str())
        .map(|r| r.replace('\\', "/"))
        .unwrap_or_default()
}

/// Conjunto de caminhos do servidor e regras de pastas gerenciadas, para o
/// frontend marcar o que está travado. Precisa da rede (busca o manifesto).
#[tauri::command]
pub async fn fs_manifest(server: String, profile_id: String) -> Result<ManifestPaths, String> {
    let http = client();
    let (_, manifest) = fetch_manifest(&http, &server, &profile_id).await?;
    Ok(ManifestPaths {
        files: manifest.files.iter().map(|f| f.path.clone()).collect(),
        managed_dirs: manifest
            .managed
            .iter()
            .map(|m| ManagedDirDto {
                dir: m.dir.clone(),
                patterns: m.patterns.clone(),
                recursive: m.recursive,
            })
            .collect(),
    })
}

/// Lista uma pasta (relativa à pasta do jogo). Operação puramente local — sem
/// rede — porque a navegação é frequente.
#[tauri::command]
pub async fn fs_list(dir: String, rel: String) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_blocking(&dir, &rel))
        .await
        .map_err(|e| e.to_string())?
}

fn list_blocking(dir: &str, rel: &str) -> Result<Vec<FsEntry>, String> {
    let (base, full) = resolve(dir, rel)?;
    if !full.is_dir() {
        return Err("pasta não encontrada".into());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&full).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Esconde a área interna do launcher e os temporários de download.
        if name.starts_with(".aether") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        out.push(FsEntry {
            rel: to_rel(&base, &entry.path()),
            name,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
        });
    }
    // Pastas primeiro, depois por nome (sem diferenciar maiúsculas).
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Lê um arquivo de texto para edição. Recusa binários e arquivos grandes.
#[tauri::command]
pub async fn fs_read(dir: String, rel: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, full) = resolve(&dir, &rel)?;
        if !full.is_file() {
            return Err("arquivo não encontrado".into());
        }
        let len = full.metadata().map_err(|e| e.to_string())?.len();
        if len > MAX_EDIT_BYTES {
            return Err("arquivo grande demais para editar aqui".into());
        }
        let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|_| "arquivo binário — não é editável".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Grava conteúdo de texto num arquivo (cria pastas intermediárias se preciso).
#[tauri::command]
pub async fn fs_write(dir: String, rel: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        guard_internal(&rel)?;
        let (_, full) = resolve(&dir, &rel)?;
        if full.is_dir() {
            return Err("já existe uma pasta com esse nome".into());
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&full, contents).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cria uma pasta nova.
#[tauri::command]
pub async fn fs_mkdir(dir: String, rel: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        guard_internal(&rel)?;
        let (_, full) = resolve(&dir, &rel)?;
        if full.exists() {
            return Err("já existe algo com esse nome".into());
        }
        std::fs::create_dir_all(&full).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cria um arquivo vazio. Erra se já existir (não sobrescreve).
#[tauri::command]
pub async fn fs_touch(dir: String, rel: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        guard_internal(&rel)?;
        let (_, full) = resolve(&dir, &rel)?;
        if full.exists() {
            return Err("já existe algo com esse nome".into());
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::File::create(&full).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Metadados de um item na lixeira — guardam o caminho original para restaurar
/// com fidelidade (inclusive pastas aninhadas).
#[derive(Serialize, Deserialize, Clone)]
struct TrashMeta {
    rel: String,
    name: String,
    is_dir: bool,
    ts: u64,
}

/// Item da lixeira exposto ao frontend.
#[derive(Serialize, Clone)]
pub struct TrashItem {
    id: String, // nome da pasta-slot (timestamp em ms)
    rel: String,
    name: String,
    is_dir: bool,
    ts: u64,
}

fn trash_dir(base: &Path) -> PathBuf {
    base.join(".aether-trash")
}

/// Valida que o id de um slot da lixeira é só o timestamp (sem travessia).
fn valid_slot_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())
}

/// Move um arquivo ou pasta para a lixeira `.aether-trash` (recuperável).
/// Cada item vai para um slot `{timestamp}/` com o próprio nome + `meta.json`,
/// preservando o caminho original para a restauração. Nunca apaga de vez.
#[tauri::command]
pub async fn fs_delete(dir: String, rel: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        guard_internal(&rel)?;
        let (base, full) = resolve(&dir, &rel)?;
        if !full.exists() {
            return Err("não encontrado".into());
        }
        let is_dir = full.is_dir();
        let name = full
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from)
            .ok_or("nome inválido")?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let slot = trash_dir(&base).join(ts.to_string());
        std::fs::create_dir_all(&slot).map_err(|e| e.to_string())?;
        std::fs::rename(&full, slot.join(&name)).map_err(|e| e.to_string())?;
        let meta = TrashMeta { rel: rel.trim_end_matches('/').to_string(), name, is_dir, ts };
        let json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
        std::fs::write(slot.join("meta.json"), json).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lista os itens da lixeira (só os slots com `meta.json`), mais novos primeiro.
#[tauri::command]
pub async fn fs_trash_list(dir: String) -> Result<Vec<TrashItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::fs::canonicalize(&dir).map_err(|_| "pasta do jogo inválida".to_string())?;
        let trash = trash_dir(&base);
        if !trash.is_dir() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&trash).map_err(|e| e.to_string())? {
            let slot = match entry {
                Ok(e) => e.path(),
                Err(_) => continue,
            };
            let id = match slot.file_name().and_then(|n| n.to_str()) {
                Some(n) if valid_slot_id(n) => n.to_string(),
                _ => continue,
            };
            let meta_raw = match std::fs::read(slot.join("meta.json")) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(m) = serde_json::from_slice::<TrashMeta>(&meta_raw) {
                out.push(TrashItem { id, rel: m.rel, name: m.name, is_dir: m.is_dir, ts: m.ts });
            }
        }
        out.sort_by(|a, b| b.ts.cmp(&a.ts));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restaura um item da lixeira para o lugar original. Falha se já existir algo lá.
#[tauri::command]
pub async fn fs_trash_restore(dir: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_slot_id(&id) {
            return Err("item inválido".into());
        }
        let base = std::fs::canonicalize(&dir).map_err(|_| "pasta do jogo inválida".to_string())?;
        let slot = trash_dir(&base).join(&id);
        let meta: TrashMeta = serde_json::from_slice(
            &std::fs::read(slot.join("meta.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let (_, target) = resolve(&dir, &meta.rel)?;
        if target.exists() {
            return Err("já existe um arquivo nesse lugar — mova ou renomeie antes".into());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(slot.join(&meta.name), &target).map_err(|e| e.to_string())?;
        std::fs::remove_dir_all(&slot).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Apaga de vez um item da lixeira.
#[tauri::command]
pub async fn fs_trash_purge(dir: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_slot_id(&id) {
            return Err("item inválido".into());
        }
        let base = std::fs::canonicalize(&dir).map_err(|_| "pasta do jogo inválida".to_string())?;
        std::fs::remove_dir_all(trash_dir(&base).join(&id)).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Esvazia a lixeira inteira.
#[tauri::command]
pub async fn fs_trash_empty(dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::fs::canonicalize(&dir).map_err(|_| "pasta do jogo inválida".to_string())?;
        let trash = trash_dir(&base);
        if trash.is_dir() {
            std::fs::remove_dir_all(&trash).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abre uma pasta no explorador do sistema. Feito em Rust (caminho validado
/// contra a pasta do jogo) para não depender do escopo do plugin opener.
#[tauri::command]
pub async fn fs_reveal(dir: String, rel: String) -> Result<(), String> {
    let (_, full) = resolve(&dir, &rel)?;
    if !full.exists() {
        return Err("pasta não encontrada".into());
    }
    open::that(full).map_err(|e| e.to_string())
}
