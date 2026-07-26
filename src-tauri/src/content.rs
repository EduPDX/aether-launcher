//! Descoberta e instalação de conteúdo do cliente (shaders, texturas) via
//! Modrinth. É tudo do lado do cliente — instala em `shaderpacks/` e
//! `resourcepacks/`, pastas que o sync do servidor não gerencia — então nunca
//! colide com o que é sincronizado.
//!
//! O tipo (`kind`) é agnóstico o suficiente para crescer: hoje "shader" e
//! "resourcepack"; amanhã datapacks, mundos, etc.

use std::path::PathBuf;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;

use crate::client;

const MODRINTH: &str = "https://api.modrinth.com/v2";

#[derive(Serialize, Clone)]
pub struct ModItem {
    project_id: String,
    slug: String,
    title: String,
    description: String,
    author: String,
    downloads: u64,
    icon_url: Option<String>,
    categories: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ContentContext {
    minecraft: Option<String>,
}

#[derive(Serialize, Clone)]
struct ContentProgress {
    name: String,
    done: u64,
    total: u64,
}

/// Pasta de destino de cada tipo de conteúdo (relativa à pasta do jogo).
fn folder_for(kind: &str) -> Option<&'static str> {
    match kind {
        "shader" => Some("shaderpacks"),
        "resourcepack" => Some("resourcepacks"),
        _ => None,
    }
}

/// Loaders que o Modrinth usa para cada tipo (para filtrar arquivos compatíveis).
fn loaders_for(kind: &str) -> &'static [&'static str] {
    match kind {
        "shader" => &["iris", "optifine", "canvas", "vanilla"],
        "resourcepack" => &["minecraft"],
        _ => &[],
    }
}

fn json_array(items: &[&str]) -> String {
    let inner: Vec<String> = items.iter().map(|s| format!("\"{s}\"")).collect();
    format!("[{}]", inner.join(","))
}

/// Versão do Minecraft do servidor (do manifesto), para filtrar a compatibilidade.
#[tauri::command]
pub async fn content_context(server: String, profile_id: String) -> Result<ContentContext, String> {
    let http = client();
    let (_, manifest) = crate::fetch_manifest(&http, &server, &profile_id).await?;
    Ok(ContentContext {
        minecraft: manifest.game.and_then(|g| g.minecraft),
    })
}

/// Busca projetos no Modrinth por tipo, texto e (opcionalmente) versão do jogo.
#[tauri::command]
pub async fn modrinth_search(
    kind: String,
    query: String,
    game_version: Option<String>,
) -> Result<Vec<ModItem>, String> {
    if folder_for(&kind).is_none() {
        return Err("tipo de conteúdo inválido".into());
    }
    let http = client();

    let mut groups: Vec<String> = vec![format!("[\"project_type:{kind}\"]")];
    if let Some(v) = game_version.as_deref().filter(|s| !s.is_empty()) {
        groups.push(format!("[\"versions:{v}\"]"));
    }
    let facets = format!("[{}]", groups.join(","));

    let payload: serde_json::Value = http
        .get(format!("{MODRINTH}/search"))
        .query(&[
            ("query", query.as_str()),
            ("facets", facets.as_str()),
            ("limit", "24"),
            ("index", "relevance"),
        ])
        .send()
        .await
        .map_err(|e| format!("falha ao buscar no Modrinth: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Modrinth respondeu erro: {e}"))?
        .json()
        .await
        .map_err(|e| format!("resposta inválida do Modrinth: {e}"))?;

    let hits = payload.get("hits").and_then(|h| h.as_array()).cloned().unwrap_or_default();
    let items = hits
        .iter()
        .filter_map(|h| {
            Some(ModItem {
                project_id: h.get("project_id")?.as_str()?.to_string(),
                slug: h.get("slug").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                title: h.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                description: h.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                author: h.get("author").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                downloads: h.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0),
                icon_url: h.get("icon_url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from),
                categories: h
                    .get("categories")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect())
                    .unwrap_or_default(),
            })
        })
        .collect();
    Ok(items)
}

