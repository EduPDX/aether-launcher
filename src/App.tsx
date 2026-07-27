import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState, type ReactElement } from "react";
import "./App.css";

// ============================================================== tipos =======
interface Server {
  server: string;
  profileId: string;
  dir: string;
  username: string;
  /** Memória máxima da JVM em MB. Ausente = padrão (4 GB). */
  memoryMb?: number;
  /** Nome amigável (o do servidor, quando conhecido). */
  label?: string;
  /** Endereço do servidor de jogo (host ou host:porta) para entrar direto.
   *  Vazio = o launcher deriva do endereço do Core + porta do status. */
  gameAddress?: string;
}

interface ServerInfo {
  instance_name: string;
  profile_name: string;
  channel: string;
  files: number;
  total_size: number;
  state: string;
  port?: number | null;
  players?: { online: number; max: number } | null;
  latency_ms?: number | null;
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

interface Activity {
  label: string;
  detail: string;
  done: number;
  total: number;
}

interface SystemStats {
  cpu: number;
  mem_used: number;
  mem_total: number;
}

const DEFAULT_MEMORY_MB = 4096;

// ==================================================== armazenamento =========
const SERVERS_KEY = "aether.launcher.servers";
const ACTIVE_KEY = "aether.launcher.active";
const LEGACY_KEY = "aether.launcher.config";

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

// ============================================================== tema ========
// Os mesmos temas do dashboard do servidor (lib/themes.ts), trazidos ao launcher.
interface ThemeTokens {
  bg: string; surface: string; surface2: string; surface3: string; border: string;
  text: string; muted: string; accent: string; accentDim: string; danger: string; warn: string; info: string;
}
interface Theme { label: string; dark: boolean; tokens: ThemeTokens; }

const THEMES: Record<string, Theme> = {
  aether: { label: "Aether", dark: true, tokens: { bg: "#0b1220", surface: "#131f36", surface2: "#1b2b4a", surface3: "#24395f", border: "#2b4470", text: "#eaf2ff", muted: "#94accd", accent: "#22e39b", accentDim: "#12c684", danger: "#ff5c7a", warn: "#ffc63d", info: "#4cc9f0" } },
  roxo: { label: "Roxo", dark: true, tokens: { bg: "#1a143d", surface: "#251c58", surface2: "#2d245e", surface3: "#3b2f7a", border: "#463a8f", text: "#e0d7ff", muted: "#a89ad4", accent: "#a78bfa", accentDim: "#8b5cf6", danger: "#fb7185", warn: "#fbbf24", info: "#7dd3fc" } },
  ametista: { label: "Ametista", dark: true, tokens: { bg: "#1e0b36", surface: "#2b1150", surface2: "#37175f", surface3: "#4a1f7d", border: "#5b2896", text: "#f5f3ff", muted: "#c4a6e8", accent: "#d8b4fe", accentDim: "#c084fc", danger: "#ff6b8b", warn: "#fcd34d", info: "#a5b4fc" } },
  synthwave: { label: "Synthwave", dark: true, tokens: { bg: "#190b2e", surface: "#251140", surface2: "#331858", surface3: "#452076", border: "#57298f", text: "#ffe9fb", muted: "#c39ad9", accent: "#ff5fd2", accentDim: "#e839b6", danger: "#ff4365", warn: "#ffd166", info: "#5bd1ff" } },
  cyber: { label: "Cyber", dark: true, tokens: { bg: "#04141c", surface: "#07222e", surface2: "#0a3040", surface3: "#0f4256", border: "#12556e", text: "#d7fbff", muted: "#71b4c7", accent: "#00f0ff", accentDim: "#00c2cc", danger: "#ff4d6d", warn: "#ffd60a", info: "#7b61ff" } },
  oceano: { label: "Oceano", dark: true, tokens: { bg: "#06212b", surface: "#0a3040", surface2: "#0e3f52", surface3: "#155268", border: "#1a6580", text: "#dff8f5", muted: "#7fb9c4", accent: "#2dd4bf", accentDim: "#14b8a6", danger: "#fb7185", warn: "#fbbf24", info: "#38bdf8" } },
  dracula: { label: "Dracula", dark: true, tokens: { bg: "#282a36", surface: "#343746", surface2: "#3d4055", surface3: "#4a4d68", border: "#5b5f80", text: "#f8f8f2", muted: "#b9c0dc", accent: "#bd93f9", accentDim: "#9d6ff5", danger: "#ff5555", warn: "#f1fa8c", info: "#8be9fd" } },
  catppuccin: { label: "Catppuccin", dark: true, tokens: { bg: "#1e1e2e", surface: "#28283d", surface2: "#313244", surface3: "#45475a", border: "#585b70", text: "#cdd6f4", muted: "#a6adc8", accent: "#a6e3a1", accentDim: "#88d98a", danger: "#f38ba8", warn: "#f9e2af", info: "#89b4fa" } },
  hacker: { label: "Hacker", dark: true, tokens: { bg: "#020a02", surface: "#061606", surface2: "#0a220a", surface3: "#103010", border: "#164016", text: "#b8ffb8", muted: "#5fa85f", accent: "#39ff14", accentDim: "#22d40a", danger: "#ff3131", warn: "#faff00", info: "#00e5ff" } },
  fogo: { label: "Fogo", dark: true, tokens: { bg: "#1a0d08", surface: "#2a150c", surface2: "#3a1d10", surface3: "#4e2716", border: "#63321c", text: "#ffe9dd", muted: "#c99b82", accent: "#ff7a29", accentDim: "#e85d04", danger: "#ff3b30", warn: "#ffc300", info: "#4cc9f0" } },
  nord: { label: "Nord", dark: true, tokens: { bg: "#2e3440", surface: "#3b4252", surface2: "#434c5e", surface3: "#4c566a", border: "#59647a", text: "#eceff4", muted: "#a9b4c6", accent: "#88c0d0", accentDim: "#6da8ba", danger: "#bf616a", warn: "#ebcb8b", info: "#81a1c1" } },
  tokyo: { label: "Tokyo Night", dark: true, tokens: { bg: "#1a1b26", surface: "#24283b", surface2: "#2f334d", surface3: "#3b4261", border: "#4a5178", text: "#c0caf5", muted: "#8f96bd", accent: "#7aa2f7", accentDim: "#5d86e0", danger: "#f7768e", warn: "#e0af68", info: "#7dcfff" } },
  gruvbox: { label: "Gruvbox", dark: true, tokens: { bg: "#1d2021", surface: "#282828", surface2: "#32302f", surface3: "#3c3836", border: "#504945", text: "#fbf1c7", muted: "#bdae93", accent: "#b8bb26", accentDim: "#98971a", danger: "#fb4934", warn: "#fabd2f", info: "#83a598" } },
  matcha: { label: "Matcha", dark: true, tokens: { bg: "#0d1a10", surface: "#132618", surface2: "#1a3421", surface3: "#23452c", border: "#2d5738", text: "#e3f5e7", muted: "#8fb99a", accent: "#7bd88f", accentDim: "#57bd6e", danger: "#ff6b6b", warn: "#ffd166", info: "#5bc0eb" } },
  vinho: { label: "Vinho", dark: true, tokens: { bg: "#1c0a10", surface: "#2b1019", surface2: "#3a1622", surface3: "#4d1d2d", border: "#63263a", text: "#ffe4ec", muted: "#c88ea3", accent: "#ff6b9d", accentDim: "#e04578", danger: "#ff4d4d", warn: "#ffb703", info: "#7fb3ff" } },
  grafite: { label: "Grafite", dark: true, tokens: { bg: "#0f0f11", surface: "#18181b", surface2: "#212124", surface3: "#2c2c31", border: "#3a3a41", text: "#f4f4f5", muted: "#a1a1aa", accent: "#e4e4e7", accentDim: "#c4c4c8", danger: "#f87171", warn: "#fbbf24", info: "#60a5fa" } },
  sakura: { label: "Sakura (claro)", dark: false, tokens: { bg: "#fff5f7", surface: "#ffffff", surface2: "#ffeaf0", surface3: "#ffd6e2", border: "#f7c2d4", text: "#4a1128", muted: "#96566f", accent: "#db2777", accentDim: "#be185d", danger: "#dc2626", warn: "#b45309", info: "#2563eb" } },
  papel: { label: "Papel (claro)", dark: false, tokens: { bg: "#faf7f0", surface: "#ffffff", surface2: "#f3ede1", surface3: "#e8dfcc", border: "#d9ccb2", text: "#2d2a24", muted: "#6f6754", accent: "#a16207", accentDim: "#854d0e", danger: "#b91c1c", warn: "#c2410c", info: "#1d4ed8" } },
  lavanda: { label: "Lavanda (claro)", dark: false, tokens: { bg: "#f6f4ff", surface: "#ffffff", surface2: "#efeaff", surface3: "#e0d7fb", border: "#cfc2f5", text: "#2e1065", muted: "#6d5ba3", accent: "#7c3aed", accentDim: "#6d28d9", danger: "#dc2626", warn: "#d97706", info: "#2563eb" } },
  geada: { label: "Geada (claro)", dark: false, tokens: { bg: "#f2f8fb", surface: "#ffffff", surface2: "#e8f2f8", surface3: "#d5e7f0", border: "#bcd8e6", text: "#0d2b3a", muted: "#4a7186", accent: "#0891b2", accentDim: "#0e7490", danger: "#dc2626", warn: "#b45309", info: "#2563eb" } },
};

const THEME_KEY = "aether.launcher.theme";

function loadPreset(): string {
  const id = localStorage.getItem(THEME_KEY);
  return id && THEMES[id] ? id : "aether";
}

function hexRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Cor do texto sobre o acento (contraste automático). */
function inkFor(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#0b1020" : "#ffffff";
}

function applyPreset(name: string) {
  const t = THEMES[name] ?? THEMES.aether;
  const k = t.tokens;
  const r = document.documentElement;
  const set = (key: string, val: string) => r.style.setProperty(key, val);
  set("--bg", k.bg);
  set("--surface", k.surface);
  set("--surface-2", k.surface2);
  set("--surface-3", k.surface3);
  set("--surface-4", k.surface3);
  set("--border", k.border);
  set("--border-soft", k.border);
  set("--text", k.text);
  set("--text-dim", k.muted);
  set("--text-mute", k.muted);
  set("--accent", k.accent);
  set("--accent-2", k.info);
  set("--accent-ink", inkFor(k.accent));
  set("--accent-soft", hexRgba(k.accent, 0.16));
  set("--danger", k.danger);
  set("--warn", k.warn);
  set("--info", k.info);
  r.style.colorScheme = t.dark ? "dark" : "light";
}

const STATE_LABEL: Record<string, string> = {
  running: "online", stopped: "offline", starting: "iniciando",
  stopping: "parando", crashed: "instável", unknown: "—",
};

const PLAY_STAGE: Record<string, string> = {
  java: "Java", meta: "Versão", client: "Minecraft", libraries: "Bibliotecas",
  assets: "Recursos do jogo", forge: "Forge", launch: "Abrindo",
  running: "Jogo iniciado", closed: "Jogo encerrado",
};

// ============================================================== ícones ======
function BrandLogo({ size = 24 }: { size?: number }) {
  return (
    <span className="brand-logo">
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <defs>
          <linearGradient id="aeg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#34d399" />
            <stop offset="1" stopColor="#38bdf8" />
          </linearGradient>
        </defs>
        <rect x="8.5" y="2" width="8" height="8" rx="2" fill="url(#aeg)" />
        <rect x="2.5" y="12" width="8" height="8" rx="2" fill="url(#aeg)" />
        <rect x="14.5" y="12" width="8" height="8" rx="2" fill="url(#aeg)" />
      </svg>
    </span>
  );
}

type IconName = "dashboard" | "content" | "files" | "map" | "servers" | "skin" | "settings" | "cpu" | "ram" | "server" | "play" | "refresh" | "players" | "ping" | "folder" | "file" | "trash" | "lock" | "download";

function Icon({ n }: { n: IconName }) {
  const p: Record<IconName, ReactElement> = {
    dashboard: <path d="M3 12 12 3l9 9M5 10v10h5v-6h4v6h5V10" />,
    content: <><circle cx="13.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="14.5" r="2.5" /><circle cx="6.5" cy="12.5" r="2.5" /></>,
    files: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    map: <path d="m9 4-6 3v13l6-3 6 3 6-3V4l-6 3-6-3ZM9 4v13M15 7v13" />,
    servers: <><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
    skin: <><circle cx="12" cy="8" r="4" /><path d="M5.5 21a6.5 6.5 0 0 1 13 0" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
    cpu: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9z" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>,
    ram: <path d="M4 6h16v9H4zM8 15v3M16 15v3M8 6V4M16 6V4" />,
    server: <><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
    play: <path d="M7 5v14l11-7z" />,
    refresh: <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />,
    players: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    ping: <path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01" />,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    file: <path d="M14 2v6h6M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />,
    trash: <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13h10l1-13" />,
    lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />,
  };
  const filled = n === "play";
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {p[n]}
    </svg>
  );
}

