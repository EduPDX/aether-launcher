//! Aether sync protocol v1 — Rust implementation.
//!
//! Mirrors the reference client (`apps/cli`, Python): fetch the signed
//! manifest, verify the Ed25519 signature over the *canonical* JSON bytes
//! (sorted keys, compact separators, UTF-8 — exactly what the Core signs),
//! diff a local directory by SHA-256 and apply the plan.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SUPPORTED_MANIFEST_VERSION: u64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("versão de manifesto não suportada: {0}")]
    UnsupportedVersion(u64),
    #[error("assinatura do manifesto inválida")]
    BadSignature,
    #[error("resposta malformada do servidor: {0}")]
    BadPayload(String),
    #[error("hash divergente após download: {0}")]
    HashMismatch(String),
    #[error("erro de rede: {0}")]
    Network(String),
    #[error("erro de E/S: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub action: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManagedDir {
    pub dir: String,
    pub patterns: Vec<String>,
    #[serde(default = "default_true")]
    pub recursive: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub channel: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GameMeta {
    pub minecraft: Option<String>,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Manifest {
    pub instance: ManifestMeta,
    pub profile: ManifestMeta,
    pub files: Vec<ManifestFile>,
    pub managed: Vec<ManagedDir>,
    pub total_size: u64,
    pub game: Option<GameMeta>,
}

/// Canonical bytes: serde_json's default map is a BTreeMap, so keys come
/// out sorted; `to_vec` is compact and UTF-8 — byte-identical to Python's
/// `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
pub fn canonical_bytes(manifest: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(manifest).expect("manifest is valid JSON")
}

pub fn verify_and_parse(
    manifest_value: &serde_json::Value,
    signature_hex: &str,
    public_key_hex: &str,
) -> Result<Manifest, SyncError> {
    let version = manifest_value
        .get("version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if version != SUPPORTED_MANIFEST_VERSION {
        return Err(SyncError::UnsupportedVersion(version));
    }

    let key_bytes: [u8; 32] = hex::decode(public_key_hex)
        .map_err(|_| SyncError::BadSignature)?
        .try_into()
        .map_err(|_| SyncError::BadSignature)?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| SyncError::BadSignature)?;
    let sig_bytes: [u8; 64] = hex::decode(signature_hex)
        .map_err(|_| SyncError::BadSignature)?
        .try_into()
        .map_err(|_| SyncError::BadSignature)?;
    key.verify(&canonical_bytes(manifest_value), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| SyncError::BadSignature)?;

    let parse = |field: &str| -> Result<serde_json::Value, SyncError> {
        manifest_value
            .get(field)
            .cloned()
            .ok_or_else(|| SyncError::BadPayload(format!("campo ausente: {field}")))
    };
    Ok(Manifest {
        instance: serde_json::from_value(parse("instance")?)
            .map_err(|e| SyncError::BadPayload(e.to_string()))?,
        profile: serde_json::from_value(parse("profile")?)
            .map_err(|e| SyncError::BadPayload(e.to_string()))?,
        files: serde_json::from_value(parse("files")?)
            .map_err(|e| SyncError::BadPayload(e.to_string()))?,
        managed: serde_json::from_value(parse("managed")?)
            .map_err(|e| SyncError::BadPayload(e.to_string()))?,
        total_size: manifest_value
            .get("total_size")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        game: manifest_value
            .get("game")
            .and_then(|g| serde_json::from_value(g.clone()).ok()),
    })
}

/// Case-insensitive wildcard match supporting `*` and `?` (fnmatch subset).
pub fn wildcard_match(name: &str, pattern: &str) -> bool {
    fn matches(n: &[u8], p: &[u8]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some(b'*'), _) => {
                matches(n, &p[1..]) || (!n.is_empty() && matches(&n[1..], p))
            }
            (Some(b'?'), Some(_)) => matches(&n[1..], &p[1..]),
            (Some(pc), Some(nc)) if pc == nc => matches(&n[1..], &p[1..]),
            _ => false,
        }
    }
    matches(name.to_lowercase().as_bytes(), pattern.to_lowercase().as_bytes())
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
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

#[derive(Debug, Default, Serialize)]
pub struct Plan {
    pub download: Vec<ManifestFile>,
    pub retire: Vec<String>,
    pub keep: usize,
}

impl Plan {
    pub fn download_size(&self) -> u64 {
        self.download.iter().map(|f| f.size).sum()
    }
    pub fn is_synced(&self) -> bool {
        self.download.is_empty() && self.retire.is_empty()
    }
}

