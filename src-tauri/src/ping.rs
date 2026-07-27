//! Server List Ping (SLP) — o mesmo protocolo que a lista de servidores do
//! Minecraft usa. Num handshake TCP a gente obtém contagem de jogadores + MOTD,
//! e mede a latência real do cliente pelo pacote de ping/pong. Sem dependência
//! nova: o protocolo é pequeno (VarInt + um punhado de pacotes).

use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

#[derive(Serialize, Clone)]
pub struct ServerPing {
    online: i64,
    max: i64,
    latency_ms: u64,
    motd: String,
}

fn write_varint(buf: &mut Vec<u8>, mut value: u32) {
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if value == 0 {
            break;
        }
    }
}

async fn read_varint(stream: &mut TcpStream) -> Result<i32, String> {
    let mut result: i32 = 0;
    let mut shift = 0u32;
    loop {
        let mut b = [0u8; 1];
        stream.read_exact(&mut b).await.map_err(|e| e.to_string())?;
        result |= ((b[0] & 0x7F) as i32) << shift;
        if b[0] & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 35 {
            return Err("VarInt longo demais".into());
        }
    }
    Ok(result)
}

fn write_string(buf: &mut Vec<u8>, s: &str) {
    write_varint(buf, s.len() as u32);
    buf.extend_from_slice(s.as_bytes());
}

/// Embrulha um payload com seu tamanho (VarInt), como o protocolo exige.
fn framed(payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::new();
    write_varint(&mut out, payload.len() as u32);
    out.extend_from_slice(&payload);
    out
}

/// Achata a "description" (MOTD), que pode ser string ou componente de chat.
fn flatten_chat(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(o) => {
            let mut s = o.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
            if let Some(extra) = o.get("extra").and_then(|e| e.as_array()) {
                for e in extra {
                    s.push_str(&flatten_chat(e));
                }
            }
            s
        }
        _ => String::new(),
    }
}

/// Remove os códigos de cor (§x) e limita o tamanho do MOTD.
fn clean_motd(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '§' {
            chars.next(); // pula o código
        } else {
            out.push(c);
        }
    }
    out.trim().chars().take(120).collect()
}

#[tauri::command]
pub async fn server_ping(host: String, port: u16) -> Result<ServerPing, String> {
    timeout(Duration::from_secs(6), do_ping(host, port))
        .await
        .map_err(|_| "tempo esgotado ao consultar o servidor".to_string())?
}

async fn do_ping(host: String, port: u16) -> Result<ServerPing, String> {
    let mut stream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| format!("sem conexão com {host}:{port}: {e}"))?;

    // Handshake (próximo estado = 1, status)
    let mut hs = Vec::new();
    write_varint(&mut hs, 0x00); // packet id
    write_varint(&mut hs, 767); // versão de protocolo (qualquer recente serve)
    write_string(&mut hs, &host);
    hs.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut hs, 1); // next state: status
    stream.write_all(&framed(hs)).await.map_err(|e| e.to_string())?;

    // Status request (corpo vazio)
    let mut req = Vec::new();
    write_varint(&mut req, 0x00);
    stream.write_all(&framed(req)).await.map_err(|e| e.to_string())?;

    // Status response
    let _pkt_len = read_varint(&mut stream).await?;
    let pid = read_varint(&mut stream).await?;
    if pid != 0x00 {
        return Err("resposta de status inesperada".into());
    }
    let json_len = read_varint(&mut stream).await?;
    if json_len <= 0 || json_len > 5_000_000 {
        return Err("resposta de status inválida".into());
    }
    let mut json_buf = vec![0u8; json_len as usize];
    stream.read_exact(&mut json_buf).await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_slice(&json_buf).map_err(|e| e.to_string())?;

    let online = json.pointer("/players/online").and_then(|v| v.as_i64()).unwrap_or(0);
    let max = json.pointer("/players/max").and_then(|v| v.as_i64()).unwrap_or(0);
    let motd = clean_motd(&flatten_chat(&json["description"]));

    // Ping/pong para medir a latência real do cliente.
    let start = Instant::now();
    let mut ping = Vec::new();
    write_varint(&mut ping, 0x01);
    ping.extend_from_slice(&0x1234_5678i64.to_be_bytes());
    let latency_ms = if stream.write_all(&framed(ping)).await.is_ok() && read_pong(&mut stream).await.is_ok() {
        start.elapsed().as_millis() as u64
    } else {
        start.elapsed().as_millis() as u64
    };

    Ok(ServerPing { online, max, latency_ms, motd })
}

async fn read_pong(stream: &mut TcpStream) -> Result<(), String> {
    let _len = read_varint(stream).await?;
    let pid = read_varint(stream).await?;
    if pid != 0x01 {
        return Err("pong inesperado".into());
    }
    let mut payload = [0u8; 8];
    stream.read_exact(&mut payload).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Consulta um servidor Minecraft público de verdade. `#[ignore]` para não
    // rodar no CI (depende de rede); rode com `cargo test -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "rede: consulta um servidor público real"]
    async fn ping_public_server() {
        let r = do_ping("mc.hypixel.net".into(), 25565).await;
        match r {
            Ok(p) => {
                println!("online={} max={} latency={}ms motd={:?}", p.online, p.max, p.latency_ms, p.motd);
                assert!(p.max > 0, "servidor deveria reportar max de jogadores");
            }
            Err(e) => panic!("SLP falhou: {e}"),
        }
    }
}