// ==================================================== atualização (auto) ====
function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [estado, setEstado] = useState<"idle" | "baixando" | "erro">("idle");
  const [erro, setErro] = useState("");

  useEffect(() => {
    check().then((u) => u && setUpdate(u)).catch(() => {});
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
      <button className="btn primary" disabled={estado === "baixando"} onClick={atualizar}>
        {estado === "baixando" ? "Atualizando…" : "Atualizar agora"}
      </button>
    </div>
  );
}

// ===================================================== métricas do cliente ==
function useSystemStats(): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => invoke<SystemStats>("system_stats").then((s) => alive && setStats(s)).catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return stats;
}

// =============================================== motor de play/sync (lift) ==
function usePlayEngine(server: Server) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");

  const pushLog = (line: string) => setLog((prev) => [...prev.slice(-400), line]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    const load = () =>
      invoke<ServerInfo>("server_info", { server: server.server, profileId: server.profileId })
        .then((i) => !cancelled && setInfo(i))
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const timer = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [server.server, server.profileId]);

  useEffect(() => {
    const un = listen<PlayProgress>("play-progress", (event) => {
      const p = event.payload;
      const label = PLAY_STAGE[p.stage] ?? p.stage;
      setActivity({ label, detail: p.detail, done: p.done, total: p.total });
      pushLog(p.total > 0 ? `${label}: ${p.detail} (${p.done}/${p.total})` : `${label}: ${p.detail}`);
      if (p.stage === "closed" && p.detail.includes("erro")) setError(`${label}: ${p.detail}`);
    });
    return () => { un.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const un = listen<SyncProgress>("sync-progress", (event) => {
      const p = event.payload;
      const label = p.stage === "retire" ? "Removendo" : p.stage === "done" ? "Sincronizado" : "Baixando";
      setActivity({ label, detail: p.path, done: p.done, total: p.total });
      if (p.stage === "download") pushLog(`baixado  ${p.path}`);
      if (p.stage === "retire") pushLog(`removido ${p.path}`);
      if (p.stage === "done") pushLog("— sincronização concluída —");
    });
    return () => { un.then((fn) => fn()); };
  }, []);

  async function playNow() {
    setBusy(true); setError("");
    setActivity({ label: "Preparando", detail: "sincronizando", done: 0, total: 0 });
    try {
      pushLog("— sincronizando antes de jogar —");
      await invoke<PlanSummary>("run_sync", { server: server.server, profileId: server.profileId, dir: server.dir, includeOptional: false });
      pushLog("— preparando o jogo —");
      // Auto-join: entra direto no servidor. Usa o endereço explícito se houver;
      // senão deriva do endereço do Core + porta do status.
      let quickPlay: string | null = null;
      if (localStorage.getItem("aether.launcher.autojoin") !== "off") {
        const explicit = server.gameAddress?.trim();
        if (explicit) {
          quickPlay = explicit;
        } else if (info?.port) {
          try {
            const host = new URL(server.server).hostname;
            if (host) quickPlay = `${host}:${info.port}`;
          } catch { /* URL inválida: lança normal */ }
        }
      }
      const result = await invoke<{ version: string; pid: number }>("play", {
        server: server.server, profileId: server.profileId, dir: server.dir,
        username: server.username, memoryMb: server.memoryMb ?? null, quickPlay,
      });
      pushLog(`Minecraft ${result.version} aberto (pid ${result.pid}). Bom jogo!`);
      setActivity({ label: "Jogo iniciado", detail: "bom jogo!", done: 1, total: 1 });
    } catch (e) {
      setError(String(e)); pushLog(`ERRO: ${e}`); setActivity(null);
    } finally { setBusy(false); }
  }

  async function sync() {
    setBusy(true); setError("");
    setActivity({ label: "Sincronizando", detail: "", done: 0, total: 0 });
    try {
      const result = await invoke<PlanSummary>("run_sync", { server: server.server, profileId: server.profileId, dir: server.dir, includeOptional: false });
      setPlan({ ...result, synced: true, download: [], retire: [] });
    } catch (e) {
      setError(String(e)); pushLog(`ERRO: ${e}`); setActivity(null);
    } finally { setBusy(false); }
  }

  async function check_() {
    setBusy(true); setError("");
    try {
      const result = await invoke<PlanSummary>("check_sync", { server: server.server, profileId: server.profileId, dir: server.dir, includeOptional: false });
      setPlan(result);
      pushLog(`verificado: ${result.download.length} para baixar (${formatBytes(result.download_size)}), ${result.retire.length} para remover, ${result.keep} corretos`);
    } catch (e) {
      setError(String(e));
    } finally { setBusy(false); }
  }

  return { info, plan, busy, activity, log, error, playNow, sync, check_ };
}

