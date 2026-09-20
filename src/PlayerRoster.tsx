import { useEffect, useState } from "react";

export interface OnlinePlayers {
  online: number;
  max: number;
  names?: string[] | null;
  names_complete?: boolean;
}

/** Rosto (cabeça) do jogador recortado da skin do Aether; cai na letra inicial
 *  quando o jogador não tem skin (404) ou a imagem falha. */
function SkinHead({ name, base, extra }: { name: string; base?: string; extra?: string }) {
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
  if (extra) return <span className="roster-av more" title={`+${extra} online`}>+{extra}</span>;
  return ok
    ? <span className="roster-av skin-head" style={{ backgroundImage: `url("${url}")` }} title={name} />
    : <span className="roster-av" title={name}>{name.charAt(0).toUpperCase()}</span>;
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
        {extra > 0 && <SkinHead name="" extra={String(extra)} />}
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
