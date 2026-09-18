export interface OnlinePlayers {
  online: number;
  max: number;
  names?: string[] | null;
  names_complete?: boolean;
}

/** Jogadores online como uma pilha de avatares + nomes, direto no widget —
 *  sem dropdown. Some quando não há ninguém ou o servidor não informa nomes. */
export function PlayerRoster({ players }: { players: OnlinePlayers | null }) {
  if (!players || players.online === 0 || !players.names?.length) return null;

  const shown = players.names.slice(0, 5);
  const extra = players.online - shown.length;

  return (
    <div className="roster">
      <div className="roster-avatars">
        {shown.map((name) => (
          <span key={name} className="roster-av" title={name}>
            {name.charAt(0).toUpperCase()}
          </span>
        ))}
        {extra > 0 && (
          <span className="roster-av more" title={`+${extra} online`}>+{extra}</span>
        )}
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