type Engine = ReturnType<typeof usePlayEngine>;
type Section = "dashboard" | "content" | "files" | "map" | "servers" | "skin" | "settings";

// Lazy: chamar getCurrentWindow() só na ação evita quebrar fora do Tauri.
const win = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
};

// ================================================================= App ======
export default function App() {
  const [servers, setServers] = useState<Server[]>(loadServers);
  const [active, setActive] = useState<number>(loadActive);
  const [preset, setPreset] = useState<string>(loadPreset);
  const [section, setSection] = useState<Section>("dashboard");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [autojoin, setAutojoin] = useState<boolean>(() => localStorage.getItem("aether.launcher.autojoin") !== "off");
  const [iconPack, setIconPack] = useState<string>(() => localStorage.getItem("aether.launcher.iconpack") || "classico");

  const stats = useSystemStats();

  useEffect(() => {
    applyPreset(preset);
    localStorage.setItem(THEME_KEY, preset);
  }, [preset]);

  useEffect(() => {
    localStorage.setItem("aether.launcher.autojoin", autojoin ? "on" : "off");
  }, [autojoin]);

  useEffect(() => {
    document.documentElement.dataset.iconpack = iconPack;
    localStorage.setItem("aether.launcher.iconpack", iconPack);
  }, [iconPack]);

  function persist(next: Server[], nextActive = active) {
    setServers(next);
    saveServers(next);
    const a = Math.max(0, Math.min(nextActive, next.length - 1));
    setActive(a);
    localStorage.setItem(ACTIVE_KEY, String(a));
  }

  if (servers.length === 0 || editing !== null) {
    const alvo = typeof editing === "number" ? servers[editing] : null;
    return (
      <SetupScreen
        initial={alvo}
        onCancel={servers.length > 0 ? () => setEditing(null) : undefined}
        onSave={(s) => {
          if (typeof editing === "number") persist(servers.map((x, i) => (i === editing ? s : x)), editing);
          else persist([...servers, s], servers.length);
          setEditing(null);
          setSection("dashboard");
        }}
      />
    );
  }

  const current = servers[active] ?? servers[0];
  const patch = (p: Partial<Server>) => persist(servers.map((x, i) => (i === active ? { ...x, ...p } : x)));

  return <Shell
    servers={servers} active={active} current={current} section={section} preset={preset} stats={stats}
    autojoin={autojoin} onAutojoin={setAutojoin} iconPack={iconPack} onIconPack={setIconPack}
    onSection={setSection} onPreset={setPreset} onPatch={patch}
    onSwitch={(i) => { persist(servers, i); setSection("dashboard"); }}
    onAdd={() => setEditing("new")} onEdit={(i) => setEditing(i)}
    onRemove={(i) => persist(servers.filter((_, k) => k !== i), active > i ? active - 1 : active)}
  />;
}

