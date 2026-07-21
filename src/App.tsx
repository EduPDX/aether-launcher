import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import "./App.css";

interface Server {
  server: string;
  profileId: string;
  dir: string;
  username: string;
  /** Memória máxima da JVM em MB. Ausente = padrão (4 GB). */
  memoryMb?: number;
  /** Nome amigável (o do servidor, quando conhecido). */
  label?: string;
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

// ---------------------------------------------------------- armazenamento --
const SERVERS_KEY = "aether.launcher.servers";
const ACTIVE_KEY = "aether.launcher.active";
const LEGACY_KEY = "aether.launcher.config"; // config antiga, de servidor único

function loadServers(): Server[] {
  const raw = localStorage.getItem(SERVERS_KEY);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr as Server[];
    } catch {
      /* corrompido: cai para a migração/vazio */
    }
  }
  // Migração do formato antigo (um servidor só).
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try {
      const s = JSON.parse(legacy) as Server;
      localStorage.setItem(SERVERS_KEY, JSON.stringify([s]));
      return [s];
    } catch {
      /* ignora */
    }
  }
  return [];
}

function saveServers(s: Server[]) {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(s));
}

function loadActive(): number {
  return Number(localStorage.getItem(ACTIVE_KEY) ?? "0") || 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// --------------------------------------------------------------------- tema --
type ThemeMode = "dark" | "light";
interface Theme {
  mode: ThemeMode;
  accent: string;
}

const ACCENTS: { id: string; label: string }[] = [
  { id: "#22c55e", label: "Verde" },
  { id: "#3b82f6", label: "Azul" },
  { id: "#a855f7", label: "Roxo" },
  { id: "#f97316", label: "Laranja" },
  { id: "#ec4899", label: "Rosa" },
  { id: "#eab308", label: "Âmbar" },
];

function loadTheme(): Theme {
  const padrao: Theme = { mode: "dark", accent: "#22c55e" };
  try {
    return { ...padrao, ...JSON.parse(localStorage.getItem("aether.launcher.theme") ?? "{}") };
  } catch {
    return padrao;
  }
}

function applyTheme(t: Theme) {
  const r = document.documentElement;
  r.dataset.theme = t.mode;
  r.style.setProperty("--accent", t.accent);
  r.style.setProperty("--accent-dim", t.accent);
}

const STATE_LABEL: Record<string, string> = {
  running: "online",
  stopped: "offline",
  starting: "iniciando",
  stopping: "parando",
  crashed: "instável",
  unknown: "—",
};

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

// ------------------------------------------------------- atualização (auto) --
function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [estado, setEstado] = useState<"idle" | "baixando" | "erro">("idle");
  const [erro, setErro] = useState("");

  useEffect(() => {
    check()
      .then((u) => u && setUpdate(u))
      .catch(() => {});
  }, []);

  if (!update) return null;

  async function atualizar() {
    setEstado("baixando");
    setErro("");
    try {
      await update!.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setEstado("erro");
      setErro(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div className="update-banner">
      <span>
        Nova versão <b>{update.version}</b> disponível.
        {estado === "erro" && <span className="update-err"> Falhou: {erro}</span>}
      </span>
      <button className="primary" disabled={estado === "baixando"} onClick={atualizar}>
        {estado === "baixando" ? "Atualizando…" : "Atualizar agora"}
      </button>
    </div>
  );
}

type Section = "play" | "servers" | "files" | "settings" | "profile";

export default function App() {
  const [servers, setServers] = useState<Server[]>(loadServers);
  const [active, setActive] = useState<number>(loadActive);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [section, setSection] = useState<Section>("play");
  // null = sem edição; "new" = adicionar; número = editar o servidor daquele índice.
  const [editing, setEditing] = useState<number | "new" | null>(null);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("aether.launcher.theme", JSON.stringify(theme));
  }, [theme]);

  function persist(next: Server[], nextActive = active) {
    setServers(next);
    saveServers(next);
    const a = Math.max(0, Math.min(nextActive, next.length - 1));
    setActive(a);
    localStorage.setItem(ACTIVE_KEY, String(a));
  }

  // Sem servidor, ou adicionando/editando: tela de configuração do servidor.
  if (servers.length === 0 || editing !== null) {
    const alvo = typeof editing === "number" ? servers[editing] : null;
    return (
      <>
        <UpdateBanner />
        <SetupScreen
          initial={alvo}
          onCancel={servers.length > 0 ? () => setEditing(null) : undefined}
          onSave={(s) => {
            if (typeof editing === "number") {
              const next = servers.map((x, i) => (i === editing ? s : x));
              persist(next, editing);
            } else {
              persist([...servers, s], servers.length);
            }
            setEditing(null);
            setSection("play");
          }}
        />
      </>
    );
  }

  const current = servers[active] ?? servers[0];
  const patch = (p: Partial<Server>) => persist(servers.map((x, i) => (i === active ? { ...x, ...p } : x)));

  return (
    <>
      <UpdateBanner />
      <div className="layout">
        <nav className="sidebar">
          <div className="brand-mini">
            <div className="logo" />
            <span>Aether</span>
          </div>
          <SideItem icon="▶" label="Jogar" active={section === "play"} onClick={() => setSection("play")} />
          <SideItem icon="🗄" label="Servidores" active={section === "servers"} onClick={() => setSection("servers")} />
          <SideItem icon="📁" label="Arquivos" active={section === "files"} onClick={() => setSection("files")} />
          <SideItem icon="⚙" label="Configurações" active={section === "settings"} onClick={() => setSection("settings")} />
          <SideItem icon="👤" label="Perfil" active={section === "profile"} onClick={() => setSection("profile")} />
          <div className="side-foot">
            <div className="side-server" title={current.server}>
              {current.label || current.server}
            </div>
            <div className="side-user">{current.username}</div>
          </div>
        </nav>

        <main className="content">
          {section === "play" && <PlaySection server={current} />}
          {section === "servers" && (
            <ServersSection
              servers={servers}
              active={active}
              onSwitch={(i) => {
                persist(servers, i);
                setSection("play");
              }}
              onAdd={() => setEditing("new")}
              onEdit={(i) => setEditing(i)}
              onRemove={(i) => persist(servers.filter((_, k) => k !== i), active > i ? active - 1 : active)}
            />
          )}
          {section === "files" && <FilesSection server={current} />}
          {section === "settings" && (
            <SettingsSection server={current} theme={theme} onTheme={setTheme} onPatch={patch} />
          )}
          {section === "profile" && <ProfileSection server={current} onPatch={patch} />}
        </main>
      </div>
    </>
  );
}

function SideItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`side-item ${active ? "active" : ""}`} onClick={onClick}>
      <span className="side-ico">{icon}</span>
      {label}
    </button>
  );
}

// -------------------------------------------------------------- Setup/Server --
function SetupScreen({
  initial,
  onSave,
  onCancel,
}: {
  initial: Server | null;
  onSave: (s: Server) => void;
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
      const info = await invoke<ServerInfo>("server_info", {
        server: server.trim(),
        profileId: profileId.trim(),
      });
      onSave({
        server: server.trim(),
        profileId: profileId.trim(),
        dir,
        username: username.trim(),
        memoryMb: initial?.memoryMb,
        label: info.instance_name,
      });
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
        <h1>{initial ? "Editar servidor" : "Aether Launcher"}</h1>
      </div>
      <div className="card">
        <div className="field">
          <label>Endereço do servidor</label>
          <input placeholder="http://192.168.1.10:8600" value={server} onChange={(e) => setServer(e.target.value)} />
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
          <input placeholder="Seu nick no jogo" value={username} onChange={(e) => setUsername(e.target.value)} />
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
            {testing ? "Verificando…" : initial ? "Salvar" : "Conectar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Jogar --
function PlaySection({ server }: { server: Server }) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  function pushLog(line: string) {
    setLog((prev) => [...prev.slice(-300), line]);
  }

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      invoke<ServerInfo>("server_info", { server: server.server, profileId: server.profileId })
        .then((i) => !cancelled && setInfo(i))
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [server.server, server.profileId]);

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
        server: server.server,
        profileId: server.profileId,
        dir: server.dir,
        includeOptional: false,
      });
      pushLog("— preparando o jogo —");
      const result = await invoke<{ version: string; pid: number }>("play", {
        server: server.server,
        profileId: server.profileId,
        dir: server.dir,
        username: server.username,
        memoryMb: server.memoryMb ?? null,
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

  async function check_() {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<PlanSummary>("check_sync", {
        server: server.server,
        profileId: server.profileId,
        dir: server.dir,
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
        server: server.server,
        profileId: server.profileId,
        dir: server.dir,
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
    <div className="page">
      <div className="server-head">
        <span className="name">{info?.instance_name ?? server.label ?? "Conectando…"}</span>
        {info && <span className={`badge ${stateClass}`}>{STATE_LABEL[info.state] ?? info.state}</span>}
        {info && <span className="badge">{info.channel}</span>}
      </div>
      <p className="meta">
        {info
          ? `Perfil "${info.profile_name}" · ${info.files} arquivos · ${formatBytes(info.total_size)}`
          : server.server}
      </p>

      <button className="primary play" disabled={busy} onClick={playNow}>
        {busy ? "Trabalhando…" : "▶  Jogar"}
      </button>
      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={busy} onClick={sync}>
          Sincronizar
        </button>
        <button disabled={busy} onClick={check_}>
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

      {plan?.synced && !busy && !activity && <p className="ok">✔ Tudo sincronizado com o servidor.</p>}
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
  );
}

// ------------------------------------------------------------- Servidores --
function ServersSection({
  servers,
  active,
  onSwitch,
  onAdd,
  onEdit,
  onRemove,
}: {
  servers: Server[];
  active: number;
  onSwitch: (i: number) => void;
  onAdd: () => void;
  onEdit: (i: number) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <div className="page">
      <div className="page-head">
        <h2>Servidores</h2>
        <button className="primary" onClick={onAdd}>
          + Adicionar
        </button>
      </div>
      <div className="server-list">
        {servers.map((s, i) => (
          <div key={i} className={`server-card ${i === active ? "active" : ""}`}>
            <button className="server-main" onClick={() => onSwitch(i)}>
              <div className="server-name">
                {s.label || s.server}
                {i === active && <span className="badge online" style={{ marginLeft: 8 }}>ativo</span>}
              </div>
              <div className="server-sub">
                {s.server} · {s.username}
              </div>
            </button>
            <button className="ghost" title="Editar" onClick={() => onEdit(i)}>
              ✎
            </button>
            {servers.length > 1 && (
              <button className="ghost" title="Remover" onClick={() => onRemove(i)}>
                🗑
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Arquivos --
function FilesSection({ server }: { server: Server }) {
  return (
    <div className="page">
      <h2>Arquivos</h2>
      <p className="meta">Pasta do jogo: {server.dir}</p>
      <div className="soon">
        <p>O gerenciador de arquivos do cliente chega na próxima atualização:</p>
        <ul>
          <li>ver, editar e apagar arquivos da pasta do jogo</li>
          <li>criar a pasta <code>shaderpacks</code> para shaders</li>
        </ul>
        <p className="meta">O launcher se atualiza sozinho — é só aguardar o aviso.</p>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- Configurações --
function SettingsSection({
  server,
  theme,
  onTheme,
  onPatch,
}: {
  server: Server;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onPatch: (p: Partial<Server>) => void;
}) {
  const memGb = (server.memoryMb ?? DEFAULT_MEMORY_MB) / 1024;

  async function pickDir() {
    const chosen = await open({ directory: true, title: "Pasta do Minecraft (.minecraft)" });
    if (typeof chosen === "string") onPatch({ dir: chosen });
  }

  return (
    <div className="page">
      <h2>Configurações</h2>

      <div className="setting">
        <label>Tema</label>
        <div className="theme-modes">
          <button className={theme.mode === "dark" ? "seg active" : "seg"} onClick={() => onTheme({ ...theme, mode: "dark" })}>
            🌙 Escuro
          </button>
          <button className={theme.mode === "light" ? "seg active" : "seg"} onClick={() => onTheme({ ...theme, mode: "light" })}>
            ☀ Claro
          </button>
        </div>
        <div className="swatches">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              title={a.label}
              className={`swatch ${theme.accent === a.id ? "active" : ""}`}
              style={{ background: a.id }}
              onClick={() => onTheme({ ...theme, accent: a.id })}
            />
          ))}
        </div>
      </div>

      <div className="setting">
        <label>Memória do jogo — {memGb.toFixed(1)} GB</label>
        <input
          type="range"
          min={1}
          max={16}
          step={0.5}
          value={memGb}
          onChange={(e) => onPatch({ memoryMb: Math.round(Number(e.target.value) * 1024) })}
        />
        <p className="hint">Quanto o Minecraft pode usar de RAM. 4–8 GB serve à maioria dos servidores com mods.</p>
      </div>

      <div className="setting">
        <label>Pasta do jogo</label>
        <div className="row">
          <input value={server.dir} readOnly />
          <button onClick={pickDir}>Escolher…</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Perfil --
function ProfileSection({ server, onPatch }: { server: Server; onPatch: (p: Partial<Server>) => void }) {
  const [nick, setNick] = useState(server.username);

  return (
    <div className="page">
      <h2>Perfil</h2>
      <div className="avatar-block">
        <div className="avatar-big">{server.username.charAt(0).toUpperCase()}</div>
        <div>
          <div className="server-name">{server.username}</div>
          <div className="meta">Jogador neste servidor</div>
        </div>
      </div>

      <div className="setting">
        <label>Nome do jogador</label>
        <div className="row">
          <input value={nick} onChange={(e) => setNick(e.target.value)} />
          <button
            className="primary"
            disabled={!nick.trim() || nick.trim() === server.username}
            onClick={() => onPatch({ username: nick.trim() })}
          >
            Salvar
          </button>
        </div>
        <p className="hint">
          A grafia precisa ser igual à da whitelist do servidor (maiúsculas contam, em modo offline).
        </p>
      </div>

      <div className="soon" style={{ marginTop: 16 }}>
        <p>Skin personalizada chega numa próxima atualização.</p>
        <p className="meta">
          Em modo offline, skin exige um mod de skins no servidor — vamos desenhar isso com cuidado.
        </p>
      </div>
    </div>
  );
}
