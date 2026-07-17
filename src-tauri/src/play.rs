//! "Jogar": garante Java + vanilla + Forge + assets e inicia o jogo.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;

use crate::{app_data, client, fetch_manifest, java, minecraft, JAVA_MAJOR_DEFAULT};
use minecraft::{collect_libraries, download_to, fetch_json};

#[derive(Serialize, Clone)]
struct PlayProgress {
    stage: String,
    detail: String,
    done: usize,
    total: usize,
}

fn emit(app: &tauri::AppHandle, stage: &str, detail: &str, done: usize, total: usize) {
    let _ = app.emit(
        "play-progress",
        PlayProgress { stage: stage.into(), detail: detail.into(), done, total },
    );
}

async fn ensure_vanilla(
    app: &tauri::AppHandle,
    http: &reqwest::Client,
    game_dir: &Path,
    mc: &str,
) -> Result<serde_json::Value, String> {
    emit(app, "meta", &format!("Minecraft {mc}"), 0, 0);
    let vdir = game_dir.join("versions").join(mc);
    let vjson_path = vdir.join(format!("{mc}.json"));
    if !vjson_path.is_file() {
        let manifest = fetch_json(http, minecraft::VERSION_MANIFEST_URL)
            .await
            .map_err(|e| e.to_string())?;
        let entry = manifest["versions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["id"].as_str() == Some(mc))
            .cloned()
            .ok_or(format!("versão {mc} não existe no manifesto da Mojang"))?;
        let url = entry["url"].as_str().ok_or("manifesto sem url")?.to_string();
        let sha1 = entry["sha1"].as_str().map(String::from);
        download_to(http, &url, &vjson_path, sha1.as_deref())
            .await
            .map_err(|e| e.to_string())?;
    }
    let version: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&vjson_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;

    emit(app, "client", "client.jar", 0, 0);
    let client_jar = vdir.join(format!("{mc}.jar"));
    if let Some(url) = version.pointer("/downloads/client/url").and_then(|u| u.as_str()) {
        let sha1 = version.pointer("/downloads/client/sha1").and_then(|s| s.as_str());
        download_to(http, url, &client_jar, sha1).await.map_err(|e| e.to_string())?;
    }

    let libs = collect_libraries(&version);
    let total = libs.len();
    let mut done = 0usize;
    {
        let mut stream = futures_util::stream::iter(libs.into_iter().map(|lib| {
            let http = http.clone();
            let dest = game_dir.join("libraries").join(&lib.path);
            async move { download_to(&http, &lib.url, &dest, lib.sha1.as_deref()).await }
        }))
        .buffer_unordered(8);
        while let Some(result) = stream.next().await {
            result.map_err(|e| e.to_string())?;
            done += 1;
            if done % 10 == 0 || done == total {
                emit(app, "libraries", "bibliotecas", done, total);
            }
        }
    }

    let index_id = version
        .pointer("/assetIndex/id")
        .and_then(|i| i.as_str())
        .unwrap_or("legacy")
        .to_string();
    let index_path = game_dir.join("assets").join("indexes").join(format!("{index_id}.json"));
    if let Some(url) = version.pointer("/assetIndex/url").and_then(|u| u.as_str()) {
        let sha1 = version.pointer("/assetIndex/sha1").and_then(|s| s.as_str());
        download_to(http, url, &index_path, sha1).await.map_err(|e| e.to_string())?;
    }
    let index: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let objects: Vec<(String, u64)> = index["objects"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(_, o)| Some((o["hash"].as_str()?.to_string(), o["size"].as_u64().unwrap_or(0))))
        .collect();
    let total = objects.len();
    let mut done = 0usize;
    {
        let mut stream = futures_util::stream::iter(objects.into_iter().map(|(hash, size)| {
            let http = http.clone();
            let dest = game_dir.join("assets").join("objects").join(&hash[..2]).join(&hash);
            async move {
                if dest.is_file()
                    && tokio::fs::metadata(&dest).await.map(|m| m.len()).unwrap_or(0) == size
                {
                    return Ok(false);
                }
                let url = format!("{}/{}/{}", minecraft::RESOURCES_URL, &hash[..2], hash);
                download_to(&http, &url, &dest, Some(&hash)).await
            }
        }))
        .buffer_unordered(16);
        while let Some(result) = stream.next().await {
            result.map_err(|e| e.to_string())?;
            done += 1;
            if done % 100 == 0 || done == total {
                emit(app, "assets", "assets do jogo", done, total);
            }
        }
    }

    Ok(version)
}

async fn ensure_forge(
    app: &tauri::AppHandle,
    http: &reqwest::Client,
    game_dir: &Path,
    java_exe: &Path,
    mc: &str,
    forge: &str,
) -> Result<serde_json::Value, String> {
    let id = minecraft::forge_version_id(mc, forge);
    let vjson_path = game_dir.join("versions").join(&id).join(format!("{id}.json"));
    if !vjson_path.is_file() {
        emit(app, "forge", &format!("instalando Forge {forge} (pode demorar)"), 0, 0);
        let installer = game_dir
            .join(".aether-cache")
            .join(format!("forge-{mc}-{forge}-installer.jar"));
        download_to(http, &minecraft::forge_installer_url(mc, forge), &installer, None)
            .await
            .map_err(|e| e.to_string())?;
        let (java2, inst2, dir2) =
            (java_exe.to_path_buf(), installer.clone(), game_dir.to_path_buf());
        tauri::async_runtime::spawn_blocking(move || {
            minecraft::run_forge_installer(&java2, &inst2, &dir2)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        if !vjson_path.is_file() {
            return Err(format!("instalador do Forge não gerou {id}.json"));
        }
    }
    serde_json::from_str(&std::fs::read_to_string(&vjson_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn play(
    app: tauri::AppHandle,
    server: String,
    profile_id: String,
    dir: String,
    username: String,
    memory_mb: Option<u32>,
) -> Result<serde_json::Value, String> {
    let username = username.trim().to_string();
    if username.len() < 3
        || username.len() > 16
        || !username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("nome de jogador inválido (3–16 caracteres: letras, números ou _)".into());
    }
    let game_dir = PathBuf::from(&dir);
    let http = client();

    emit(&app, "java", "verificando Java", 0, 0);
    let data = app_data(&app)?;
    let java_info = match java::managed_java(&data, JAVA_MAJOR_DEFAULT) {
        Some(info) => info,
        None => {
            emit(&app, "java", "baixando Java 17", 0, 0);
            java::install(&data, JAVA_MAJOR_DEFAULT, |_, _| {})
                .await
                .map_err(|e| e.to_string())?
        }
    };
    let java_exe = PathBuf::from(&java_info.path);

    let (_, manifest_meta) = fetch_manifest(&http, &server, &profile_id).await?;
    let game = manifest_meta.game.clone().ok_or(
        "o servidor ainda não publicou a versão do jogo — peça ao admin para republicar o perfil",
    )?;
    let mc = game.minecraft.ok_or("manifesto sem versão do Minecraft")?;

    let vanilla = ensure_vanilla(&app, &http, &game_dir, &mc).await?;
    let (version, version_id) = match (game.loader.as_deref(), game.loader_version) {
        (Some("forge"), Some(forge)) => {
            let fjson = ensure_forge(&app, &http, &game_dir, &java_exe, &mc, &forge).await?;
            for lib in collect_libraries(&fjson) {
                let dest = game_dir.join("libraries").join(&lib.path);
                download_to(&http, &lib.url, &dest, lib.sha1.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let id = fjson["id"]
                .as_str()
                .unwrap_or(&minecraft::forge_version_id(&mc, &forge))
                .to_string();
            (minecraft::merge_versions(&vanilla, &fjson), id)
        }
        _ => (vanilla.clone(), mc.clone()),
    };

    emit(&app, "launch", "montando o jogo", 0, 0);
    let client_jar = game_dir.join("versions").join(&mc).join(format!("{mc}.jar"));
    let natives = game_dir.join("natives");
    std::fs::create_dir_all(&natives).map_err(|e| e.to_string())?;
    let cp = minecraft::classpath(&version, &game_dir, &client_jar);
    let assets_root = game_dir.join("assets");
    let index_id = version
        .pointer("/assetIndex/id")
        .and_then(|i| i.as_str())
        .unwrap_or("legacy");

    let vars: HashMap<&str, String> = HashMap::from([
        ("auth_player_name", username.clone()),
        ("version_name", version_id.clone()),
        ("game_directory", game_dir.to_string_lossy().into_owned()),
        ("assets_root", assets_root.to_string_lossy().into_owned()),
        ("assets_index_name", index_id.to_string()),
        ("auth_uuid", minecraft::offline_uuid(&username)),
        ("auth_access_token", "aether-offline".into()),
        ("clientid", "aether".into()),
        ("auth_xuid", "0".into()),
        ("user_type", "legacy".into()),
        ("version_type", "release".into()),
        ("natives_directory", natives.to_string_lossy().into_owned()),
        ("launcher_name", "aether-launcher".into()),
        ("launcher_version", env!("CARGO_PKG_VERSION").into()),
        ("classpath", cp.clone()),
        (
            "classpath_separator",
            if cfg!(windows) { ";".to_string() } else { ":".to_string() },
        ),
        (
            "library_directory",
            game_dir.join("libraries").to_string_lossy().into_owned(),
        ),
    ]);

    let mut args: Vec<String> = vec![format!("-Xmx{}M", memory_mb.unwrap_or(4096))];
    let jvm_args = minecraft::resolve_arguments(version.pointer("/arguments/jvm"), &vars);
    if jvm_args.is_empty() {
        args.push("-cp".into());
        args.push(cp);
    } else {
        args.extend(jvm_args);
    }
    args.push(version["mainClass"].as_str().ok_or("version json sem mainClass")?.to_string());
    args.extend(minecraft::resolve_arguments(version.pointer("/arguments/game"), &vars));

    let javaw = java_exe.with_file_name(if cfg!(windows) { "javaw.exe" } else { "java" });
    let launch_exe = if javaw.is_file() { javaw } else { java_exe };
    let child = std::process::Command::new(&launch_exe)
        .args(&args)
        .current_dir(&game_dir)
        .spawn()
        .map_err(|e| format!("falha ao iniciar o jogo: {e}"))?;

    emit(&app, "running", "jogo iniciado", 1, 1);
    Ok(serde_json::json!({ "version": version_id, "pid": child.id() }))
}
