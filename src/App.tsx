import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import "./App.css";

interface Config {
  server: string;
  profileId: string;
  dir: string;
  username: string;
  /** Memória máxima da JVM em MB. Ausente = padrão (4 GB). */
  memoryMb?: number;
}

interface ServerInfo {
  instance_name: string;
  profile_name: string;
  channel: string;
  files: number;
  total_size: number;
  state: string;
}

interface PlanSummary {
  download: string[];
  download_size: number;
  retire: string[];
  keep: number;
  synced: boolean;
}

interface SyncProgress {
  stage: "download" | "retire" | "done";
  path: string;
  done: number;
  total: number;
}

interface PlayProgress {
  stage: string;
  detail: string;
  done: number;
  total: number;
}

/** O que a barra de progresso mostra agora — de sync ou de play, unificado. */
interface Activity {
  label: string;
  detail: string;
  done: number;
  total: number;
}

const DEFAULT_MEMORY_MB = 4096;

function loadConfig(): Config | null {
  const raw = localStorage.getItem("aether.launcher.config");
  return raw ? (JSON.parse(raw) as Config) : null;
}

function saveConfig(c: Config) {
  localStorage.setItem("aether.launcher.config", JSON.stringify(c));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const STATE_LABEL: Record<string, string> = {
  running: "online",
  stopped: "offline",
  starting: "iniciando",
  stopping: "parando",
  crashed: "instável",
  unknown: "—",
};

// Rótulos amigáveis para cada etapa do preparo do jogo.
const PLAY_STAGE: Record<string, string> = {
  java: "Java",
  meta: "Versão",
  client: "Minecraft",
  libraries: "Bibliotecas",
  assets: "Recursos do jogo",
  forge: "Forge",
  launch: "Abrindo",
  running: "Jogo iniciado",
  closed: "Jogo encerrado",
};

export default function App() {
  const [config, setConfig] = useState<Config | null>(loadConfig);
  const [editing, setEditing] = useState(false);

  if (!config || editing) {
    return (
      <SetupScreen
        initial={config}
        onCancel={config ? () => setEditing(false) : undefined}
        onSave={(c) => {
          saveConfig({ ...config, ...c });
          setConfig((prev) => ({ ...prev, ...c }) as Config);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <MainScreen
      config={config}
      onEditServer={() => setEditing(true)}
      onUpdateConfig={(patch) => {
        const next = { ...config, ...patch };
        saveConfig(next);
        setConfig(next);
      }}
    />
  );
}

function SetupScreen({
  initial,
  onSave,
  onCancel,
}: {
  initial: Config | null;
  onSave: (c: Config) => void;
  onCancel?: () => void;
}) {
  const [server, setServer] = useState(initial?.server ?? "");
  const [profileId, setProfileId] = useState(initial?.profileId ?? "");
  const [dir, setDir] = useState(initial?.dir ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);

  async function pickDir() {
    const chosen = await open({ directory: true, title: "Pasta do Minecraft (.minecraft)" });
    if (typeof chosen === "string") setDir(chosen);
  }

  async function save() {
    setError("");
    setTesting(true);
    try {
      await invoke<ServerInfo>("server_info", {
        server: server.trim(),
        profileId: profileId.trim(),
      });
      onSave({ server: server.trim(), profileId: profileId.trim(), dir, username: username.trim() });
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }

  const valido = server.trim() && profileId.trim() && dir && username.trim();

  return (
    <div className="shell center">
      <div className="brand">
        <div className="logo" />
        <h1>Aether Launcher</h1>
      </div>
      <div className="card">
        <div className="field">
          <label>Endereço do servidor</label>
          <input
            placeholder="http://192.168.1.10:8600"
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Código do perfil (peça ao admin)</label>
          <input
            placeholder="ex.: 2f1c93e869ee4563b98093abd9ad54b6"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Nome do jogador</label>
          <input
            placeholder="Seu nick no jogo"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Pasta do jogo</label>
          <div className="row">
            <input placeholder="C:\...\.minecraft" value={dir} readOnly />
            <button onClick={pickDir}>Escolher…</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ marginTop: 4 }}>
          {onCancel && (
            <button onClick={onCancel} disabled={testing}>
              Cancelar
            </button>
          )}
          <button className="primary big" disabled={!valido || testing} onClick={save}>
            {testing ? "Verificando…" : "Conectar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MainScreen({
  config,
  onEditServer,
  onUpdateConfig,
}: {
  config: Config;
  onEditServer: () => void;
  onUpdateConfig: (patch: Partial<Config>) => void;
}) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  function pushLog(line: string) {
    setLog((prev) => [...prev.slice(-300), line]);
  }

  // Info do servidor, recarregada a cada 15s (status online/offline muda).
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      invoke<ServerInfo>("server_info", { server: config.server, profileId: config.profileId })
        .then((i) => !cancelled && setInfo(i))
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [config.server, config.profileId]);

  // Progresso do preparo do jogo: alimenta a barra, não só o log.
  useEffect(() => {
    const unlisten = listen<PlayProgress>("play-progress", (event) => {
      const p = event.payload;
      const label = PLAY_STAGE[p.stage] ?? p.stage;
      setActivity({ label, detail: p.detail, done: p.done, total: p.total });
      pushLog(p.total > 0 ? `${label}: ${p.detail} (${p.done}/${p.total})` : `${label}: ${p.detail}`);
      if (p.stage === "closed" && p.detail.includes("erro")) setError(`${label}: ${p.detail}`);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Progresso da sincronização de arquivos.
  useEffect(() => {
    const unlisten = listen<SyncProgress>("sync-progress", (event) => {
      const p = event.payload;
      const label = p.stage === "retire" ? "Removendo" : p.stage === "done" ? "Sincronizado" : "Baixando";
      setActivity({ label, detail: p.path, done: p.done, total: p.total });
      if (p.stage === "download") pushLog(`baixado  ${p.path}`);
      if (p.stage === "retire") pushLog(`removido ${p.path}`);
      if (p.stage === "done") pushLog("— sincronização concluída —");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (showLog) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, showLog]);

  async function playNow() {
    setBusy(true);
    setError("");
    setActivity({ label: "Preparando", detail: "sincronizando", done: 0, total: 0 });
    try {
      pushLog("— sincronizando antes de jogar —");
      await invoke<PlanSummary>("run_sync", {
        server: config.server,
        profileId: config.profileId,
        dir: config.dir,
        includeOptional: false,
      });
      pushLog("— preparando o jogo —");
      const result = await invoke<{ version: string; pid: number }>("play", {
        server: config.server,
        profileId: config.profileId,
        dir: config.dir,
        username: config.username,
        memoryMb: config.memoryMb ?? null,
      });
      pushLog(`Minecraft ${result.version} aberto (pid ${result.pid}). Bom jogo!`);
      setActivity({ label: "Jogo iniciado", detail: "bom jogo!", done: 1, total: 1 });
    } catch (e) {
      setError(String(e));
      pushLog(`ERRO: ${e}`);
      setActivity(null);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<PlanSummary>("check_sync", {
        server: config.server,
        profileId: config.profileId,
        dir: config.dir,
        includeOptional: false,
      });
      setPlan(result);
      pushLog(
        `verificado: ${result.download.length} para baixar (${formatBytes(result.download_size)}), ` +
          `${result.retire.length} para remover, ${result.keep} corretos`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    setError("");
    setActivity({ label: "Sincronizando", detail: "", done: 0, total: 0 });
    try {
      const result = await invoke<PlanSummary>("run_sync", {
        server: config.server,
        profileId: config.profileId,
        dir: config.dir,
        includeOptional: false,
      });
      setPlan({ ...result, synced: true, download: [], retire: [] });
    } catch (e) {
      setError(String(e));
      pushLog(`ERRO: ${e}`);
      setActivity(null);
    } finally {
      setBusy(false);
    }
  }

  const pct = activity && activity.total > 0 ? Math.round((activity.done / activity.total) * 100) : null;
  const stateClass =
    info?.state === "running" ? "online" : info?.state === "crashed" ? "crashed" : "offline";

  return (
    <div className="shell">
      <div className="brand">
        <div className="logo" />
        <h1>Aether Launcher</h1>
      </div>

      <div className="card main">
        <div className="server-head">
          <span className="name">{info?.instance_name ?? "Conectando…"}</span>
          {info && <span className={`badge ${stateClass}`}>{STATE_LABEL[info.state] ?? info.state}</span>}
          {info && <span className="badge">{info.channel}</span>}
          <span className="head-right">
            <span className="who">{config.username}</span>
            <button className="ghost" onClick={() => setShowSettings(true)} title="Ajustes">
              ⚙
            </button>
          </span>
        </div>
        <p className="meta">
          {info
            ? `Perfil "${info.profile_name}" · ${info.files} arquivos · ${formatBytes(info.total_size)}`
            : config.server}
        </p>

        <button className="primary play" disabled={busy} onClick={playNow}>
          {busy ? "Trabalhando…" : "▶  Jogar"}
        </button>
        <div className="row" style={{ marginTop: 8 }}>
          <button disabled={busy} onClick={sync}>
            Sincronizar
          </button>
          <button disabled={busy} onClick={check}>
            Verificar
          </button>
        </div>

        {activity && (
          <div className="activity">
            <div className="activity-head">
              <span className="activity-label">{activity.label}</span>
              <span className="activity-detail">{activity.detail}</span>
              {pct !== null && <span className="activity-pct">{pct}%</span>}
            </div>
            <div className="progress-track">
              <div
                className={`progress-fill ${pct === null ? "indeterminate" : ""}`}
                style={pct !== null ? { width: `${pct}%` } : undefined}
              />
            </div>
          </div>
        )}

        {plan?.synced && !busy && !activity && (
          <p className="ok">✔ Tudo sincronizado com o servidor.</p>
        )}

        {error && <p className="error">{error}</p>}

        <div className="log-toggle">
          <button className="ghost" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "▾ Ocultar detalhes" : "▸ Mostrar detalhes"}
          </button>
        </div>
        {showLog && (
          <div className="log" ref={logRef}>
            {log.join("\n") || "Pronto. Clique em Jogar para sincronizar e abrir o jogo."}
          </div>
        )}
      </div>

      {showSettings && (
        <SettingsModal
          config={config}
          onClose={() => setShowSettings(false)}
          onUpdate={onUpdateConfig}
          onEditServer={onEditServer}
        />
      )}
    </div>
  );
}

function SettingsModal({
  config,
  onClose,
  onUpdate,
  onEditServer,
}: {
  config: Config;
  onClose: () => void;
  onUpdate: (patch: Partial<Config>) => void;
  onEditServer: () => void;
}) {
  const [memoryGb, setMemoryGb] = useState((config.memoryMb ?? DEFAULT_MEMORY_MB) / 1024);
  const [username, setUsername] = useState(config.username);
  const [dir, setDir] = useState(config.dir);

  async function pickDir() {
    const chosen = await open({ directory: true, title: "Pasta do Minecraft (.minecraft)" });
    if (typeof chosen === "string") setDir(chosen);
  }

  function salvar() {
    onUpdate({
      memoryMb: Math.round(memoryGb * 1024),
      username: username.trim() || config.username,
      dir: dir || config.dir,
    });
    onClose();
  }

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Ajustes</h2>

        <div className="field">
          <label>Memória do jogo — {memoryGb.toFixed(1)} GB</label>
          <input
            type="range"
            min={1}
            max={16}
            step={0.5}
            value={memoryGb}
            onChange={(e) => setMemoryGb(Number(e.target.value))}
          />
          <p className="hint">
            Quanto o Minecraft pode usar de RAM. 4–8 GB serve à maioria dos servidores com mods.
          </p>
        </div>

        <div className="field">
          <label>Nome do jogador</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>

        <div className="field">
          <label>Pasta do jogo</label>
          <div className="row">
            <input value={dir} readOnly />
            <button onClick={pickDir}>Escolher…</button>
          </div>
        </div>

        <button
          className="ghost"
          style={{ marginTop: 4 }}
          onClick={() => {
            onClose();
            onEditServer();
          }}
        >
          Trocar de servidor / perfil…
        </button>

        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={onClose}>Cancelar</button>
          <button className="primary big" onClick={salvar}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
