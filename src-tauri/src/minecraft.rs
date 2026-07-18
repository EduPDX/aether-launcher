//! Minecraft installation and launch pipeline.
//!
//! Vanilla: Mojang version manifest → version JSON → client jar,
//! libraries (rule-filtered) and assets. Forge: official installer run in
//! `--installClient` mode, then the forge version JSON (inheritsFrom) is
//! merged over vanilla. Finally the JVM/game argument templates are
//! resolved and the game is spawned.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use md5::Md5;
use serde_json::Value;
use sha1::{Digest, Sha1};

pub const VERSION_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const RESOURCES_URL: &str = "https://resources.download.minecraft.net";

#[derive(Debug, thiserror::Error)]
pub enum McError {
    #[error("erro de rede: {0}")]
    Network(String),
    #[error("versão do Minecraft não encontrada: {0}")]
    VersionNotFound(String),
    #[error("instalador do Forge falhou: {0}")]
    ForgeInstall(String),
    #[error("resposta malformada: {0}")]
    BadData(String),
    #[error("erro de E/S: {0}")]
    Io(#[from] std::io::Error),
}

// ------------------------------------------------------------------ rules --

/// Mojang rule evaluation for this platform (Windows x64, no features).
pub fn rules_allow(rules: Option<&Value>) -> bool {
    let Some(rules) = rules.and_then(|r| r.as_array()) else {
        return true;
    };
    let mut allowed = false;
    for rule in rules {
        let action_allow = rule.get("action").and_then(|a| a.as_str()) == Some("allow");
        // Regras com "features" dependem de recursos que não declaramos.
        if rule.get("features").is_some() {
            if action_allow {
                continue; // allow condicionado a feature ausente → não permite
            }
            continue;
        }
        let os_matches = match rule.get("os") {
            None => true,
            Some(os) => {
                let name_ok = os
                    .get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n == current_os_name())
                    .unwrap_or(true);
                let arch_ok = os
                    .get("arch")
                    .and_then(|a| a.as_str())
                    .map(|a| a == "x86_64" || a == "amd64")
                    .unwrap_or(true);
                name_ok && arch_ok
            }
        };
        if os_matches {
            allowed = action_allow;
        }
    }
    allowed
}

fn current_os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

// ------------------------------------------------------------------ merge --

/// Merges a child version JSON (e.g. Forge) over its `inheritsFrom` parent.
pub fn merge_versions(parent: &Value, child: &Value) -> Value {
    let mut merged = parent.clone();
    let obj = merged.as_object_mut().expect("version json is an object");

    for (key, value) in child.as_object().into_iter().flatten() {
        match key.as_str() {
            "libraries" => {
                let mut libs = value.as_array().cloned().unwrap_or_default();
                libs.extend(parent.get("libraries").and_then(|l| l.as_array()).cloned().unwrap_or_default());
                obj.insert("libraries".into(), Value::Array(libs));
            }
            "arguments" => {
                let mut args = parent.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({}));
                for kind in ["game", "jvm"] {
                    let parent_list = args.get(kind).and_then(|a| a.as_array()).cloned().unwrap_or_default();
                    let child_list = value.get(kind).and_then(|a| a.as_array()).cloned().unwrap_or_default();
                    let mut combined = parent_list;
                    combined.extend(child_list);
                    args[kind] = Value::Array(combined);
                }
                obj.insert("arguments".into(), args);
            }
            "inheritsFrom" => {}
            _ => {
                obj.insert(key.clone(), value.clone());
            }
        }
    }
    merged
}

// -------------------------------------------------------------- libraries --

#[derive(Debug, Clone)]
pub struct LibArtifact {
    pub path: String,
    pub url: String,
    pub sha1: Option<String>,
}

/// Maven coordinate without the version — used to dedupe (child wins).
/// Dedup key: group/artifact **plus the classifier**. The classifier is
/// essential — `lwjgl-3.3.1.jar` and `lwjgl-3.3.1-natives-windows.jar`
/// share a group/artifact but are different artifacts; collapsing them
/// silently drops the natives jars and the game dies with
/// `UnsatisfiedLinkError: lwjgl.dll`.
fn lib_key(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 3 {
        return path.to_string();
    }
    let file = parts[parts.len() - 1];
    let version = parts[parts.len() - 2];
    let artifact = parts[parts.len() - 3];
    let group_artifact = parts[..parts.len() - 2].join("/");

    let stem = file.strip_suffix(".jar").unwrap_or(file);
    let classifier = stem
        .strip_prefix(&format!("{artifact}-{version}"))
        .unwrap_or("")
        .trim_start_matches('-');
    format!("{group_artifact}|{classifier}")
}

