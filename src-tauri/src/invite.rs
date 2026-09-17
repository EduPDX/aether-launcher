//! Convites HTTP do Core. A pasta local é calculada aqui, nunca fornecida pelo servidor.
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

#[derive(Deserialize, Serialize)]
pub struct Invitation {
    version: u32,
    pub instance_id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub provider_id: String,
    pub server: String,
    pub name: String,
    #[serde(default)]
    pub game_address: String,
    #[serde(default)]
    pub map_url: String,
    #[serde(default)]
    pub cover_url: String,
    #[serde(default)]
    pub cover_credit: String,
    #[serde(default, skip_deserializing)]
    pub default_dir: String,
}

fn web_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Endereço inválido.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use um endereço HTTP ou HTTPS sem usuário e senha.".into());
    }
    Ok(url)
}

fn invitation_url(value: &str) -> Result<(Url, String), String> {
    let url = web_url(value)?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Cole o convite completo gerado na aba Launcher do painel.".into());
    }
    let (_, id) = url
        .path()
        .rsplit_once("/api/v1/public/launcher/")
        .ok_or("Este endereço não é um convite do Aether.")?;
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Código do perfil inválido no convite.".into());
    }
    let id = id.to_string();
    Ok((url, id))
}

fn folder_key(server: &str, instance: &str, profile: &str) -> String {
    // Não permite colisões entre perfis/servidores nem nomes vindos da rede como caminhos.
    hex::encode(Sha256::digest(format!(
        "{}\n{instance}\n{profile}",
        server.trim_end_matches('/')
    )))[..24]
        .into()
}

#[tauri::command]
pub async fn default_game_dir(
    app: tauri::AppHandle,
    server: String,
    profile_id: String,
) -> Result<String, String> {
    let server = web_url(&server)?;
    Ok(app
        .path()
        .local_data_dir()
        .map_err(|e| e.to_string())?
        .join("Aether")
        .join("instances")
        .join(folder_key(server.as_str(), "", &profile_id))
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn resolve_launcher_invite(
    app: tauri::AppHandle,
    invitation: String,
) -> Result<Invitation, String> {
    let mut data = fetch_invitation(&invitation).await?;
    data.default_dir = app
        .path()
        .local_data_dir()
        .map_err(|e| e.to_string())?
        .join("Aether")
        .join("instances")
        .join(folder_key(
            &data.server,
            &data.instance_id,
            &data.profile_id,
        ))
        .to_string_lossy()
        .into_owned();
    Ok(data)
}

async fn fetch_invitation(invitation: &str) -> Result<Invitation, String> {
    let (url, profile) = invitation_url(invitation)?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    let response = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Não foi possível consultar o convite: {e}"))?
        .error_for_status()
        .map_err(|e| {
            format!(
                "Convite indisponível. Confira a publicação e o endereço com o administrador: {e}"
            )
        })?;
    let mut data: Invitation = response
        .json()
        .await
        .map_err(|_| "Resposta de convite inválida.")?;
    if data.version != 1
        || data.profile_id != profile
        || data.instance_id.len() != 32
        || !data.instance_id.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Convite incompatível ou com identificação inválida.".into());
    }
    let server = web_url(&data.server)?;
    if server.query().is_some() || server.fragment().is_some() {
        return Err("Endereço do Core inválido no convite.".into());
    }
    for address in [&data.map_url, &data.cover_url] {
        if !address.is_empty() {
            web_url(address)?;
        }
    }
    if data
        .game_address
        .chars()
        .any(|c| c.is_whitespace() || "/\\?#@".contains(c))
    {
        return Err("Endereço de jogo inválido no convite.".into());
    }
    data.server = server.as_str().trim_end_matches('/').to_string();
    // Mantém a validação do manifesto assinado e confere a instância antes de aceitar.
    let (_, manifest) = crate::fetch_manifest(&http, &data.server, &data.profile_id).await?;
    if manifest.instance.id != data.instance_id || manifest.profile.id != data.profile_id {
        return Err("O perfil publicado não pertence ao servidor do convite.".into());
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requer Core local de teste e AETHER_TEST_INVITE_URL"]
    async fn resolves_local_core_and_signed_manifest() {
        let url = std::env::var("AETHER_TEST_INVITE_URL").expect("convite local de teste");
        assert!(url.starts_with("http://127.0.0.1:"));
        let data = fetch_invitation(&url)
            .await
            .expect("convite e manifesto válidos");
        assert_eq!(data.provider_id, "minecraft");
        assert!(!data.name.is_empty());
        assert!(!data.map_url.is_empty());
        assert!(!data.cover_url.is_empty());
        assert!(data.default_dir.is_empty());
    }
    #[test]
    fn accepts_prefixed_core_and_rejects_malformed_invites() {
        assert!(invitation_url(
            "https://example.com/aether/api/v1/public/launcher/0123456789abcdef0123456789abcdef"
        )
        .is_ok());
        for bad in [
            "file:///tmp/config",
            "https://user:pass@example.com/api/v1/public/launcher/0123456789abcdef0123456789abcdef",
            "https://example.com/api/v1/public/launcher/../x",
            "https://example.com/other",
        ] {
            assert!(invitation_url(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn folders_are_isolated_and_safe() {
        let first = folder_key("https://one.test", "../../instance", "profile");
        assert!(first.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(
            first,
            folder_key("https://two.test", "../../instance", "profile")
        );
        assert_ne!(
            first,
            folder_key("https://one.test", "../../instance", "other")
        );
    }
}
