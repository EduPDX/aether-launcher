import { useEffect, useState } from "react";

export interface OnlinePlayers {
  online: number;
  max: number;
  names?: string[] | null;
  names_complete?: boolean;
}

/** Rosto (cabeça) do jogador recortado da skin do Aether; cai na letra inicial
 *  quando o jogador não tem skin (404) ou a imagem falha. `cls` define o
 *  tamanho — `roster-av` na pilha compacta, `phead` na grade do dashboard. */
export function SkinHead({ name, base, cls = "roster-av" }: { name: string; base?: string; cls?: string }) {
  const url = base ? `${base.replace(/\/$/, "")}/api/v1/public/skins/${encodeURIComponent(name.toLowerCase())}.png` : "";
  const [ok, setOk] = useState(false);
  useEffect(() => {
    setOk(false);
    if (!url) return;
    const img = new Image();
    img.onload = () => setOk(true);
    img.onerror = () => setOk(false);
    img.src = url;
    return () => { img.onload = null; img.onerror = null; };
  }, [url]);
  return ok
    ? <span className={`${cls} skin-head`} style={{ backgroundImage: `url("${url}")` }} title={name} />
    : <span className={cls} title={name}>{name.charAt(0).toUpperCase()}</span>;
}

/** Grade de rostos grandes com o nome embaixo, preenchida da esquerda para a
 *  direita e quebrando em nova linha — o cartão "Jogadores online" do dashboard. */
export function PlayersGrid({ players, base }: { players: OnlinePlayers | null; base?: string }) {
  const names = players?.names ?? [];
  if (!names.length) return null;
  return (
    <div className="pgrid">
      {names.map((name) => (
        <div className="pgrid-item" key={name}>
          <SkinHead name={name} base={base} cls="phead" />
          <span className="pgrid-name" title={name}>{name}</span>
        </div>
      ))}
      {players && !players.names_complete && names.length < players.online && (
        <div className="pgrid-more" title={`${players.online - names.length} sem nome divulgado`}>
          +{players.online - names.length}
        </div>
      )}
    </div>
  );
}

/** Jogadores online como uma pilha de rostos + nomes, direto no widget —
 *  sem dropdown. Some quando não há ninguém ou o servidor não informa nomes. */
export function PlayerRoster({ players, base }: { players: OnlinePlayers | null; base?: string }) {
  if (!players || players.online === 0 || !players.names?.length) return null;

  const shown = players.names.slice(0, 5);
  const extra = players.online - shown.length;

  return (
    <div className="roster">
      <div className="roster-avatars">
        {shown.map((name) => (
          <SkinHead key={name} name={name} base={base} />
        ))}
        {extra > 0 && <span className="roster-av more" title={`+${extra} online`}>+{extra}</span>}
      </div>
      <div className="roster-names" title={players.names.join(", ")}>
        {shown.join(", ")}
        {extra > 0 ? ` e +${extra}` : ""}
      </div>
      {!players.names_complete && players.names.length < players.online && (
        <div className="roster-partial">lista parcial · {players.names.length} de {players.online}</div>
      )}
    </div>
  );
}