pub fn collect_libraries(version: &Value) -> Vec<LibArtifact> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for lib in version.get("libraries").and_then(|l| l.as_array()).into_iter().flatten() {
        if !rules_allow(lib.get("rules")) {
            continue;
        }
        let Some(artifact) = lib.pointer("/downloads/artifact") else {
            continue;
        };
        let (Some(path), Some(url)) = (
            artifact.get("path").and_then(|p| p.as_str()),
            artifact.get("url").and_then(|u| u.as_str()),
        ) else {
            continue;
        };
        if url.is_empty() {
            continue; // artefatos gerados localmente pelo instalador do Forge
        }
        if !seen.insert(lib_key(path)) {
            continue;
        }
        out.push(LibArtifact {
            path: path.to_string(),
            url: url.to_string(),
            sha1: artifact.get("sha1").and_then(|s| s.as_str()).map(String::from),
        });
    }
    out
}

/// Full classpath: every allowed library (even url-less Forge-generated
/// ones, resolved on disk) plus the client jar.
pub fn classpath(version: &Value, game_dir: &Path, client_jar: &Path) -> String {
    let mut seen: HashSet<String> = HashSet::new();
    let mut entries: Vec<String> = Vec::new();
    for lib in version.get("libraries").and_then(|l| l.as_array()).into_iter().flatten() {
        if !rules_allow(lib.get("rules")) {
            continue;
        }
        let Some(path) = lib.pointer("/downloads/artifact/path").and_then(|p| p.as_str()) else {
            continue;
        };
        if !seen.insert(lib_key(path)) {
            continue;
        }
        entries.push(game_dir.join("libraries").join(path).to_string_lossy().into_owned());
    }
    entries.push(client_jar.to_string_lossy().into_owned());
    entries.join(sep())
}

fn sep() -> &'static str {
    if cfg!(windows) { ";" } else { ":" }
}

// -------------------------------------------------------------- arguments --

