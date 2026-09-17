export interface OnlinePlayers {
  online: number;
  max: number;
  names?: string[] | null;
  names_complete?: boolean;
}

export function PlayerRoster({ players }: { players: OnlinePlayers | null }) {
  return (
    <details className="player-roster">
      <summary>Ver jogadores online</summary>
      {!players ? <p>Status de jogadores indisponível.</p>
        : players.online === 0 ? <p>Nenhum jogador conectado.</p>
        : !players.names?.length ? <p>O servidor informa a contagem, mas não disponibilizou os nomes.</p>
        : <>
          <ul>{players.names.map((name) => <li key={name}>{name}</li>)}</ul>
          {!players.names_complete && <p>Lista parcial: {players.names.length} de {players.online} jogadores informados.</p>}
        </>}
      <p className="hint">Atualização automática a cada 15 segundos.</p>
    </details>
  );
}
