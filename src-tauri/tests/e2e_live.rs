//! Live E2E against a real Aether Core (opt-in).
//!
//! Runs only when `AETHER_TEST_SERVER` and `AETHER_TEST_PROFILE` are set;
//! otherwise it's a no-op so CI stays green without a server.

use launcher_lib::sync::{build_plan, retire_files, sha256_file, verify_and_parse};

#[tokio::test]
async fn full_sync_against_live_core() {
    let (Ok(server), Ok(profile)) = (
        std::env::var("AETHER_TEST_SERVER"),
        std::env::var("AETHER_TEST_PROFILE"),
    ) else {
        eprintln!("AETHER_TEST_SERVER não definido — E2E ao vivo ignorado");
        return;
    };

    let http = reqwest::Client::new();
    let payload: serde_json::Value = http
        .get(format!("{server}/api/v1/public/sync/{profile}"))
        .send()
        .await
        .expect("core acessível")
        .json()
        .await
        .expect("payload JSON");

    let manifest_value = payload["manifest"].clone();
    let manifest = verify_and_parse(
        &manifest_value,
        payload["signature"].as_str().unwrap(),
        payload["public_key"].as_str().unwrap(),
    )
    .expect("assinatura do Core real deve validar em Rust");

    let target = std::env::temp_dir().join(format!("aether-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&target).unwrap();

    // 1) plano inicial: tudo por baixar
    let plan = build_plan(&manifest, &target, false);
    assert!(!plan.download.is_empty());

    // 2) baixa cada arquivo e confere o hash
    for entry in &plan.download {
        let bytes = http
            .get(format!("{server}/api/v1/public/sync/{profile}/file"))
            .query(&[("path", entry.path.as_str())])
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let dest = target.join(&entry.path);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, &bytes).unwrap();
        assert_eq!(sha256_file(&dest).unwrap(), entry.sha256, "{}", entry.path);
    }

    // 3) agora está sincronizado
    let plan2 = build_plan(&manifest, &target, false);
    assert!(plan2.is_synced(), "esperava sincronizado: {plan2:?}");

    // 4) arquivo intruso é aposentado
    let first_managed = &manifest.managed[0];
    let intruso = target.join(&first_managed.dir).join("intruso.jar");
    std::fs::write(&intruso, b"nao autorizado").unwrap();
    let plan3 = build_plan(&manifest, &target, false);
    assert_eq!(plan3.retire.len(), 1);
    retire_files(&target, &plan3.retire).unwrap();
    assert!(!intruso.exists());
    assert!(build_plan(&manifest, &target, false).is_synced());

    std::fs::remove_dir_all(&target).ok();
    println!(
        "E2E ao vivo OK: {} arquivos de '{}'",
        manifest.files.len(),
        manifest.instance.name
    );
}