pub fn resolve_arguments(list: Option<&Value>, vars: &HashMap<&str, String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in list.and_then(|l| l.as_array()).into_iter().flatten() {
        match item {
            Value::String(s) => out.push(substitute(s, vars)),
            Value::Object(rule_arg) => {
                if rules_allow(rule_arg.get("rules")) {
                    match rule_arg.get("value") {
                        Some(Value::String(s)) => out.push(substitute(s, vars)),
                        Some(Value::Array(items)) => {
                            for s in items.iter().filter_map(|v| v.as_str()) {
                                out.push(substitute(s, vars));
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn substitute(template: &str, vars: &HashMap<&str, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in vars {
        result = result.replace(&format!("${{{key}}}"), value);
    }
    result
}

/// Offline-mode UUID exactly like vanilla: UUIDv3 of "OfflinePlayer:<name>".
pub fn offline_uuid(username: &str) -> String {
    let digest = Md5::digest(format!("OfflinePlayer:{username}").as_bytes());
    let mut bytes: [u8; 16] = digest.into();
    bytes[6] = (bytes[6] & 0x0f) | 0x30; // versão 3
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
    let h = hex::encode(bytes);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

// -------------------------------------------------------------- downloads --

pub fn sha1_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 1024 * 256];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub async fn fetch_json(http: &reqwest::Client, url: &str) -> Result<Value, McError> {
    http.get(url)
        .send()
        .await
        .map_err(|e| McError::Network(e.to_string()))?
        .error_for_status()
        .map_err(|e| McError::Network(e.to_string()))?
        .json()
        .await
        .map_err(|e| McError::Network(e.to_string()))
}

pub async fn download_to(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha1: Option<&str>,
) -> Result<bool, McError> {
    if dest.is_file() {
        if let Some(expected) = sha1 {
            let d = dest.to_path_buf();
            let ok = tokio::task::spawn_blocking(move || sha1_file(&d))
                .await
                .map_err(|e| McError::BadData(e.to_string()))?
                .map(|h| h == expected)
                .unwrap_or(false);
            if ok {
                return Ok(false);
            }
        } else {
            return Ok(false);
        }
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = http
        .get(url)
        .send()
        .await
        .map_err(|e| McError::Network(e.to_string()))?
        .error_for_status()
        .map_err(|e| McError::Network(format!("{url}: {e}")))?
        .bytes()
        .await
        .map_err(|e| McError::Network(e.to_string()))?;
    if let Some(expected) = sha1 {
        let actual = hex::encode(Sha1::digest(&bytes));
        if actual != expected {
            return Err(McError::BadData(format!("sha1 divergente em {url}")));
        }
    }
    tokio::fs::write(dest, &bytes).await?;
    Ok(true)
}

/// Client jar to put on the classpath.
///
/// Forge's `-DignoreList` ends with `${version_name}.jar`, so when a mod
/// loader is used the jar **must be named after the launched version id**
/// (`1.20.1-forge-47.4.0.jar`). With the plain `1.20.1.jar` the JVM derives
/// an automatic module (`_1._20._1`) that clashes with Forge's own
/// `minecraft` module:
/// `ResolutionException: Module minecraft contains package
/// net.minecraft.obfuscate`. The vanilla launcher names the jar after the
/// version id for exactly this reason.
pub fn ensure_client_jar(
    game_dir: &Path,
    mc: &str,
    version_id: &str,
) -> std::io::Result<PathBuf> {
    let vanilla = game_dir.join("versions").join(mc).join(format!("{mc}.jar"));
    if version_id == mc {
        return Ok(vanilla);
    }
    let dir = game_dir.join("versions").join(version_id);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(format!("{version_id}.jar"));
    if !dest.is_file() {
        std::fs::copy(&vanilla, &dest)?;
    }
    Ok(dest)
}

// ---------------------------------------------------------------- natives --

/// Extracts OS-specific native libraries (LWJGL `.dll`/`.so`/`.dylib`) from
/// the `natives-*` jars into `natives_dir`, like the vanilla launcher does.
/// Forge's module classloader can't extract these from the classpath, so
/// the game needs them present on `java.library.path`.
pub fn extract_natives(
    version: &Value,
    libraries_dir: &Path,
    natives_dir: &Path,
) -> Result<usize, McError> {
    std::fs::create_dir_all(natives_dir)?;
    let (os_tag, ext) = if cfg!(target_os = "windows") {
        ("natives-windows", ".dll")
    } else if cfg!(target_os = "macos") {
        ("natives-macos", ".dylib")
    } else {
        ("natives-linux", ".so")
    };
    let mut count = 0;
    for lib in version.get("libraries").and_then(|l| l.as_array()).into_iter().flatten() {
        if !rules_allow(lib.get("rules")) {
            continue;
        }
        let Some(path) = lib.pointer("/downloads/artifact/path").and_then(|p| p.as_str()) else {
            continue;
        };
        if !path.contains(os_tag) {
            continue;
        }
        let jar_path = libraries_dir.join(path);
        if !jar_path.is_file() {
            continue;
        }
        let file = std::fs::File::open(&jar_path)?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| McError::BadData(e.to_string()))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| McError::BadData(e.to_string()))?;
            let name = entry.name().to_string();
            if entry.is_dir() || name.starts_with("META-INF") || !name.ends_with(ext) {
                continue;
            }
            let Some(file_name) = Path::new(&name).file_name() else {
                continue;
            };
            let mut outfile = std::fs::File::create(natives_dir.join(file_name))?;
            std::io::copy(&mut entry, &mut outfile)?;
            count += 1;
        }
    }
    Ok(count)
}

// ------------------------------------------------------------------ forge --

pub fn forge_version_id(mc: &str, forge: &str) -> String {
    format!("{mc}-forge-{forge}")
}

pub fn forge_installer_url(mc: &str, forge: &str) -> String {
    format!(
        "https://maven.minecraftforge.net/net/minecraftforge/forge/{mc}-{forge}/forge-{mc}-{forge}-installer.jar"
    )
}

/// Runs the official Forge installer (`--installClient`). Blocking.
pub fn run_forge_installer(
    java_exe: &Path,
    installer: &Path,
    game_dir: &Path,
) -> Result<(), McError> {
    let profiles = game_dir.join("launcher_profiles.json");
    if !profiles.is_file() {
        std::fs::write(&profiles, b"{\"profiles\":{}}")?;
    }
    let mut cmd = std::process::Command::new(java_exe);
    cmd.arg("-jar")
        .arg(installer)
        .arg("--installClient")
        .arg(game_dir)
        .current_dir(game_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output()?;
    if !output.status.success() {
        let tail: String = String::from_utf8_lossy(&output.stdout)
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(McError::ForgeInstall(tail));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_windows_allowed() {
        let rules: Value = serde_json::json!([
            {"action": "allow"},
            {"action": "disallow", "os": {"name": "osx"}}
        ]);
        assert!(rules_allow(Some(&rules)));

        let only_linux: Value = serde_json::json!([{"action": "allow", "os": {"name": "linux"}}]);
        assert_eq!(rules_allow(Some(&only_linux)), !cfg!(windows));

        let feature_gated: Value =
            serde_json::json!([{"action": "allow", "features": {"is_demo_user": true}}]);
        assert!(!rules_allow(Some(&feature_gated)));

        assert!(rules_allow(None));
    }

    #[test]
    fn merge_forge_over_vanilla() {
        let vanilla = serde_json::json!({
            "id": "1.20.1",
            "mainClass": "net.minecraft.client.main.Main",
            "assetIndex": {"id": "5"},
            "libraries": [{"name": "vanilla:lib:1"}],
            "arguments": {"game": ["--username", "${auth_player_name}"], "jvm": ["-Xss1M"]}
        });
        let forge = serde_json::json!({
            "id": "1.20.1-forge-47.2.0",
            "inheritsFrom": "1.20.1",
            "mainClass": "cpw.mods.bootstraplauncher.BootstrapLauncher",
            "libraries": [{"name": "forge:lib:1"}],
            "arguments": {"game": ["--fml.forgeVersion", "47.2.0"], "jvm": ["-Dforge=1"]}
        });
        let merged = merge_versions(&vanilla, &forge);
        assert_eq!(merged["mainClass"], "cpw.mods.bootstraplauncher.BootstrapLauncher");
        assert_eq!(merged["assetIndex"]["id"], "5");
        let libs = merged["libraries"].as_array().unwrap();
        assert_eq!(libs[0]["name"], "forge:lib:1"); // forge primeiro
        assert_eq!(libs.len(), 2);
        let game_args = merged["arguments"]["game"].as_array().unwrap();
        assert_eq!(game_args.first().unwrap(), "--username");
        assert_eq!(game_args.last().unwrap(), "47.2.0");
    }

    #[test]
    fn client_jar_is_renamed_for_mod_loaders() {
        // Regressão: com Forge, o jar precisa casar com ${version_name}.jar do
        // ignoreList, senão vira módulo automático e dá ResolutionException.
        let tmp = std::env::temp_dir().join(format!("aether-cj-{}", std::process::id()));
        let vdir = tmp.join("versions").join("1.20.1");
        std::fs::create_dir_all(&vdir).unwrap();
        std::fs::write(vdir.join("1.20.1.jar"), b"fake-client").unwrap();

        // vanilla: usa o jar original
        let vanilla = ensure_client_jar(&tmp, "1.20.1", "1.20.1").unwrap();
        assert!(vanilla.ends_with("1.20.1.jar"));

        // forge: cria uma cópia com o nome da versão lançada
        let forge = ensure_client_jar(&tmp, "1.20.1", "1.20.1-forge-47.4.0").unwrap();
        assert!(forge.ends_with("1.20.1-forge-47.4.0.jar"));
        assert!(forge.is_file());
        assert_eq!(std::fs::read(&forge).unwrap(), b"fake-client");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn natives_jar_is_not_deduped_against_its_base_jar() {
        // Regressão: a chave sem classificador descartava o jar de natives,
        // e o jogo morria com "Failed to locate library: lwjgl.dll".
        let version = serde_json::json!({"libraries": [
            {"downloads": {"artifact": {
                "path": "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar", "url": "https://x/a"}}},
            {"downloads": {"artifact": {
                "path": "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar",
                "url": "https://x/b"}}}
        ]});
        let libs = collect_libraries(&version);
        assert_eq!(libs.len(), 2, "o jar de natives deve ser mantido");
        assert!(libs.iter().any(|l| l.path.contains("natives-windows")));

        let cp = classpath(&version, Path::new("/g"), Path::new("/g/client.jar"));
        assert!(cp.contains("natives-windows"), "natives também vão para o classpath");
    }

    #[test]
    fn dedupe_keeps_child_version() {
        let version = serde_json::json!({"libraries": [
            {"downloads": {"artifact": {"path": "org/ow2/asm/asm/9.7/asm-9.7.jar", "url": "https://x/a"}}},
            {"downloads": {"artifact": {"path": "org/ow2/asm/asm/9.3/asm-9.3.jar", "url": "https://x/b"}}}
        ]});
        let libs = collect_libraries(&version);
        assert_eq!(libs.len(), 1);
        assert!(libs[0].path.contains("9.7"));
    }

    #[test]
    fn offline_uuid_is_stable_v3() {
        let a = offline_uuid("EduPDX");
        assert_eq!(a, offline_uuid("EduPDX"));
        assert_ne!(a, offline_uuid("Outro"));
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "3"); // versão 3
    }

    #[test]
    fn argument_substitution_and_rule_args() {
        let vars: HashMap<&str, String> =
            HashMap::from([("auth_player_name", "Edu".to_string())]);
        let list = serde_json::json!([
            "--username", "${auth_player_name}",
            {"rules": [{"action": "allow", "features": {"has_custom_resolution": true}}],
             "value": ["--width", "${resolution_width}"]}
        ]);
        let args = resolve_arguments(Some(&list), &vars);
        assert_eq!(args, vec!["--username", "Edu"]);
    }
}