// ================================================================ Shell =====
function Shell(props: {
  servers: Server[]; active: number; current: Server; section: Section; preset: string; stats: SystemStats | null;
  autojoin: boolean; onAutojoin: (v: boolean) => void; iconPack: string; onIconPack: (p: string) => void;
  onSection: (s: Section) => void; onPreset: (p: string) => void; onPatch: (p: Partial<Server>) => void;
  onSwitch: (i: number) => void; onAdd: () => void; onEdit: (i: number) => void; onRemove: (i: number) => void;
}) {
  const { current, section, stats } = props;
  const engine = usePlayEngine(current);
  const online = engine.info?.state === "running";

  return (
    <div className="app">
      {/* titlebar */}
      <div className="titlebar">
        <div className="brand"><BrandLogo size={22} /><span className="wordmark">Aether</span></div>
        <button className="srv-switch" onClick={() => props.onSection("servers")} title="Trocar de servidor">
          <span className={`srv-dot ${online ? "online" : engine.info?.state === "crashed" ? "crashed" : ""}`} />
          <span className="nm">{current.label || current.server}</span>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div className="tb-drag" data-tauri-drag-region />
        <div className="win-ctrls">
          <button onClick={() => win.minimize()} title="Minimizar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg></button>
          <button onClick={() => win.toggleMaximize()} title="Maximizar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg></button>
          <button className="close" onClick={() => win.close()} title="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        </div>
      </div>

      {/* corpo */}
      <div className="body">
        <nav className="sidebar">
          <div className="nav-group">
            <span className="eyebrow">Servidor</span>
            <NavItem icon="dashboard" label="Dashboard" on={section === "dashboard"} onClick={() => props.onSection("dashboard")} />
            <NavItem icon="content" label="Conteúdo" on={section === "content"} onClick={() => props.onSection("content")} />
            <NavItem icon="files" label="Arquivos" on={section === "files"} onClick={() => props.onSection("files")} />
            <NavItem icon="map" label="Mapa" soon on={section === "map"} onClick={() => props.onSection("map")} />
          </div>
          <div className="nav-group">
            <span className="eyebrow">Você</span>
            <NavItem icon="servers" label="Servidores" on={section === "servers"} onClick={() => props.onSection("servers")} />
            <NavItem icon="skin" label="Skin" on={section === "skin"} onClick={() => props.onSection("skin")} />
          </div>
          <div className="sb-foot">
            <NavItem icon="settings" label="Configurações" on={section === "settings"} onClick={() => props.onSection("settings")} />
            <div className="acct-chip">
              <div className="avatar">{current.username.charAt(0).toUpperCase()}</div>
              <div className="txt">
                <div className="who">{current.username}</div>
                <div className="sub">modo offline</div>
              </div>
            </div>
          </div>
        </nav>

        <main className="main">
          <UpdateBanner />
          {section === "dashboard" && <DashboardSection server={current} engine={engine} stats={stats} onConfig={() => props.onSection("settings")} />}
          {section === "content" && <ContentSection server={current} />}
          {section === "files" && <FilesSection server={current} />}
          {section === "map" && <SoonSection title="Mapa" lead="Ver o mundo e as construções direto no launcher." items={["mapa ao vivo via BlueMap no servidor (preferencial)", "ou ler o JourneyMap do seu PC (o que você explorou)", "opcional, ligado por servidor"]} />}
          {section === "servers" && <ServersSection servers={props.servers} active={props.active} onSwitch={props.onSwitch} onAdd={props.onAdd} onEdit={props.onEdit} onRemove={props.onRemove} />}
          {section === "skin" && <SkinSection server={current} onPatch={props.onPatch} />}
          {section === "settings" && <SettingsSection server={current} preset={props.preset} onPreset={props.onPreset} onPatch={props.onPatch} autojoin={props.autojoin} onAutojoin={props.onAutojoin} iconPack={props.iconPack} onIconPack={props.onIconPack} />}
        </main>
      </div>

      {/* status bar */}
      <div className="statusbar">
        <span className="si" title="uso do seu computador"><Icon n="cpu" />CPU {stats ? Math.round(stats.cpu) : "—"}%</span>
        <span className="si" title="uso do seu computador"><Icon n="ram" />RAM {stats ? `${(stats.mem_used / 1024 ** 3).toFixed(1)}/${(stats.mem_total / 1024 ** 3).toFixed(0)} GB` : "—"}</span>
        <span className="sp" />
        {engine.busy && <span className="si">{engine.activity?.label ?? "Trabalhando…"}</span>}
        <span className="si">{STATE_LABEL[engine.info?.state ?? "unknown"] ?? "—"}</span>
        <span className="si">{current.username}</span>
      </div>
    </div>
  );
}

function NavItem({ icon, label, on, soon, onClick }: { icon: IconName; label: string; on: boolean; soon?: boolean; onClick: () => void }) {
  return (
    <button className={`nav ${on ? "on" : ""}`} onClick={onClick}>
      <Icon n={icon} /><span>{label}</span>
      {soon && <span className="soon-tag">breve</span>}
    </button>
  );
}

// ============================================================ Dashboard =====
function DashboardSection({ server, engine, stats, onConfig }: { server: Server; engine: Engine; stats: SystemStats | null; onConfig: () => void }) {
  const { info, plan, busy, activity, log, error } = engine;
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLog) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, showLog]);

  const pct = activity && activity.total > 0 ? Math.round((activity.done / activity.total) * 100) : null;
  const stateClass = info?.state === "running" ? "online" : info?.state === "crashed" ? "crashed" : "offline";
  const memPct = stats ? (stats.mem_used / stats.mem_total) * 100 : 0;
  const pcount = info?.players ?? null;

  return (
    <div className="page">
      <div className="banner">
        <div className="brow">Servidor</div>
        <div className="banner-row">
          <div>
            <h3>{info?.instance_name ?? server.label ?? "Conectando…"}</h3>
            <p className="desc">Sincronize, entre e continue de onde parou.</p>
            <div className="chips">
              {info && <span className="bchip"><span className={`srv-dot ${stateClass}`} />{STATE_LABEL[info.state] ?? info.state}</span>}
              {info && <span className="bchip">{info.channel}</span>}
              {info && <span className="bchip">{info.files} arquivos</span>}
              {info && <span className="bchip">{formatBytes(info.total_size)}</span>}
            </div>
          </div>
          <div className="cta">
            <button className="g-btn" title="Configurações" disabled={busy} onClick={onConfig}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>
            </button>
            <button className="play" disabled={busy} onClick={engine.playNow}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5v14l11-7z" /></svg>
              {busy ? "Trabalhando…" : "Jogar"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid widgets">
        <div className="card widget">
          <div className="wl"><Icon n="players" />Jogadores</div>
          <div className="wv tnum">{pcount ? pcount.online : "—"}<small> / {pcount ? pcount.max : "—"}</small></div>
          <div className="hint" style={{ marginTop: 10 }}>{pcount ? "online agora" : info?.state === "running" ? "consultando…" : "servidor offline"}</div>
        </div>
        <div className="card widget">
          <div className="wl"><Icon n="ping" />Ping</div>
          <div className="wv tnum">{info?.latency_ms != null ? info.latency_ms : "—"}<small> ms</small></div>
          <div className="hint" style={{ marginTop: 10 }}>até o servidor</div>
        </div>
        <div className="card widget">
          <div className="wl"><Icon n="cpu" />CPU · seu PC</div>
          <div className="wv tnum">{stats ? Math.round(stats.cpu) : "—"}<small>%</small></div>
          <div className="mini-track"><i style={{ width: `${stats ? Math.min(100, stats.cpu) : 0}%` }} /></div>
        </div>
        <div className="card widget">
          <div className="wl"><Icon n="ram" />RAM · seu PC</div>
          <div className="wv tnum">{stats ? (stats.mem_used / 1024 ** 3).toFixed(1) : "—"}<small> / {stats ? (stats.mem_total / 1024 ** 3).toFixed(0) : "—"} GB</small></div>
          <div className="mini-track"><i style={{ width: `${memPct}%` }} /></div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" disabled={busy} onClick={engine.sync}>Sincronizar</button>
        <button className="btn" disabled={busy} onClick={engine.check_}><Icon n="refresh" />Verificar</button>
      </div>

      {activity && (
        <div className="activity">
          <div className="activity-head">
            <span className="activity-label">{activity.label}</span>
            <span className="activity-detail">{activity.detail}</span>
            {pct !== null && <span className="activity-pct">{pct}%</span>}
          </div>
          <div className="progress-track">
            <div className={`progress-fill ${pct === null ? "indeterminate" : ""}`} style={pct !== null ? { width: `${pct}%` } : undefined} />
          </div>
        </div>
      )}

      {plan?.synced && !busy && !activity && <p className="ok">✔ Tudo sincronizado com o servidor.</p>}
      {error && <p className="error">{error}</p>}

      <div className="log-toggle">
        <button className="btn ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? "▾ Ocultar detalhes" : "▸ Mostrar detalhes"}</button>
      </div>
      {showLog && <div className="log" ref={logRef}>{log.join("\n") || "Pronto. Clique em Jogar para sincronizar e abrir o jogo."}</div>}
    </div>
  );
}

