pub mod java;
pub mod sync;

use tauri::Manager;

use std::path::PathBuf;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;

use sync::{build_plan, retire_files, sha256_file, verify_and_parse, Manifest, SyncError};

#[derive(Serialize, Clone)]
struct ServerInfo {
    instance_name: String,
    profile_name: String,
    channel: String,
    files: usize,
    total_size: u64,
    state: String,
}

#[derive(Serialize, Clone)]
struct PlanSummary {
    download: Vec<String>,
    download_size: u64,
    retire: Vec<String>,
    keep: usize,
    synced: bool,
}

#[derive(Serialize, Clone)]
struct Progress {
    stage: String,
    path: String,
    done: usize,
    total: usize,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("aether-launcher/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client")
}

async fn fetch_manifest(
    http: &reqwest::Client,
    server: &str,
    profile_id: &str,
) -> Result<(serde_json::Value, Manifest), String> {
    let url = format!("{}/api/v1/public/sync/{}", server.trim_end_matches('/'), profile_id);
    let payload: serde_json::Value = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("falha ao conectar: {e}"))?
        .error_for_status()
        .map_err(|e| format!("servidor respondeu erro: {e}"))?
        .json()
        .await
        .map_err(|e| format!("resposta inválida: {e}"))?;

    let manifest_value = payload
        .get("manifest")
        .cloned()
        .ok_or("resposta sem manifesto")?;
    let signature = payload.get("signature").and_then(|v| v.as_str()).unwrap_or("");
    let public_key = payload.get("public_key").and_then(|v| v.as_str()).unwrap_or("");
    let manifest = verify_and_parse(&manifest_value, signature, public_key)
        .map_err(|e| e.to_string())?;
    Ok((manifest_value, manifest))
}

#[tauri::command]
async fn server_info(server: String, profile_id: String) -> Result<ServerInfo, String> {
    let http = client();
    let (_, manifest) = fetch_manifest(&http, &server, &profile_id).await?;

    let status_url = format!(
        "{}/api/v1/public/instances/{}/status",
        server.trim_end_matches('/'),
        manifest.instance.id
    );
    let state = match http.get(&status_url).send().await {
        Ok(res) => res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("state").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or_else(|| "unknown".into()),
        Err(_) => "unknown".into(),
    };

    Ok(ServerInfo {
        instance_name: manifest.instance.name,
        profile_name: manifest.profile.name,
        channel: manifest.profile.channel,
        files: manifest.files.len(),
        total_size: manifest.total_size,
        state,
    })
}

fn summarize(plan: &sync::Plan) -> PlanSummary {
    PlanSummary {
        download: plan.download.iter().map(|f| f.path.clone()).collect(),
        download_size: plan.download_size(),
        retire: plan.retire.clone(),
        keep: plan.keep,
        synced: plan.is_synced(),
    }
}

#[tauri::command]
async fn check_sync(
    server: String,
    profile_id: String,
    dir: String,
    include_optional: bool,
) -> Result<PlanSummary, String> {
    let http = client();
    let (_, manifest) = fetch_manifest(&http, &server, &profile_id).await?;
    let target = PathBuf::from(dir);
    let plan = tauri::async_runtime::spawn_blocking(move || {
        build_plan(&manifest, &target, include_optional)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(summarize(&plan))
}

async fn download_one(
    http: &reqwest::Client,
    server: &str,
    profile_id: &str,
    entry: &sync::ManifestFile,
    target: &std::path::Path,
) -> Result<(), String> {
    let url = format!(
        "{}/api/v1/public/sync/{}/file",
        server.trim_end_matches('/'),
        profile_id
    );
    let dest = target.join(&entry.path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("aether-part");

    for attempt in 1..=3u32 {
        let result: Result<(), String> = async {
            let res = http
                .get(&url)
                .query(&[("path", entry.path.as_str())])
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let mut stream = res.bytes_stream();
            let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            file.flush().await.map_err(|e| e.to_string())?;
            drop(file);

            let tmp2 = tmp.clone();
            let hash = tauri::async_runtime::spawn_blocking(move || sha256_file(&tmp2))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            if hash != entry.sha256 {
                return Err(SyncError::HashMismatch(entry.path.clone()).to_string());
            }
            tokio::fs::rename(&tmp, &dest).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;

        match result {
            Ok(()) => return Ok(()),
            Err(e) if attempt == 3 => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(format!("{}: {e}", entry.path));
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                tokio::time::sleep(std::time::Duration::from_secs(attempt as u64)).await;
            }
        }
    }
    unreachable!()
}

#[tauri::command]
async fn run_sync(
    app: tauri::AppHandle,
    server: String,
    profile_id: String,
    dir: String,
    include_optional: bool,
) -> Result<PlanSummary, String> {
    let http = client();
    let (_, manifest) = fetch_manifest(&http, &server, &profile_id).await?;
    let target = PathBuf::from(&dir);

    let manifest_clone = manifest.clone();
    let target_clone = target.clone();
    let plan = tauri::async_runtime::spawn_blocking(move || {
        build_plan(&manifest_clone, &target_clone, include_optional)
    })
    .await
    .map_err(|e| e.to_string())?;

    let total = plan.download.len();
    let mut done = 0usize;
    {
        let downloads = plan.download.clone();
        let mut stream = futures_util::stream::iter(downloads.into_iter().map(|entry| {
            let http = http.clone();
            let server = server.clone();
            let profile_id = profile_id.clone();
            let target = target.clone();
            async move {
                download_one(&http, &server, &profile_id, &entry, &target)
                    .await
                    .map(|_| entry.path)
            }
        }))
        .buffer_unordered(4);

        while let Some(result) = stream.next().await {
            let path = result?;
            done += 1;
            let _ = app.emit(
                "sync-progress",
                Progress { stage: "download".into(), path, done, total },
            );
        }
    }

    let retired = {
        let target = target.clone();
        let rels = plan.retire.clone();
        tauri::async_runtime::spawn_blocking(move || retire_files(&target, &rels))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
    };
    for path in &retired {
        let _ = app.emit(
            "sync-progress",
            Progress { stage: "retire".into(), path: path.clone(), done, total },
        );
    }

    let _ = app.emit(
        "sync-progress",
        Progress { stage: "done".into(), path: String::new(), done, total },
    );
    Ok(summarize(&plan))
}

fn app_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

const JAVA_MAJOR_DEFAULT: u8 = 17; // Minecraft 1.20.x

#[tauri::command]
async fn java_status(app: tauri::AppHandle) -> Result<Option<java::JavaInfo>, String> {
    let data = app_data(&app)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        java::managed_java(&data, JAVA_MAJOR_DEFAULT)
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn install_java(app: tauri::AppHandle) -> Result<java::JavaInfo, String> {
    let data = app_data(&app)?;
    let emitter = app.clone();
    let info = java::install(&data, JAVA_MAJOR_DEFAULT, move |done, total| {
        let _ = emitter.emit(
            "java-progress",
            serde_json::json!({ "done": done, "total": total }),
        );
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit("java-progress", serde_json::json!({ "done": 1, "total": 1 }));
    Ok(info)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            server_info,
            check_sync,
            run_sync,
            java_status,
            install_java
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
