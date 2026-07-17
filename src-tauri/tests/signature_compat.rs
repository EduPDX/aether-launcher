//! Cross-language compatibility: a manifest signed by the Python Core must
//! verify byte-for-byte in Rust (canonical JSON: sorted keys, compact,
//! UTF-8 — including non-ASCII content).

use launcher_lib::sync::{verify_and_parse, SyncError};

fn fixture() -> serde_json::Value {
    let raw = include_str!("fixtures/signed_payload.json");
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

#[test]
fn python_signed_manifest_verifies_in_rust() {
    let payload = fixture();
    let manifest = payload["manifest"].clone();
    let sig = payload["signature"].as_str().unwrap();
    let key = payload["public_key"].as_str().unwrap();

    let parsed = verify_and_parse(&manifest, sig, key).expect("assinatura Python deve validar");
    assert_eq!(parsed.instance.name, "Servidor Ação & Emoção");
    assert_eq!(parsed.files.len(), 2);
    assert_eq!(parsed.total_size, 12352);
}

#[test]
fn tampered_manifest_is_rejected() {
    let payload = fixture();
    let mut manifest = payload["manifest"].clone();
    manifest["total_size"] = serde_json::json!(1);
    let sig = payload["signature"].as_str().unwrap();
    let key = payload["public_key"].as_str().unwrap();

    match verify_and_parse(&manifest, sig, key) {
        Err(SyncError::BadSignature) => {}
        other => panic!("esperava BadSignature, obteve {other:?}"),
    }
}