// =============================================================== Setup ======
function SetupScreen({ initial, onSave, onCancel }: { initial: Server | null; onSave: (s: Server) => void; onCancel?: () => void }) {
  const [server, setServer] = useState(initial?.server ?? "");
  const [profileId, setProfileId] = useState(initial?.profileId ?? "");
  const [dir, setDir] = useState(initial?.dir ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [gameAddress, setGameAddress] = useState(initial?.gameAddress ?? "");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);

  async function pickDir() {
    const chosen = await open({ directory: true, title: "Pasta do Minecraft (.minecraft)" });
    if (typeof chosen === "string") setDir(chosen);
  }

  async function save() {
    setError(""); setTesting(true);
    try {
      const info = await invoke<ServerInfo>("server_info", { server: server.trim(), profileId: profileId.trim() });
      onSave({ server: server.trim(), profileId: profileId.trim(), dir, username: username.trim(), memoryMb: initial?.memoryMb, label: info.instance_name, gameAddress: gameAddress.trim() || undefined });
    } catch (e) {
      setError(String(e));
    } finally { setTesting(false); }
  }

  const valido = server.trim() && profileId.trim() && dir && username.trim();

  return (
    <div className="setup">
      <div className="brand"><BrandLogo size={30} /><h1>{initial ? "Editar servidor" : "Aether Launcher"}</h1></div>
      <div className="card">
        <div className="field">
          <label>Endereço do servidor</label>
          <input placeholder="http://192.168.1.10:8600" value={server} onChange={(e) => setServer(e.target.value)} />
        </div>
        <div className="field">
          <label>Código do perfil (peça ao admin)</label>
          <input placeholder="ex.: 2f1c93e869ee4563b98093abd9ad54b6" value={profileId} onChange={(e) => setProfileId(e.target.value)} />
        </div>
        <div className="field">
          <label>Nome do jogador</label>
          <input placeholder="Seu nick no jogo" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label>Endereço do servidor de jogo (opcional)</label>
          <input placeholder="ex.: mc.meuserver.com  ou  192.168.1.10:25565" value={gameAddress} onChange={(e) => setGameAddress(e.target.value)} />
          <p className="hint">Para entrar direto no servidor ao clicar em Jogar. Use o mesmo endereço que você digita no Minecraft. Vazio = o launcher tenta sozinho.</p>
        </div>
        <div className="field">
          <label>Pasta do jogo</label>
          <div className="row">
            <input placeholder="C:\...\.minecraft" value={dir} readOnly />
            <button className="btn" onClick={pickDir}>Escolher…</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ marginTop: 6 }}>
          {onCancel && <button className="btn" onClick={onCancel} disabled={testing}>Cancelar</button>}
          <button className="btn primary lg" style={{ flex: 1 }} disabled={!valido || testing} onClick={save}>
            {testing ? "Verificando…" : initial ? "Salvar" : "Conectar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================ Servidores ====
function ServersSection({ servers, active, onSwitch, onAdd, onEdit, onRemove }: {
  servers: Server[]; active: number; onSwitch: (i: number) => void; onAdd: () => void; onEdit: (i: number) => void; onRemove: (i: number) => void;
}) {
  return (
    <div className="page">
      <div className="page-head">
        <h2>Servidores</h2>
        <div className="actions"><button className="btn primary" onClick={onAdd}>+ Adicionar</button></div>
      </div>
      <div className="srv-grid">
        {servers.map((s, i) => (
          <div key={i} className={`srv-card ${i === active ? "active" : ""}`}>
            <button className="srv-body" onClick={() => onSwitch(i)}>
              <div className="srv-banner">
                {i === active && <span className="srv-badge">ativo</span>}
                <span className="srv-ico">{(s.label || s.server).charAt(0).toUpperCase()}</span>
              </div>
              <div className="srv-name" title={s.label || s.server}>{s.label || s.server}</div>
              <div className="srv-meta">
                <span className="srv-line"><Icon n="server" />{s.server.replace(/^https?:\/\//, "")}</span>
                <span className="srv-line"><Icon n="skin" />{s.username}</span>
              </div>
            </button>
            <div className="srv-actions">
              <button className="btn ghost mini" onClick={() => onEdit(i)}>Editar</button>
              {servers.length > 1 && <button className="btn ghost mini danger" onClick={() => onRemove(i)}>Remover</button>}
            </div>
          </div>
        ))}
        <button className="srv-add" onClick={onAdd}>
          <span className="srv-add-plus">+</span>
          Adicionar servidor
        </button>
      </div>
    </div>
  );
}

// ============================================================== Arquivos ====
interface FsEntry { name: string; rel: string; is_dir: boolean; size: number; }
interface ManagedDto { files: string[]; managed_dirs: { dir: string; patterns: string[]; recursive: boolean }[]; }
interface ManagedInfo { files: Set<string>; dirs: { dir: string; patterns: string[]; recursive: boolean }[]; online: boolean; }

const TEXT_EXT = new Set(["txt", "json", "json5", "toml", "cfg", "conf", "ini", "properties", "yml", "yaml", "log", "md", "mcmeta", "lang", "csv", "xml", "html", "css", "js", "sh", "bat"]);
function isEditable(name: string, size: number): boolean {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return TEXT_EXT.has(ext) && size <= 1024 * 1024;
}
function joinRel(base: string, name: string): string { return base ? `${base}/${name}` : name; }

interface TrashItem { id: string; rel: string; name: string; is_dir: boolean; ts: number; }

function agoLabel(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "agora há pouco";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} dias`;
}

const ListIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>;
const GridIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;

function FilesSection({ server }: { server: Server }) {
  const [tab, setTab] = useState<"files" | "trash">("files");
  const [view, setView] = useState<"list" | "grid">("list");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [managed, setManaged] = useState<ManagedInfo>({ files: new Set(), dirs: [], online: true });
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<null | "file" | "folder">(null);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<null | { rel: string; name: string; content: string; readOnly: boolean }>(null);

  async function list(p: string) {
    setError("");
    try {
      const rows = await invoke<FsEntry[]>("fs_list", { dir: server.dir, rel: p });
      setEntries(rows); setPath(p);
    } catch (e) { setError(String(e)); }
  }

  async function loadTrash() {
    try { setTrash(await invoke<TrashItem[]>("fs_trash_list", { dir: server.dir })); }
    catch (e) { setError(String(e)); }
  }

  useEffect(() => {
    let cancelled = false;
    invoke<ManagedDto>("fs_manifest", { server: server.server, profileId: server.profileId })
      .then((m) => { if (!cancelled) setManaged({ files: new Set(m.files), dirs: m.managed_dirs, online: true }); })
      .catch(() => { if (!cancelled) setManaged({ files: new Set(), dirs: [], online: false }); });
    list("");
    loadTrash();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.server, server.profileId, server.dir]);

  const isManagedFile = (rel: string) => managed.files.has(rel);
  const folderHasServer = (rel: string) =>
    managed.dirs.some((m) => m.dir === rel || m.dir.startsWith(rel + "/")) ||
    [...managed.files].some((f) => f === rel || f.startsWith(rel + "/"));
  const inRetireZone = managed.dirs.some((m) => m.dir === path);

  async function doDelete(e: FsEntry) {
    if (!confirm(`Mover "${e.name}" para a lixeira do launcher?`)) return;
    setBusy(true);
    try { await invoke("fs_delete", { dir: server.dir, rel: e.rel }); await list(path); await loadTrash(); }
    catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  async function openEntry(e: FsEntry) {
    if (e.is_dir) { list(e.rel); return; }
    if (!isEditable(e.name, e.size)) return;
    setBusy(true); setError("");
    try {
      const content = await invoke<string>("fs_read", { dir: server.dir, rel: e.rel });
      setEditing({ rel: e.rel, name: e.name, content, readOnly: isManagedFile(e.rel) });
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    try { await invoke("fs_write", { dir: server.dir, rel: editing.rel, contents: editing.content }); setEditing(null); await list(path); }
    catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) { setError('Nome inválido: evite \\ / : * ? " < > |'); return; }
    setBusy(true); setError("");
    try {
      const rel = joinRel(path, name);
      await invoke(creating === "folder" ? "fs_mkdir" : "fs_touch", { dir: server.dir, rel });
      setCreating(null); setNewName(""); await list(path);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  async function reveal() {
    try { await invoke("fs_reveal", { dir: server.dir, rel: path }); }
    catch (err) { setError(String(err)); }
  }

  async function restore(id: string) {
    setBusy(true); setError("");
    try { await invoke("fs_trash_restore", { dir: server.dir, id }); await loadTrash(); await list(path); }
    catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  async function purge(id: string) {
    if (!confirm("Apagar de vez? Não dá para desfazer.")) return;
    setBusy(true);
    try { await invoke("fs_trash_purge", { dir: server.dir, id }); await loadTrash(); }
    catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  async function emptyTrash() {
    if (!confirm("Esvaziar a lixeira de vez? Não dá para desfazer.")) return;
    setBusy(true);
    try { await invoke("fs_trash_empty", { dir: server.dir }); await loadTrash(); }
    catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  const crumbs = path ? path.split("/") : [];

  if (editing) {
    return (
      <div className="page">
        <div className="page-head">
          <h2>{editing.name}{editing.readOnly && <span className="badge" style={{ marginLeft: 8 }}>servidor · leitura</span>}</h2>
          <div className="actions">
            <button className="btn" onClick={() => setEditing(null)}>Voltar</button>
            {!editing.readOnly && <button className="btn primary" disabled={busy} onClick={saveEdit}>Salvar</button>}
          </div>
        </div>
        <p className="meta">{editing.rel}</p>
        <textarea className="code-edit" value={editing.content} readOnly={editing.readOnly} spellCheck={false} onChange={(ev) => setEditing({ ...editing, content: ev.target.value })} />
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Arquivos</h2>
        {tab === "files" && (
          <div className="actions">
            <div className="vtoggle">
              <button className={view === "list" ? "on" : ""} title="Lista" onClick={() => setView("list")}>{ListIcon}</button>
              <button className={view === "grid" ? "on" : ""} title="Grade" onClick={() => setView("grid")}>{GridIcon}</button>
            </div>
            <button className="btn ghost" onClick={reveal}>Abrir no explorador</button>
          </div>
        )}
      </div>

      <div className="file-tabs">
        <button className={`file-tab ${tab === "files" ? "on" : ""}`} onClick={() => setTab("files")}>Arquivos</button>
        <button className={`file-tab ${tab === "trash" ? "on" : ""}`} onClick={() => { setTab("trash"); loadTrash(); }}>
          Lixeira {trash.length > 0 && <span className="n">{trash.length}</span>}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {tab === "files" ? (
        <>
          <div className="crumbs">
            <button className="crumb" onClick={() => list("")}>Pasta do jogo</button>
            {crumbs.map((c, i) => (
              <span key={i}><span className="crumb-sep">›</span><button className="crumb" onClick={() => list(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>
            ))}
          </div>

          {!managed.online && <p className="hint" style={{ marginBottom: 10 }}>Sem conexão com o servidor: não dá para marcar quais arquivos são sincronizados. Cuidado ao editar.</p>}
          {inRetireZone && <div className="warn-box">⚠ Esta pasta é sincronizada pelo servidor. Arquivos que você adicionar aqui podem ser removidos na próxima sincronização.</div>}

          <div className="toolbar">
            {path && <button onClick={() => list(crumbs.slice(0, -1).join("/"))}>↑ Voltar</button>}
            <button disabled={busy} onClick={() => { setCreating("folder"); setNewName(""); }}>+ Pasta</button>
            <button disabled={busy} onClick={() => { setCreating("file"); setNewName(""); }}>+ Arquivo</button>
            <button className="ghost" disabled={busy} onClick={() => list(path)}>Atualizar</button>
          </div>

          {creating && (
            <div className="row create-row">
              <input autoFocus placeholder={creating === "folder" ? "nome da pasta" : "nome do arquivo (ex.: notas.txt)"} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
              <button className="btn primary" disabled={busy || !newName.trim()} onClick={create}>Criar</button>
              <button className="btn" onClick={() => setCreating(null)}>Cancelar</button>
            </div>
          )}

          {entries.length === 0 && <p className="meta">Pasta vazia.</p>}

          {view === "list" ? (
            <div className="file-list">
              {entries.map((e) => {
                const locked = e.is_dir ? folderHasServer(e.rel) : isManagedFile(e.rel);
                const editable = !e.is_dir && isEditable(e.name, e.size);
                return (
                  <div key={e.rel} className="file-row">
                    <button className="file-main" onClick={() => openEntry(e)} disabled={!e.is_dir && !editable}>
                      <span className={`file-ico ${e.is_dir ? "dir" : ""}`}><Icon n={e.is_dir ? "folder" : "file"} /></span>
                      <span className="file-name">{e.name}</span>
                      {locked && <span className="badge" title="Sincronizado pelo servidor">servidor</span>}
                      {!e.is_dir && <span className="file-size">{formatBytes(e.size)}</span>}
                    </button>
                    {!locked && <button className="file-del" title="Mover para a lixeira" disabled={busy} onClick={() => doDelete(e)}><Icon n="trash" /></button>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="fgrid">
              {entries.map((e) => {
                const locked = e.is_dir ? folderHasServer(e.rel) : isManagedFile(e.rel);
                const editable = !e.is_dir && isEditable(e.name, e.size);
                return (
                  <button key={e.rel} className="gtile" disabled={!e.is_dir && !editable} onClick={() => openEntry(e)}>
                    {locked && <span className="glock" title="Sincronizado pelo servidor"><Icon n="lock" /></span>}
                    {!locked && <span className="gdel" title="Mover para a lixeira" onClick={(ev) => { ev.stopPropagation(); doDelete(e); }}><Icon n="trash" /></span>}
                    <span className={`gi ${e.is_dir ? "dir" : ""}`}><Icon n={e.is_dir ? "folder" : "file"} /></span>
                    <span className="gn" title={e.name}>{e.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          <p className="hint" style={{ marginTop: 14 }}>Arquivos marcados <b>servidor</b> são sincronizados e ficam travados. O que você apaga vai para a lixeira (recuperável), nunca é apagado de vez.</p>
        </>
      ) : (
        <>
          <div className="trash-head">
            <span className="eyebrow">Itens removidos — recuperáveis antes de sumir de vez</span>
            {trash.length > 0 && <button className="btn ghost danger" disabled={busy} onClick={emptyTrash}>Esvaziar lixeira</button>}
          </div>
          {trash.length === 0 && <p className="meta">Lixeira vazia.</p>}
          {trash.map((t) => (
            <div key={t.id} className="trow">
              <span className={`ti ${t.is_dir ? "dir" : ""}`}><Icon n={t.is_dir ? "folder" : "file"} /></span>
              <span className="tn">{t.name}</span>
              <span className="tw">{agoLabel(t.ts)} · de {t.rel.includes("/") ? t.rel.slice(0, t.rel.lastIndexOf("/")) : "raiz"}</span>
              <div className="tacts">
                <button className="btn mini" disabled={busy} onClick={() => restore(t.id)}>Restaurar</button>
                <button className="btn mini danger" disabled={busy} onClick={() => purge(t.id)}>Excluir</button>
              </div>
            </div>
          ))}
          <p className="hint" style={{ marginTop: 14 }}>A lixeira é a pasta <b>.aether-trash</b> dentro do jogo. Tudo que você exclui fica aqui, recuperável, antes de sumir de vez.</p>
        </>
      )}
    </div>
  );
}

// =========================================================== Configurações ==
const ICON_PACKS: { id: string; label: string }[] = [
  { id: "classico", label: "Clássico" },
  { id: "neutro", label: "Neutro" },
  { id: "solido", label: "Sólido" },
  { id: "contraste", label: "Contraste" },
  { id: "pastel", label: "Pastel" },
  { id: "destaque", label: "Destaque" },
];

function SettingsSection({ server, preset, onPreset, onPatch, autojoin, onAutojoin, iconPack, onIconPack }: {
  server: Server; preset: string; onPreset: (p: string) => void; onPatch: (p: Partial<Server>) => void;
  autojoin: boolean; onAutojoin: (v: boolean) => void; iconPack: string; onIconPack: (p: string) => void;
}) {
  const memGb = (server.memoryMb ?? DEFAULT_MEMORY_MB) / 1024;

  async function pickDir() {
    const chosen = await open({ directory: true, title: "Pasta do Minecraft (.minecraft)" });
    if (typeof chosen === "string") onPatch({ dir: chosen });
  }

  return (
    <div className="page">
      <h2>Configurações</h2>
      <div className="meta">Ajustes do launcher e do jogo</div>

      <span className="eyebrow set-eyebrow">Aparência</span>
      <div className="setting">
        <label>Tema — os mesmos do painel do servidor</label>
        <div className="theme-grid">
          {Object.entries(THEMES).map(([id, t]) => (
            <button key={id} className={`tcard ${preset === id ? "on" : ""}`} title={t.label} onClick={() => onPreset(id)}>
              <span className="tprev" style={{ background: t.tokens.bg, borderColor: t.tokens.border }}>
                <i className="tp-s" style={{ background: t.tokens.surface2 }} />
                <i className="tp-d" style={{ background: t.tokens.accent }} />
              </span>
              <span className="tname">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="setting">
        <label>Ícones de arquivo</label>
        <div className="iconpack-grid">
          {ICON_PACKS.map((p) => (
            <button key={p.id} className={`ipk ${iconPack === p.id ? "on" : ""}`} data-iconpack={p.id} onClick={() => onIconPack(p.id)}>
              <span className="ipk-prev"><span className="file-ico dir"><Icon n="folder" /></span><span className="file-ico"><Icon n="file" /></span></span>
              {p.label}
            </button>
          ))}
        </div>
        <p className="hint">Muda como pastas e arquivos aparecem no gerenciador de arquivos.</p>
      </div>

      <span className="eyebrow set-eyebrow">Jogo</span>
      <div className="setting" style={{ paddingTop: 4, paddingBottom: 4 }}>
        <div className="set-row">
          <div className="txt"><h5>Entrar direto no servidor</h5><p>Ao clicar em Jogar, entra no servidor pulando o menu do Minecraft.</p></div>
          <div className="ctl"><button className={`toggle ${autojoin ? "on" : ""}`} aria-label="Entrar direto no servidor" onClick={() => onAutojoin(!autojoin)} /></div>
        </div>
        <div className="set-row">
          <div className="txt"><h5>Memória do jogo</h5><p>Quanto o Minecraft pode usar de RAM. 4–8 GB serve à maioria dos servidores com mods.</p></div>
          <div className="ctl" style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 240 }}>
            <input type="range" min={1} max={16} step={0.5} value={memGb} onChange={(e) => onPatch({ memoryMb: Math.round(Number(e.target.value) * 1024) })} />
            <b className="tnum" style={{ whiteSpace: "nowrap" }}>{memGb.toFixed(1)} GB</b>
          </div>
        </div>
        <div className="set-row">
          <div className="txt"><h5>Pasta do jogo</h5><p>Onde os arquivos do jogo ficam neste computador.</p></div>
          <div className="ctl row"><input type="text" style={{ width: 240 }} value={server.dir} readOnly /><button className="btn" onClick={pickDir}>Escolher…</button></div>
        </div>
      </div>
    </div>
  );
}

// ================================================================ Skin ======
function SkinSection({ server, onPatch }: { server: Server; onPatch: (p: Partial<Server>) => void }) {
  const [nick, setNick] = useState(server.username);
  useEffect(() => setNick(server.username), [server.username]);

  return (
    <div className="page">
      <h2>Skin</h2>
      <div className="meta">Sua aparência dentro do jogo</div>

      <div className="skin-split">
        <div className="skin-stage">
          <div className="mc">
            <div className="part head"><div className="face"><i /><i /></div></div>
            <div className="arms"><span className="arm" /><span className="arm" /></div>
            <div className="part torso" />
            <div className="legs"><span className="leg" /><span className="leg" /></div>
          </div>
        </div>
        <div>
          <div className="set-row">
            <div className="txt"><h5>Nome do jogador</h5><p>A grafia precisa ser igual à da whitelist do servidor (maiúsculas contam, em modo offline).</p></div>
            <div className="ctl row">
              <input type="text" style={{ width: 160 }} value={nick} onChange={(e) => setNick(e.target.value)} />
              <button className="btn primary" disabled={!nick.trim() || nick.trim() === server.username} onClick={() => onPatch({ username: nick.trim() })}>Salvar</button>
            </div>
          </div>
          <div className="set-row">
            <div className="txt"><h5>Skin personalizada</h5><p>Chega numa próxima atualização.</p></div>
            <div className="ctl"><button className="btn" disabled>Enviar skin</button></div>
          </div>
          <div className="soon" style={{ marginTop: 16 }}>
            Em servidores no modo offline, a skin só aparece para os outros com um mod de skins (ex.: <code>CustomSkinLoader</code>) no pacote. O launcher vai cuidar de instalar e apontar para a sua skin quando o servidor tiver esse suporte.
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================== Conteúdo ====
interface ModItem { project_id: string; slug: string; title: string; description: string; author: string; downloads: number; icon_url: string | null; categories: string[]; }
interface ContentProgress { name: string; done: number; total: number; }
type ContentKind = "shader" | "resourcepack";

function fmtDownloads(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}
function installedKey(dir: string, kind: string) { return `aether.launcher.content.${dir}::${kind}`; }
function loadInstalled(dir: string, kind: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(installedKey(dir, kind)) ?? "{}"); } catch { return {}; }
}

function ContentSection({ server }: { server: Server }) {
  const [kind, setKind] = useState<ContentKind>("shader");
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState<string | null>(null);
  const [useCompat, setUseCompat] = useState(true);
  const [results, setResults] = useState<ModItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState<Record<string, string>>(() => loadInstalled(server.dir, "shader"));
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<ContentProgress | null>(null);

  useEffect(() => {
    invoke<{ minecraft: string | null }>("content_context", { server: server.server, profileId: server.profileId })
      .then((c) => setGameVersion(c.minecraft))
      .catch(() => setGameVersion(null));
  }, [server.server, server.profileId]);

  useEffect(() => { setInstalled(loadInstalled(server.dir, kind)); }, [server.dir, kind]);

  useEffect(() => {
    const un = listen<ContentProgress>("content-progress", (e) => setProgress(e.payload));
    return () => { un.then((fn) => fn()); };
  }, []);

  async function doSearch() {
    setLoading(true); setError("");
    try {
      const rows = await invoke<ModItem[]>("modrinth_search", { kind, query, gameVersion: useCompat ? gameVersion : null });
      setResults(rows);
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  }

  // Busca quando troca de aba, alterna compatibilidade ou a versão do servidor carrega.
  useEffect(() => { doSearch(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, useCompat, gameVersion]);

  async function install(item: ModItem) {
    setInstalling(item.project_id); setError(""); setProgress(null);
    try {
      const filename = await invoke<string>("modrinth_install", { projectId: item.project_id, kind, gameVersion: useCompat ? gameVersion : null, dir: server.dir });
      const next = { ...installed, [item.project_id]: filename };
      setInstalled(next); localStorage.setItem(installedKey(server.dir, kind), JSON.stringify(next));
    } catch (e) { setError(String(e)); } finally { setInstalling(null); setProgress(null); }
  }

  async function remove(item: ModItem) {
    const fname = installed[item.project_id];
    if (!fname) return;
    setInstalling(item.project_id); setError("");
    try {
      await invoke("content_remove", { kind, filename: fname, dir: server.dir });
      const next = { ...installed }; delete next[item.project_id];
      setInstalled(next); localStorage.setItem(installedKey(server.dir, kind), JSON.stringify(next));
    } catch (e) { setError(String(e)); } finally { setInstalling(null); }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  const isShader = kind === "shader";

  return (
    <div className="page">
      <h2>Conteúdo</h2>
      <div className="meta">Shaders e texturas do Modrinth — instalam do lado do cliente, sem afetar o servidor.</div>

      <div className="content-tabs">
        <button className={`content-tab ${isShader ? "on" : ""}`} onClick={() => setKind("shader")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg>Shaders
        </button>
        <button className={`content-tab ${!isShader ? "on" : ""}`} onClick={() => setKind("resourcepack")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></svg>Texturas
        </button>
      </div>

      <div className="c-bar">
        <div className="c-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input placeholder={`Buscar ${isShader ? "shaders" : "texturas"} no Modrinth…`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doSearch()} />
        </div>
        {gameVersion && (
          <label className="c-compat"><input type="checkbox" checked={useCompat} onChange={(e) => setUseCompat(e.target.checked)} />só compatível com {gameVersion}</label>
        )}
        <button className="btn" disabled={loading} onClick={doSearch}>Buscar</button>
      </div>

      {error && <p className="error">{error}</p>}

      {installing && (
        <div className="c-progress">
          <div className="cp-head"><span className="cp-name">Instalando {progress?.name ?? "…"}</span>{pct !== null && <span className="cp-pct">{pct}%</span>}</div>
          <div className="progress-track"><div className={`progress-fill ${pct === null ? "indeterminate" : ""}`} style={pct !== null ? { width: `${pct}%` } : undefined} /></div>
        </div>
      )}

      {loading && results.length === 0 ? (
        <div className="c-empty">Buscando…</div>
      ) : results.length === 0 ? (
        <div className="c-empty">Nada encontrado{useCompat && gameVersion ? ` para ${gameVersion}` : ""}.</div>
      ) : (
        <div className="mod-grid">
          {results.map((item) => {
            const isInstalled = !!installed[item.project_id];
            const busyThis = installing === item.project_id;
            return (
              <div key={item.project_id} className="mod-card">
                {item.icon_url ? <img className="mod-ic" src={item.icon_url} alt="" /> : <div className="mod-ic"><Icon n="content" /></div>}
                <div className="mod-body">
                  <h4 title={item.title}>{item.title}</h4>
                  <div className="mod-by">por {item.author}</div>
                  <p className="mod-desc">{item.description}</p>
                  <div className="mod-foot">
                    <span className="mod-stat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" /></svg>{fmtDownloads(item.downloads)}</span>
                    <div className="mod-act">
                      {isInstalled ? (
                        <>
                          <button className="btn mini done" disabled>✓ Instalado</button>
                          <button className="btn mini ghost" disabled={busyThis} onClick={() => remove(item)}>Remover</button>
                        </>
                      ) : (
                        <button className="btn mini primary" disabled={!!installing} onClick={() => install(item)}>{busyThis ? "Instalando…" : "Instalar"}</button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="hint" style={{ marginTop: 14 }}>Instala em <b>{isShader ? "shaderpacks/" : "resourcepacks/"}</b>. No jogo, ative em Opções ▸ {isShader ? "Shaders (precisa do Iris/OptiFine)" : "Pacotes de Recursos"}.</p>
    </div>
  );
}

// ============================================================== Em breve ====
function SoonSection({ title, lead, items }: { title: string; lead: string; items: string[] }) {
  return (
    <div className="page">
      <h2>{title}</h2>
      <div className="meta">{lead}</div>
      <div className="soon">
        <h4>Em construção</h4>
        <p className="hint">Esta parte do redesign chega numa próxima atualização — o launcher se atualiza sozinho.</p>
        <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
      </div>
    </div>
  );
}
