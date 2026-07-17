//! Managed Java runtimes (Eclipse Temurin via the Adoptium API).
//!
//! The launcher keeps its own JRE per major version under the app data
//! directory — players never need to install Java themselves.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum JavaError {
    #[error("erro de rede: {0}")]
    Network(String),
    #[error("a API do Adoptium não retornou um binário para esta plataforma")]
    NoBinary,
    #[error("falha ao extrair o Java: {0}")]
    Extract(String),
    #[error("java.exe não encontrado após a extração")]
    ExeMissing,
    #[error("erro de E/S: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Serialize, Clone, Debug)]
pub struct JavaInfo {
    pub path: String,
    pub version: String,
}

pub fn runtime_dir(data_dir: &Path, major: u8) -> PathBuf {
    data_dir.join("runtimes").join(format!("java{major}"))
}

/// Finds `bin/java.exe` anywhere under the runtime dir (the Temurin zip
/// wraps everything in a `jdk-...` top folder).
pub fn find_java_exe(runtime: &Path) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "java.exe" } else { "java" };
    let direct = runtime.join("bin").join(exe_name);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(runtime).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join("bin").join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Runs `java -version` (window-less on Windows) and returns the banner line.
pub fn probe_version(exe: &Path) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    let banner = String::from_utf8_lossy(&output.stderr);
    banner.lines().next().map(|l| l.trim().to_string())
}

pub fn managed_java(data_dir: &Path, major: u8) -> Option<JavaInfo> {
    let exe = find_java_exe(&runtime_dir(data_dir, major))?;
    let version = probe_version(&exe)?;
    Some(JavaInfo { path: exe.to_string_lossy().into_owned(), version })
}

pub fn adoptium_url(major: u8) -> String {
    let os = if cfg!(windows) { "windows" } else { "linux" };
    format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?architecture=x64&image_type=jre&os={os}&vendor=eclipse"
    )
}

pub fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), JavaError> {
    let file = std::fs::File::open(archive_path)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| JavaError::Extract(e.to_string()))?;
    std::fs::create_dir_all(dest)?;
    zip.extract(dest).map_err(|e| JavaError::Extract(e.to_string()))?;
    Ok(())
}

/// Downloads (with progress callback) and installs the Temurin JRE.
pub async fn install(
    data_dir: &Path,
    major: u8,
    mut progress: impl FnMut(u64, u64),
) -> Result<JavaInfo, JavaError> {
    let http = reqwest::Client::builder()
        .user_agent(concat!("aether-launcher/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client");

    let assets: serde_json::Value = http
        .get(adoptium_url(major))
        .send()
        .await
        .map_err(|e| JavaError::Network(e.to_string()))?
        .error_for_status()
        .map_err(|e| JavaError::Network(e.to_string()))?
        .json()
        .await
        .map_err(|e| JavaError::Network(e.to_string()))?;

    let link = assets
        .as_array()
        .and_then(|a| a.first())
        .and_then(|b| b.pointer("/binary/package/link"))
        .and_then(|l| l.as_str())
        .ok_or(JavaError::NoBinary)?
        .to_string();

    let runtime = runtime_dir(data_dir, major);
    std::fs::create_dir_all(&runtime)?;
    let archive = runtime.join("download.zip");

    let res = http
        .get(&link)
        .send()
        .await
        .map_err(|e| JavaError::Network(e.to_string()))?
        .error_for_status()
        .map_err(|e| JavaError::Network(e.to_string()))?;
    let total = res.content_length().unwrap_or(0);

    {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut stream = res.bytes_stream();
        let mut file = tokio::fs::File::create(&archive).await?;
        let mut downloaded = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| JavaError::Network(e.to_string()))?;
            file.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            progress(downloaded, total);
        }
        file.flush().await?;
    }

    let archive2 = archive.clone();
    let runtime2 = runtime.clone();
    tokio::task::spawn_blocking(move || extract_zip(&archive2, &runtime2))
        .await
        .map_err(|e| JavaError::Extract(e.to_string()))??;
    std::fs::remove_file(&archive).ok();

    let exe = find_java_exe(&runtime).ok_or(JavaError::ExeMissing)?;
    let version = probe_version(&exe).ok_or(JavaError::ExeMissing)?;
    Ok(JavaInfo { path: exe.to_string_lossy().into_owned(), version })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_dir_layout() {
        let dir = runtime_dir(Path::new("C:/data"), 17);
        assert!(dir.to_string_lossy().replace('\\', "/").ends_with("runtimes/java17"));
    }

    #[test]
    fn adoptium_url_shape() {
        let url = adoptium_url(17);
        assert!(url.contains("/assets/latest/17/hotspot"));
        assert!(url.contains("image_type=jre"));
    }
}