/// Lista os arquivos já presentes na pasta de destino do tipo (o que está instalado).
#[tauri::command]
pub async fn content_installed(kind: String, dir: String) -> Result<Vec<String>, String> {
    let folder = folder_for(&kind).ok_or("tipo de conteúdo inválido")?;
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::fs::canonicalize(&dir).map_err(|_| "pasta do jogo inválida".to_string())?;
        let target = base.join(folder);
        if !target.is_dir() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&target).map_err(|e| e.to_string())? {
            if let Ok(e) = entry {
                if e.path().is_file() {
                    out.push(e.file_name().to_string_lossy().to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Instala um projeto: resolve a melhor versão compatível e baixa o arquivo para
/// a pasta de destino. Emite `content-progress` durante o download. Devolve o
/// nome do arquivo instalado.
#[tauri::command]
pub async fn modrinth_install(
    app: tauri::AppHandle,
    project_id: String,
    kind: String,
    game_version: Option<String>,
    dir: String,
) -> Result<String, String> {
    let folder = folder_for(&kind).ok_or("tipo de conteúdo inválido")?;
    let http = client();

    // versões compatíveis do projeto
    let mut params: Vec<(&str, String)> = vec![("loaders", json_array(loaders_for(&kind)))];
    if let Some(v) = game_version.as_deref().filter(|s| !s.is_empty()) {
        params.push(("game_versions", format!("[\"{v}\"]")));
    }
    let mut versions: Vec<serde_json::Value> = http
        .get(format!("{MODRINTH}/project/{project_id}/version"))
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("falha ao consultar versões: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Modrinth respondeu erro: {e}"))?
        .json()
        .await
        .map_err(|e| format!("resposta inválida do Modrinth: {e}"))?;

    // mais recente primeiro
    versions.sort_by(|a, b| {
        let da = a.get("date_published").and_then(|v| v.as_str()).unwrap_or("");
        let db = b.get("date_published").and_then(|v| v.as_str()).unwrap_or("");
        db.cmp(da)
    });

    // primeiro arquivo utilizável (preferindo o primário)
    let file = versions
        .iter()
        .find_map(|ver| {
            let files = ver.get("files")?.as_array()?;
            files
                .iter()
                .find(|f| f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
                .or_else(|| files.first())
        })
        .ok_or("nenhuma versão compatível com este servidor foi encontrada")?;

    let file_url = file.get("url").and_then(|v| v.as_str()).ok_or("arquivo sem URL")?;
    let raw_name = file.get("filename").and_then(|v| v.as_str()).ok_or("arquivo sem nome")?;
    let filename = raw_name.rsplit(['/', '\\']).next().unwrap_or(raw_name).to_string();
    if filename.is_empty() {
        return Err("nome de arquivo inválido".into());
    }
    let total = file.get("size").and_then(|v| v.as_u64()).unwrap_or(0);

    // destino
    let base = std::fs::canonicalize(&dir).map_err(|_| "pasta do jogo inválida".to_string())?;
    let target_dir = base.join(folder);
    tokio::fs::create_dir_all(&target_dir).await.map_err(|e| e.to_string())?;
    let dest: PathBuf = target_dir.join(&filename);
    let tmp = dest.with_extension("aether-part");

    // download com progresso
    let res = http
        .get(file_url)
        .send()
        .await
        .map_err(|e| format!("falha no download: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download respondeu erro: {e}"))?;
    let mut stream = res.bytes_stream();
    let mut file_out = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    use tokio::io::AsyncWriteExt;
    let mut done: u64 = 0;
    let _ = app.emit("content-progress", ContentProgress { name: filename.clone(), done: 0, total });
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file_out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        let _ = app.emit("content-progress", ContentProgress { name: filename.clone(), done, total });
    }
    file_out.flush().await.map_err(|e| e.to_string())?;
    drop(file_out);
    tokio::fs::rename(&tmp, &dest).await.map_err(|e| e.to_string())?;
    let _ = app.emit("content-progress", ContentProgress { name: filename.clone(), done: total.max(done), total: total.max(done) });

    Ok(filename)
}

/// Remove um arquivo instalado (move para a lixeira do launcher, recuperável).
#[tauri::command]
pub async fn content_remove(kind: String, filename: String, dir: String) -> Result<(), String> {
    let folder = folder_for(&kind).ok_or("tipo de conteúdo inválido")?;
    // reusa a lixeira do gerenciador de arquivos
    crate::files::fs_delete(dir, format!("{folder}/{filename}")).await
}
