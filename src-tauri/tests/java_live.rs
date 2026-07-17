//! Live Java install E2E (opt-in: set AETHER_TEST_JAVA=1).
//! Downloads the real Temurin 17 JRE from Adoptium (~45 MB) and probes it.

use launcher_lib::java;

#[tokio::test]
async fn installs_temurin_and_probes_version() {
    if std::env::var("AETHER_TEST_JAVA").is_err() {
        eprintln!("AETHER_TEST_JAVA não definido — instalação real de Java ignorada");
        return;
    }
    let data = std::env::temp_dir().join(format!("aether-java-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();

    let mut last = 0u64;
    let info = java::install(&data, 17, |done, _total| last = done)
        .await
        .expect("instalação do Temurin deve funcionar");

    assert!(last > 10_000_000, "esperava download de vários MB, veio {last}");
    assert!(info.version.contains("17"), "banner: {}", info.version);
    assert!(std::path::Path::new(&info.path).is_file());

    // segunda chamada de status encontra o runtime já instalado
    let cached = java::managed_java(&data, 17).expect("runtime gerenciado detectado");
    assert_eq!(cached.path, info.path);

    println!("Java instalado: {} ({})", info.version, info.path);
    std::fs::remove_dir_all(&data).ok();
}
