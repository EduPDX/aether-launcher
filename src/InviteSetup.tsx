import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Server } from "./App";

export interface Invitation {
  instance_id: string; profile_id: string; profile_name: string; provider_id: string;
  server: string; name: string; game_address: string; map_url: string;
  cover_url: string; cover_credit: string; default_dir: string;
}
export function invitationPatch(data: Invitation): Partial<Server> {
  return { server: data.server, profileId: data.profile_id, instanceId: data.instance_id,
    label: data.name, gameAddress: data.game_address || undefined, mapUrl: data.map_url || undefined,
    coverUrl: data.cover_url || undefined, coverCredit: data.cover_credit || undefined };
}
export function ServerCover({ url, credit }: { url?: string; credit?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return null;
  return <><img className="server-cover" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(url)} />
    {credit && <span className="cover-credit" title={credit}>{credit}</span>}</>;
}
export function InviteSetup({ initial, onSave, onCancel, onManual }: {
  initial: Server | null; onSave: (server: Server) => void; onCancel?: () => void; onManual: () => void;
}) {
  const [invitation, setInvitation] = useState(initial?.invitation ?? "");
  const [resolved, setResolved] = useState<Invitation | null>(null);
  const [nick, setNick] = useState(initial?.username ?? "");
  const [autojoin, setAutojoin] = useState(initial?.autojoin ?? true);
  const [dir, setDir] = useState(initial?.dir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resolve() {
    setBusy(true); setError(""); setResolved(null);
    try { setResolved(await invoke<Invitation>("resolve_launcher_invite", { invitation: invitation.trim() })); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <div className="setup"><div className="brand"><h1>{initial ? "Atualizar convite" : "Seu próximo mundo começa aqui"}</h1></div>
    <div className="card invite-card">
      <p className="hint">Cole o convite enviado pelo administrador. Os endereços e o perfil são preenchidos automaticamente.</p>
      <div className="field"><label htmlFor="invite">Convite do Aether</label><div className="row">
        <input id="invite" value={invitation} disabled={busy} placeholder="https://aether.exemplo.com/api/v1/public/launcher/…" onChange={e => { setInvitation(e.target.value); setResolved(null); }} onKeyDown={e => { if (e.key === "Enter" && invitation.trim() && !busy) void resolve(); }} />
        <button className="btn" disabled={busy || !invitation.trim()} onClick={resolve}>{busy ? "Consultando…" : "Consultar"}</button>
      </div></div>
      {resolved && <>
        <div className="invite-server"><ServerCover url={resolved.cover_url} credit={resolved.cover_credit} /><div className="invite-server-text"><span className="eyebrow">Servidor do convite</span><h2>{resolved.name}</h2><p>{resolved.profile_name}</p></div></div>
        <p className="hint invite-origin">Origem: {resolved.server}</p>
        <div className="field"><label htmlFor="invite-nick">Nome do jogador</label><input id="invite-nick" value={nick} maxLength={16} placeholder="Seu nickname no Minecraft" onChange={e => setNick(e.target.value)} /></div>
        <label className="invite-autojoin"><input type="checkbox" checked={autojoin} onChange={e => setAutojoin(e.target.checked)} />Entrar diretamente no servidor ao jogar</label>
        <details className="invite-advanced"><summary>Opções avançadas · pasta do jogo</summary><p className="hint">Cada perfil tem sua própria instalação. A pasta será criada ao instalar o jogo.</p>
          <div className="field"><label htmlFor="invite-dir">Pasta de destino</label><div className="row"><input id="invite-dir" readOnly value={dir || resolved.default_dir} /><button className="btn" onClick={async () => { const chosen = await open({ directory: true, title: "Pasta do jogo" }); if (typeof chosen === "string") setDir(chosen); }}>Escolher…</button></div></div>
          {dir && <button className="btn ghost" onClick={() => setDir("")}>Usar pasta padrão</button>}
        </details>
        <button className="btn primary lg" disabled={!/^[A-Za-z0-9_]{3,16}$/.test(nick.trim())} onClick={() => onSave({ ...initial, ...invitationPatch(resolved), server: resolved.server, profileId: resolved.profile_id, username: nick.trim(), dir: dir || resolved.default_dir, invitation: invitation.trim(), autojoin })}>{initial ? "Salvar servidor" : "Adicionar servidor"}</button>
        {nick && !/^[A-Za-z0-9_]{3,16}$/.test(nick.trim()) && <p className="hint">Use de 3 a 16 letras, números ou sublinhado no nickname.</p>}
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row invite-footer">{onCancel && <button className="btn ghost" onClick={onCancel}>Cancelar</button>}<button className="btn ghost" onClick={onManual}>Configuração manual</button></div>
    </div>
  </div>;
}