fn walk_files(base: &Path, recursive: bool, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(base)? {
        let path = entry?.path();
        if path.is_dir() {
            if recursive {
                walk_files(&path, true, out)?;
            }
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

pub fn build_plan(manifest: &Manifest, target: &Path, include_optional: bool) -> Plan {
    let mut plan = Plan::default();

    for entry in &manifest.files {
        if entry.action == "optional" && !include_optional {
            continue;
        }
        let local = target.join(&entry.path);
        let ok = local.is_file()
            && local.metadata().map(|m| m.len()).unwrap_or(0) == entry.size
            && sha256_file(&local).map(|h| h == entry.sha256).unwrap_or(false);
        if ok {
            plan.keep += 1;
        } else {
            plan.download.push(entry.clone());
        }
    }

    let manifest_paths: HashSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    for managed in &manifest.managed {
        let base = target.join(&managed.dir);
        if !base.is_dir() {
            continue;
        }
        let mut found = Vec::new();
        if walk_files(&base, managed.recursive, &mut found).is_err() {
            continue;
        }
        for path in found {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !managed.patterns.iter().any(|p| wildcard_match(name, p)) {
                continue;
            }
            let rel = path
                .strip_prefix(target)
                .ok()
                .and_then(|r| r.to_str())
                .map(|r| r.replace('\\', "/"));
            if let Some(rel) = rel {
                if !manifest_paths.contains(rel.as_str()) {
                    plan.retire.push(rel);
                }
            }
        }
    }
    plan.retire.sort();
    plan
}

pub fn retire_files(target: &Path, rels: &[String]) -> std::io::Result<Vec<String>> {
    if rels.is_empty() {
        return Ok(vec![]);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into());
    let trash = target.join(".aether-trash").join(stamp);
    std::fs::create_dir_all(&trash)?;
    let mut moved = Vec::new();
    for rel in rels {
        let src = target.join(rel);
        let dest = trash.join(rel.replace('/', "_"));
        std::fs::rename(&src, &dest)?;
        moved.push(rel.clone());
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    fn sample_manifest() -> Manifest {
        Manifest {
            instance: ManifestMeta { id: "i1".into(), name: "Srv".into(), channel: String::new() },
            profile: ManifestMeta {
                id: "p1".into(),
                name: "Padrao".into(),
                channel: "stable".into(),
            },
            files: vec![
                ManifestFile {
                    path: "mods/alpha.jar".into(),
                    sha256: sha(b"alpha"),
                    size: 5,
                    action: "require".into(),
                },
                ManifestFile {
                    path: "config/x.toml".into(),
                    sha256: sha(b"[x]"),
                    size: 3,
                    action: "optional".into(),
                },
            ],
            managed: vec![ManagedDir {
                dir: "mods".into(),
                patterns: vec!["*.jar".into()],
                recursive: true,
            }],
            total_size: 8,
            game: None,
        }
    }

    #[test]
    fn wildcard_basics() {
        assert!(wildcard_match("Alpha.JAR", "*.jar"));
        assert!(wildcard_match("a.jar", "?.jar"));
        assert!(!wildcard_match("alpha.txt", "*.jar"));
        assert!(wildcard_match("qualquer", "*"));
    }

    #[test]
    fn canonical_matches_python_format() {
        let value: serde_json::Value =
            serde_json::from_str(r#"{"b": 2, "a": {"z": true, "c": "áé"}}"#).unwrap();
        let out = String::from_utf8(canonical_bytes(&value)).unwrap();
        // chaves ordenadas, sem espaços, UTF-8 cru — como o json.dumps do Core
        assert_eq!(out, r#"{"a":{"c":"áé","z":true},"b":2}"#);
    }

    #[test]
    fn plan_fresh_dir_downloads_required_only(){
        let tmp = std::env::temp_dir().join(format!("aether-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let plan = build_plan(&sample_manifest(), &tmp, false);
        assert_eq!(plan.download.len(), 1);
        assert_eq!(plan.download[0].path, "mods/alpha.jar");
        let plan_opt = build_plan(&sample_manifest(), &tmp, true);
        assert_eq!(plan_opt.download.len(), 2);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn plan_keeps_correct_and_retires_extras() {
        let tmp = std::env::temp_dir().join(format!("aether-test2-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("mods")).unwrap();
        std::fs::write(tmp.join("mods/alpha.jar"), b"alpha").unwrap();
        std::fs::write(tmp.join("mods/velho.jar"), b"remove").unwrap();
        std::fs::write(tmp.join("mods/notas.txt"), b"fica").unwrap();

        let plan = build_plan(&sample_manifest(), &tmp, false);
        assert_eq!(plan.keep, 1);
        assert!(plan.download.is_empty());
        assert_eq!(plan.retire, vec!["mods/velho.jar".to_string()]);

        let moved = retire_files(&tmp, &plan.retire).unwrap();
        assert_eq!(moved.len(), 1);
        assert!(!tmp.join("mods/velho.jar").exists());
        assert!(build_plan(&sample_manifest(), &tmp, false).is_synced());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
