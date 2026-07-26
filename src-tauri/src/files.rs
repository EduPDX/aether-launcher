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

use serde::Serialize;

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

/// Move um arquivo ou pasta para a lixeira `.aether-trash` (recuperável).
/// Nunca apaga de vez — o mesmo princípio do sync ao aposentar arquivos.
#[tauri::command]
pub async fn fs_delete(dir: String, rel: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        guard_internal(&rel)?;
        let (base, full) = resolve(&dir, &rel)?;
        if !full.exists() {
            return Err("não encontrado".into());
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_else(|_| "0".into());
        let trash = base.join(".aether-trash").join(stamp);
        std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        let leaf = rel.trim_end_matches('/').replace('/', "_");
        let dest = trash.join(if leaf.is_empty() { "item".into() } else { leaf });
        std::fs::rename(&full, &dest).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Caminho absoluto de uma pasta, para abrir no explorador do sistema.
#[tauri::command]
pub async fn fs_abs_path(dir: String, rel: String) -> Result<String, String> {
    let (_, full) = resolve(&dir, &rel)?;
    Ok(full.to_string_lossy().to_string())
}
