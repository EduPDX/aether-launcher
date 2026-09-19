import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { SkinViewer } from "skinview3d";
import "./App.css";
import "./VisualRefresh.css";
import { InviteSetup, ServerCover, invitationPatch, type Invitation } from "./InviteSetup";
import { PlayerRoster, type OnlinePlayers } from "./PlayerRoster";

// ============================================================== tipos =======
export interface Server {
  invitation?: string;
  instanceId?: string;
  autojoin?: boolean;
  coverUrl?: string;
  coverCredit?: string;
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
  /** URL do mapa web (BlueMap/Dynmap) para embutir na tela Mapa. */
  mapUrl?: string;
}

interface ServerInfo {
  instance_name: string;
  profile_name: string;
  channel: string;
  files: number;
  total_size: number;
  state: string;
  port?: number | null;
  players?: OnlinePlayers | null;
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
  ambar: { label: "Âmbar", dark: true, tokens: { bg: "#191204", surface: "#271b08", surface2: "#33240c", surface3: "#443110", border: "#5a4116", text: "#fef3c7", muted: "#c4a56a", accent: "#f59e0b", accentDim: "#d97706", danger: "#ef4444", warn: "#fde047", info: "#38bdf8" } },
  indigo: { label: "Índigo", dark: true, tokens: { bg: "#0d0f2b", surface: "#171a45", surface2: "#1f2356", surface3: "#2a2f6e", border: "#373d85", text: "#e0e7ff", muted: "#9aa2d4", accent: "#818cf8", accentDim: "#6366f1", danger: "#fb7185", warn: "#fbbf24", info: "#38bdf8" } },
  carbono: { label: "Carbono", dark: true, tokens: { bg: "#050507", surface: "#0e0e12", surface2: "#16161c", surface3: "#202028", border: "#2c2c36", text: "#e8e8ef", muted: "#9a9aa8", accent: "#38bdf8", accentDim: "#0ea5e9", danger: "#f87171", warn: "#fbbf24", info: "#818cf8" } },
  rose: { label: "Rosé (claro)", dark: false, tokens: { bg: "#fff1f2", surface: "#ffffff", surface2: "#ffe4e6", surface3: "#fecdd3", border: "#fda4af", text: "#4c0519", muted: "#9f5a6a", accent: "#e11d48", accentDim: "#be123c", danger: "#dc2626", warn: "#b45309", info: "#2563eb" } },
  menta: { label: "Menta (claro)", dark: false, tokens: { bg: "#f0fdf4", surface: "#ffffff", surface2: "#dcfce7", surface3: "#bbf7d0", border: "#86efac", text: "#052e16", muted: "#4d7c5a", accent: "#059669", accentDim: "#047857", danger: "#dc2626", warn: "#b45309", info: "#2563eb" } },
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

type IconName = "dashboard" | "content" | "files" | "map" | "servers" | "skin" | "settings" | "cpu" | "ram" | "server" | "play" | "refresh" | "players" | "ping" | "folder" | "file" | "trash" | "lock" | "download" | "mods" | "worlds" | "friends" | "console" | "help" | "bell" | "image" | "archive" | "code" | "script";

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
    mods: <><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></>,
    worlds: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
    friends: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 6M18 14.4a5.5 5.5 0 0 1 3 5.6" /></>,
    console: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.7-2.5 2-2.5 3.5M12 17h.01" /></>,
    bell: <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a2 2 0 0 0 3.4 0" />,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
    archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></>,
    code: <><path d="M14 2v6h6M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" /><path d="m9.5 12.5-1.5 2 1.5 2M14.5 12.5l1.5 2-1.5 2" /></>,
    script: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h5M8 12h8M8 16h6" /></>,
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
        .catch((e) => { if (!cancelled) { setInfo(null); setError(String(e)); } });
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
      if (server.autojoin ?? (localStorage.getItem("aether.launcher.autojoin") !== "off")) {
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
type Section = "dashboard" | "content" | "files" | "map" | "servers" | "skin" | "settings" | "mods" | "worlds" | "friends" | "help" | "downloads" | "console";

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

  const inviteKeys = JSON.stringify(servers.filter(s => s.invitation).map(s => ({ invitation: s.invitation!, instanceId: s.instanceId, profileId: s.profileId })));
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const links = JSON.parse(inviteKeys) as { invitation: string; instanceId?: string; profileId: string }[];
      const updates = await Promise.all(links.map(async entry => {
        try {
          const data = await invoke<Invitation>("resolve_launcher_invite", { invitation: entry.invitation });
          if (data.profile_id !== entry.profileId || (entry.instanceId && data.instance_id !== entry.instanceId)) return null;
          return { invitation: entry.invitation, patch: invitationPatch(data) };
        } catch { return null; }
      }));
      if (cancelled || !updates.some(Boolean)) return;
      setServers(previous => {
        const next = previous.map(s => {
          const update = updates.find(u => u?.invitation === s.invitation);
          return update ? { ...s, ...update.patch } : s;
        });
        if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
        saveServers(next); return next;
      });
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [inviteKeys]);

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
    autojoin={current.autojoin ?? autojoin} onAutojoin={(v) => { setAutojoin(v); patch({ autojoin: v }); }} iconPack={iconPack} onIconPack={setIconPack}
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
  const [palette, setPalette] = useState(false);
  const dlCount = engine.activity ? 1 : 0;
  const problems = engine.error ? 1 : 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const commands: PaletteCommand[] = [
    { label: "Dashboard", icon: "dashboard", run: () => props.onSection("dashboard") },
    { label: "Conteúdo", icon: "content", run: () => props.onSection("content") },
    { label: "Arquivos", icon: "files", run: () => props.onSection("files") },
    { label: "Mapa", icon: "map", run: () => props.onSection("map") },
    { label: "Servidores", icon: "servers", run: () => props.onSection("servers") },
    { label: "Skin", icon: "skin", run: () => props.onSection("skin") },
    { label: "Configurações", icon: "settings", run: () => props.onSection("settings") },
    { label: "Jogar", hint: "sincroniza e abre o jogo", icon: "play", run: () => { void engine.playNow(); } },
    { label: "Sincronizar", icon: "refresh", run: () => { void engine.sync(); } },
    { label: "Adicionar servidor", icon: "servers", run: () => props.onAdd() },
  ];

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
        <button className="cmd" onClick={() => setPalette(true)} title="Buscar (Ctrl+K)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <span className="cmd-lbl">Buscar mods, arquivos, ajustes…</span><kbd>Ctrl K</kbd>
        </button>
        <div className="tb-drag" data-tauri-drag-region />
        <div className="tb-right">
          <button className="icon-btn" onClick={() => props.onSection("downloads")} title="Downloads">
            <Icon n="download" />
          </button>
          <button className="icon-btn" onClick={() => props.onSection("console")} title="Notificações">
            {problems > 0 && <span className="dot-badge" />}
            <Icon n="bell" />
          </button>
          <div className="tb-avatar">{current.username.charAt(0).toUpperCase()}</div>
        </div>
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
            <NavItem icon="mods" label="Mods" on={section === "mods"} onClick={() => props.onSection("mods")} />
            <NavItem icon="content" label="Conteúdo" on={section === "content"} onClick={() => props.onSection("content")} />
            <NavItem icon="worlds" label="Mundos" on={section === "worlds"} onClick={() => props.onSection("worlds")} />
            <NavItem icon="map" label="Mapa" on={section === "map"} onClick={() => props.onSection("map")} />
            <NavItem icon="files" label="Arquivos" on={section === "files"} onClick={() => props.onSection("files")} />
            <NavItem icon="console" label="Console" on={section === "console"} onClick={() => props.onSection("console")} />
          </div>
          <div className="nav-group">
            <span className="eyebrow">Você</span>
            <NavItem icon="download" label="Downloads" count={dlCount || undefined} hot={dlCount > 0} on={section === "downloads"} onClick={() => props.onSection("downloads")} />
            <NavItem icon="servers" label="Servidores" on={section === "servers"} onClick={() => props.onSection("servers")} />
            <NavItem icon="skin" label="Skin" on={section === "skin"} onClick={() => props.onSection("skin")} />
            <NavItem icon="friends" label="Amigos" on={section === "friends"} onClick={() => props.onSection("friends")} />
          </div>
          <div className="sb-foot">
            <NavItem icon="settings" label="Configurações" on={section === "settings"} onClick={() => props.onSection("settings")} />
            <NavItem icon="help" label="Ajuda" soon on={section === "help"} onClick={() => props.onSection("help")} />
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
          {section === "map" && <MapSection server={current} />}
          {section === "servers" && <ServersSection servers={props.servers} active={props.active} onSwitch={props.onSwitch} onAdd={props.onAdd} onEdit={props.onEdit} onRemove={props.onRemove} />}
          {section === "skin" && <SkinSection server={current} onPatch={props.onPatch} />}
          {section === "settings" && <SettingsSection server={current} preset={props.preset} onPreset={props.onPreset} onPatch={props.onPatch} autojoin={props.autojoin} onAutojoin={props.onAutojoin} iconPack={props.iconPack} onIconPack={props.onIconPack} />}
          {section === "mods" && <ModsSection server={current} />}
          {section === "worlds" && <WorldsSection server={current} />}
          {section === "downloads" && <DownloadsSection engine={engine} />}
          {section === "console" && <ConsoleSection engine={engine} />}
          {section === "friends" && <FriendsSection engine={engine} />}
          {section === "help" && <SoonSection icon="help" eyebrow="Ajuda" title="Central de ajuda" description="Guias de instalação, solução de problemas e como pedir um convite ao administrador. Em breve." />}
        </main>
      </div>

      {/* status bar */}
      <div className="statusbar">
        <span className="si" title="uso do seu computador"><Icon n="ram" />RAM {stats ? `${(stats.mem_used / 1024 ** 3).toFixed(1)}/${(stats.mem_total / 1024 ** 3).toFixed(0)} GB` : "—"}</span>
        <span className="si" title="uso do seu computador"><Icon n="cpu" />CPU {stats ? Math.round(stats.cpu) : "—"}%</span>
        {engine.info?.latency_ms != null && <span className="si" title="latência até o servidor"><Icon n="ping" />{engine.info.latency_ms} ms</span>}
        <span className="sp" />
        {engine.info?.channel && <span className="si on-dark">canal {engine.info.channel}</span>}
        <span className="si on-dark"><span className={`srv-dot ${online ? "on-ink" : ""}`} style={online ? { background: "var(--accent-ink)", boxShadow: "none" } : undefined} />{engine.info ? "servidor " + (STATE_LABEL[engine.info.state] ?? engine.info.state) : "conectando…"}</span>
        {engine.busy && <span className="si on-dark"><Icon n="download" />{engine.activity?.label ?? "trabalhando…"}</span>}
        <span className="si on-dark"><Icon n="friends" />{current.username}</span>
      </div>
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}

function NavItem({ icon, label, on, soon, count, hot, onClick }: { icon: IconName; label: string; on: boolean; soon?: boolean; count?: number; hot?: boolean; onClick: () => void }) {
  return (
    <button className={`nav ${on ? "on" : ""}`} onClick={onClick} aria-label={label} title={label} aria-current={on ? "page" : undefined}>
      <Icon n={icon} /><span>{label}</span>
      {count != null && <span className={`count ${hot ? "hot" : ""}`}>{count}</span>}
      {soon && count == null && <span className="soon-tag">breve</span>}
    </button>
  );
}

type PaletteCommand = { label: string; hint?: string; icon: IconName; run: () => void };

function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const filtered = commands.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, Math.max(0, filtered.length - 1))); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); filtered[sel]?.run(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, sel, onClose]);
  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input autoFocus placeholder="Ir para uma seção ou ação…" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">Nada encontrado.</div>}
          {filtered.map((c, i) => (
            <button key={c.label} className={`palette-item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => { c.run(); onClose(); }}>
              <Icon n={c.icon} /><span className="pi-label">{c.label}</span>{c.hint && <span className="pi-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConsoleSection({ engine }: { engine: Engine }) {
  const { log, error } = engine;
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"console" | "problemas">("console");
  useEffect(() => { if (tab === "console" && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log, tab]);
  return (
    <div className="page">
      <SectionHeading eyebrow="Servidor" title="Console" />
      <div className="content-tabs console-tabs">
        <button className={`content-tab ${tab === "console" ? "on" : ""}`} onClick={() => setTab("console")}>Console</button>
        <button className={`content-tab ${tab === "problemas" ? "on" : ""}`} onClick={() => setTab("problemas")}>
          Problemas{error ? <span className="tab-badge">1</span> : null}
        </button>
        <button className="btn ghost mini console-copy" title="Copiar console" disabled={!log.length} onClick={() => { void navigator.clipboard?.writeText(log.join("\n")); }}>Copiar</button>
      </div>
      {tab === "console" ? (
        <div className="console-page" ref={ref}>
          {log.length
            ? log.map((l, i) => <div className="ln" key={i}><span className="msg">{l}</span></div>)
            : <div className="ln dim"><span className="msg">Console vazio. Clique em Jogar ou Sincronizar para ver a saída.</span></div>}
        </div>
      ) : (
        <div className="console-page">
          {error
            ? <div className="ln"><span className="lv warn">ERRO</span><span className="msg">{error}</span></div>
            : <div className="ln dim"><span className="msg">Nenhum problema. Tudo certo por aqui.</span></div>}
        </div>
      )}
    </div>
  );
}

function SoonSection({ icon, eyebrow, title, description }: { icon: IconName; eyebrow: string; title: string; description: string }) {
  return (
    <div className="page">
      <SectionHeading eyebrow={eyebrow} title={title} description="" />
      <EmptyState icon={icon} title={title} description={description} />
    </div>
  );
}

function SectionHeading({ title, description, eyebrow = "Seu espaço de jogo" }: { title: string; description?: string; eyebrow?: string }) {
  return <div className="section-heading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>;
}

function EmptyState({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon n={icon} /></span><h3>{title}</h3><p>{description}</p></div>;
}

const LAUNCHER_CHANGELOG: { v: string; t: string }[] = [
  { v: "0.4.15", t: "Ícones de arquivo por tipo (e bug da prévia corrigido), botão Atualizar agora, e prévia de tema representando o launcher" },
  { v: "0.4.14", t: "Amigos com status online, gráfico de armazenamento e uso de CPU/RAM do launcher+jogo no Dashboard, prévia de tema estilo painel e Arquivos em grade" },
  { v: "0.4.13", t: "Configurações com mais categorias (Geral, Java & RAM, Minecraft, Atualizações…), changelog agora em Atualizações e Dashboard reorganizado" },
  { v: "0.4.12", t: "Temas com prévia ao vivo e 5 novos, ícones de arquivo novos, Console em tela própria, Configurações com abas no topo e 'carregar mais' no Conteúdo" },
  { v: "0.4.11", t: "Skin em 3D rotacionável, Conteúdo com mais colunas e filtros horizontais" },
  { v: "0.4.10", t: "Mods em grade, página de Downloads de verdade, tela de adicionar servidor centralizada e interface mais limpa" },
  { v: "0.4.9", t: "Mods do servidor, Mundos locais em grade, Configurações e Conteúdo em dois painéis, jogadores online por nome e lixeira do sync que não cresce mais" },
  { v: "0.4.8", t: "Visual fiel ao protótipo: banner do servidor, sidebar completa, dock com abas e status bar" },
  { v: "0.4.7", t: "Redesign: onboarding, avatares, Ctrl+K e console dock" },
  { v: "0.4.6", t: "Convites e roster de jogadores" },
  { v: "0.4.5", t: "Aba Mapa (BlueMap embutido)" },
  { v: "0.4.3", t: "Enviar skin do jogador" },
  { v: "0.4.0", t: "Temas do painel e servidores em cartões" },
];

function Spark({ tone = "accent" }: { tone?: "accent" | "info" }) {
  const color = tone === "info" ? "var(--info)" : "var(--accent)";
  return (
    <svg className="spark" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="0,23 20,19 40,24 60,13 80,17 100,9 120,14" fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

// ============================================================ Dashboard =====
function DashboardSection({ server, engine, stats, onConfig }: { server: Server; engine: Engine; stats: SystemStats | null; onConfig: () => void }) {
  const { info, plan, busy, activity, error } = engine;

  const pct = activity && activity.total > 0 ? Math.round((activity.done / activity.total) * 100) : null;
  const stateClass = info?.state === "running" ? "online" : info?.state === "crashed" ? "crashed" : "offline";
  const memPct = stats ? (stats.mem_used / stats.mem_total) * 100 : 0;
  const pcount = info?.players ?? null;
  const [diskBytes, setDiskBytes] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setDiskBytes(null);
    invoke<number>("dir_size", { dir: server.dir }).then((b) => { if (alive) setDiskBytes(b); }).catch(() => {});
    return () => { alive = false; };
  }, [server.dir]);

  return (
    <div className="page">
      <SectionHeading title="Vamos jogar?" eyebrow="Visão geral" />
      <div className="banner">
        <ServerCover url={server.coverUrl} credit={server.coverCredit} />
        <div className="brow">Servidor</div>
        <div className="banner-row">
          <div>
            <h3>{server.label ?? info?.instance_name ?? "Conectando…"}</h3>
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
          <div className="wl"><Icon n="players" />Jogadores online</div>
          <div className="wv tnum">{pcount ? pcount.online : "—"}<small> / {pcount ? pcount.max : "—"}</small></div>
          <Spark tone="accent" />
        </div>
        <div className="card widget">
          <div className="wl"><Icon n="cpu" />CPU · Aether + jogo</div>
          <div className="wv tnum">{stats ? Math.round(stats.cpu) : "—"}<small>%</small></div>
          <div className="mini-track"><i style={{ width: `${stats ? Math.min(100, stats.cpu) : 0}%` }} /></div>
        </div>
        <div className="card widget">
          <div className="wl"><Icon n="ram" />RAM · Aether + jogo</div>
          <div className="wv tnum">{stats ? (stats.mem_used / 1024 ** 3).toFixed(1) : "—"}<small> GB</small></div>
          <div className="mini-track"><i style={{ width: `${memPct}%` }} /></div>
        </div>
        <div className="card widget">
          <div className="wl"><Icon n="ping" />Ping</div>
          <div className="wv tnum">{info?.latency_ms != null ? info.latency_ms : "—"}<small> ms</small></div>
          <Spark tone="info" />
        </div>
        <div className="card widget">
          <div className="wl"><Icon n="folder" />Armazenamento</div>
          <div className="wv tnum">{diskBytes != null ? (diskBytes / 1024 ** 3).toFixed(1) : "—"}<small> GB</small></div>
          <div className="wl-sub">na pasta do jogo</div>
        </div>
      </div>

      <div className="card server-now">
        <div className="panel-h"><h4>No servidor agora</h4><span className="eyebrow">{pcount ? `${pcount.online} de ${pcount.max}` : "—"}</span></div>
        <div className="server-now-body">
          <div className="online-body">
            {pcount && pcount.online > 0 ? (
              pcount.names && pcount.names.length > 0
                ? <PlayerRoster players={pcount} />
                : <p className="online-hidden">{pcount.online} {pcount.online === 1 ? "jogador online" : "jogadores online"} — o servidor não divulga os nomes.</p>
            ) : (
              <div className="online-none"><Icon n="players" /><span>Ninguém online agora. Clique em <b>Jogar</b> e seja o primeiro.</span></div>
            )}
          </div>
          <div className="server-now-side">
            <div className="feed-item">
              <div className="feed-ic"><Icon n="server" /></div>
              <div><h5>Servidor {info ? (STATE_LABEL[info.state] ?? info.state) : "conectando…"}</h5><p>{info ? `${info.files} arquivos · ${formatBytes(info.total_size)} · canal ${info.channel}.` : "Consultando o servidor…"}</p></div>
            </div>
            <div className="feed-actions">
              <button className="btn" disabled={busy} onClick={engine.sync}>Sincronizar</button>
              <button className="btn ghost" disabled={busy} onClick={engine.check_}><Icon n="refresh" />Verificar</button>
            </div>
          </div>
        </div>
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

    </div>
  );
}

// =============================================================== Setup ======
function SetupShell({ children }: { children: ReactNode }) {
  return (
    <div className="setup-screen">
      <div className="onboard-titlebar" data-tauri-drag-region>
        <div className="brand"><BrandLogo size={22} /><span className="wordmark">Aether</span></div>
        <div className="tb-drag" data-tauri-drag-region />
        <div className="win-ctrls">
          <button onClick={() => win.minimize()} title="Minimizar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg></button>
          <button onClick={() => win.toggleMaximize()} title="Maximizar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg></button>
          <button className="close" onClick={() => win.close()} title="Fechar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        </div>
      </div>
      <div className="setup-center">{children}</div>
    </div>
  );
}

function SetupScreen(props: { initial: Server | null; onSave: (s: Server) => void; onCancel?: () => void }) {
  const [manual, setManual] = useState(!!props.initial && !props.initial.invitation);
  return (
    <SetupShell>
      <div className="setup-stack">
        {manual
          ? <ManualSetupScreen {...props} onInvite={() => setManual(false)} />
          : <InviteSetup {...props} onManual={() => setManual(true)} />}
        {!manual && (
          <ul className="setup-feats">
            <li><Icon n="refresh" /> Sincroniza os mods automaticamente</li>
            <li><Icon n="play" /> Entra direto no servidor ao clicar em Jogar</li>
            <li><Icon n="map" /> Mapa, skin e arquivos num lugar só</li>
          </ul>
        )}
      </div>
    </SetupShell>
  );
}

function ManualSetupScreen({ initial, onSave, onCancel, onInvite }: { initial: Server | null; onSave: (s: Server) => void; onCancel?: () => void; onInvite: () => void }) {
  const [server, setServer] = useState(initial?.server ?? "");
  const [profileId, setProfileId] = useState(initial?.profileId ?? "");
  const [dir, setDir] = useState(initial?.dir ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [gameAddress, setGameAddress] = useState(initial?.gameAddress ?? "");
  const [mapUrl, setMapUrl] = useState(initial?.mapUrl ?? "");
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
      const target = dir || await invoke<string>("default_game_dir", { server: server.trim(), profileId: profileId.trim() });
      onSave({ server: server.trim(), profileId: profileId.trim(), dir: target, username: username.trim(), autojoin: initial?.autojoin, memoryMb: initial?.memoryMb, label: info.instance_name, gameAddress: gameAddress.trim() || undefined, mapUrl: mapUrl.trim() || undefined });
    } catch (e) {
      setError(String(e));
    } finally { setTesting(false); }
  }

  const valido = server.trim() && profileId.trim() && username.trim();

  return (
    <div className="card setup-card">
      <div className="setup-card-head">
        <h2>{initial ? "Editar servidor" : "Configuração manual"}</h2>
        <button className="btn ghost" onClick={onInvite}>Usar convite</button>
      </div>
      {initial?.invitation && <p className="hint">Salvar manualmente desliga a atualização automática pelo convite.</p>}
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
          <label>URL do mapa (opcional)</label>
          <input placeholder="ex.: https://map.meuserver.com  ou  http://192.168.1.10:8100" value={mapUrl} onChange={(e) => setMapUrl(e.target.value)} />
          <p className="hint">O endereço do mapa web (BlueMap/Dynmap) do servidor. Preenche pra ver o mapa na aba Mapa.</p>
        </div>
        <div className="field">
          <label>Pasta do jogo (opcional)</label>
          <div className="row">
            <input placeholder="C:\...\.minecraft" value={dir} readOnly />
            <button className="btn" onClick={pickDir}>Escolher…</button>
          </div>
          <p className="hint">Sem escolher uma pasta, o Aether cria uma instalação separada na pasta de dados do seu usuário.</p>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ marginTop: 6 }}>
          {onCancel && <button className="btn" onClick={onCancel} disabled={testing}>Cancelar</button>}
          <button className="btn primary lg" style={{ flex: 1 }} disabled={!valido || testing} onClick={save}>
            {testing ? "Verificando…" : initial ? "Salvar" : "Conectar"}
          </button>
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
      <SectionHeading title="Seus servidores" eyebrow="Biblioteca" />
      <div className="srv-grid">
        {servers.map((s, i) => (
          <div key={i} className={`srv-card ${i === active ? "active" : ""}`}>
            <button className="srv-body" onClick={() => onSwitch(i)}>
              <div className="srv-banner">
                <ServerCover url={s.coverUrl} credit={s.coverCredit} />
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

/** Ícone e categoria por tipo de arquivo — como no gerenciador do servidor. */
function fileKind(name: string, isDir: boolean): { icon: IconName; kind: string } {
  if (isDir) return { icon: "folder", kind: "dir" };
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "jar") return { icon: "mods", kind: "jar" };
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tga"].includes(ext)) return { icon: "image", kind: "image" };
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return { icon: "archive", kind: "archive" };
  if (["properties", "cfg", "conf", "ini", "toml"].includes(ext)) return { icon: "settings", kind: "config" };
  if (["json", "json5", "yml", "yaml", "mcmeta", "xml"].includes(ext)) return { icon: "code", kind: "code" };
  if (["sh", "bat", "cmd", "ps1"].includes(ext)) return { icon: "script", kind: "script" };
  return { icon: "file", kind: "file" };
}
function FileGlyph({ name, isDir, cls }: { name: string; isDir: boolean; cls: string }) {
  const fk = fileKind(name, isDir);
  return <span className={`${cls} ${isDir ? "dir" : ""}`} data-kind={fk.kind}><Icon n={fk.icon} /></span>;
}

const ListIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>;
const GridIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;

function FilesSection({ server }: { server: Server }) {
  const [tab, setTab] = useState<"files" | "trash">("files");
  const [view, setView] = useState<"list" | "grid">("grid");
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
        <SectionHeading title="Arquivos" eyebrow="Sua instalação" />
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

          {entries.length === 0 && <EmptyState icon="folder" title="Espaço para começar" description="Esta pasta está vazia. Crie uma pasta ou um arquivo usando as ações acima." />}

          {view === "list" ? (
            <div className="file-list">
              {entries.map((e) => {
                const locked = e.is_dir ? folderHasServer(e.rel) : isManagedFile(e.rel);
                const editable = !e.is_dir && isEditable(e.name, e.size);
                return (
                  <div key={e.rel} className="file-row">
                    <button className="file-main" onClick={() => openEntry(e)} disabled={!e.is_dir && !editable}>
                      <FileGlyph name={e.name} isDir={e.is_dir} cls="file-ico" />
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
                    <FileGlyph name={e.name} isDir={e.is_dir} cls="gi" />
                    <span className="gn" title={e.name}>{e.name}</span>
                  </button>
                );
              })}
            </div>
          )}

        </>
      ) : (
        <>
          <div className="trash-head">
            <span className="eyebrow">Itens removidos — recuperáveis antes de sumir de vez</span>
            {trash.length > 0 && <button className="btn ghost danger" disabled={busy} onClick={emptyTrash}>Esvaziar lixeira</button>}
          </div>
          {trash.length === 0 && <EmptyState icon="trash" title="Tudo em seu lugar" description="Os arquivos removidos aparecem aqui e podem ser restaurados." />}
          {trash.map((t) => (
            <div key={t.id} className="trow">
              <FileGlyph name={t.name} isDir={t.is_dir} cls="ti" />
              <span className="tn">{t.name}</span>
              <span className="tw">{agoLabel(t.ts)} · de {t.rel.includes("/") ? t.rel.slice(0, t.rel.lastIndexOf("/")) : "raiz"}</span>
              <div className="tacts">
                <button className="btn mini" disabled={busy} onClick={() => restore(t.id)}>Restaurar</button>
                <button className="btn mini danger" disabled={busy} onClick={() => purge(t.id)}>Excluir</button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// =========================================================== Configurações ==
const ICON_PACKS: { id: string; label: string; hint: string }[] = [
  { id: "classico", label: "Clássico", hint: "Contorno colorido por tipo" },
  { id: "neutro", label: "Neutro", hint: "Monocromático, sem cor" },
  { id: "solido", label: "Sólido", hint: "Ícone sobre pastilha colorida" },
  { id: "contraste", label: "Contraste", hint: "Pastilha preenchida, ícone vazado" },
  { id: "pastel", label: "Pastel", hint: "Cores suaves, contorno mais fino" },
  { id: "destaque", label: "Destaque", hint: "Tudo na cor de destaque do tema" },
];

/** Mini-launcher renderizado com as cores de um tema — prévia ao vivo. */
function ThemeMiniApp({ t }: { t: ThemeTokens }) {
  const soft = hexRgba(t.accent, 0.16);
  return (
    <div className="tmini" style={{ background: t.bg }}>
      <div className="tmini-tb" style={{ background: t.surface, borderBottom: `1px solid ${t.border}` }}>
        <span className="tmini-gem" style={{ background: t.accent }} />
        <span className="tmini-pill" style={{ background: t.surface3 }} />
      </div>
      <div className="tmini-b">
        <div className="tmini-side" style={{ background: t.surface, borderRight: `1px solid ${t.border}` }}>
          <span className="tmini-nav" style={{ background: soft }}><i style={{ background: t.accent }} /></span>
          <span className="tmini-nav"><i style={{ background: t.muted }} /></span>
          <span className="tmini-nav"><i style={{ background: t.muted }} /></span>
        </div>
        <div className="tmini-main">
          <div className="tmini-banner" style={{ background: `linear-gradient(120deg, ${t.accentDim}, ${t.info})` }} />
          <div className="tmini-cards">
            <div className="tmini-card" style={{ background: t.surface, borderColor: t.border }}><i style={{ background: t.accent }} /></div>
            <div className="tmini-card" style={{ background: t.surface, borderColor: t.border }}><i style={{ background: t.info }} /></div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Prévia grande do LAUNCHER no tema: sidebar, banner com Jogar e os widgets do
 *  Dashboard. Usada só na prévia principal (os cards seguem com ThemeMiniApp). */
function ThemeMiniDash({ t }: { t: ThemeTokens }) {
  const soft = hexRgba(t.accent, 0.16);
  const tile = (label: string, value: string, color: string) => (
    <div className="tdash-tile" style={{ background: t.surface, border: `1px solid ${t.border}` }}>
      <span style={{ color: t.muted }}>{label}</span><b style={{ color }}>{value}</b>
    </div>
  );
  return (
    <div className="tdash" style={{ background: t.bg, border: `1px solid ${t.border}` }}>
      <div className="tdash-side" style={{ background: t.surface, borderRight: `1px solid ${t.border}` }}>
        <div className="tdash-brand" style={{ color: t.text }}><span className="tdash-gem" style={{ background: t.accent }} />Aether</div>
        <div className="tdash-nav on" style={{ background: soft, color: t.text }}>Jogar</div>
        <div className="tdash-nav" style={{ color: t.muted }}>Mods</div>
        <div className="tdash-nav" style={{ color: t.muted }}>Mundos</div>
      </div>
      <div className="tdash-main">
        <div className="tdash-banner" style={{ background: `linear-gradient(120deg, ${t.accentDim}, ${t.info})` }}>
          <span className="tdash-play" style={{ background: "#fff", color: t.accentDim }}>▶</span>
        </div>
        <div className="tdash-tiles tdash-tiles-3">
          {tile("Jogadores", "3/20", t.accent)}
          {tile("CPU", "42%", t.info)}
          {tile("RAM", "6.1 GB", t.text)}
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ server, preset, onPreset, onPatch, autojoin, onAutojoin, iconPack, onIconPack }: {
  server: Server; preset: string; onPreset: (p: string) => void; onPatch: (p: Partial<Server>) => void;
  autojoin: boolean; onAutojoin: (v: boolean) => void; iconPack: string; onIconPack: (p: string) => void;
}) {
  const memGb = (server.memoryMb ?? DEFAULT_MEMORY_MB) / 1024;
  const [cat, setCat] = useState<SettingsCat>("geral");
  const [hovered, setHovered] = useState<string | null>(null);
  const shownTheme = THEMES[hovered ?? preset] ?? THEMES.aether;
  const [nick, setNick] = useState(server.username);
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [updMsg, setUpdMsg] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState("");
  useEffect(() => setNick(server.username), [server.username]);
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);

  async function pickDir() {
    const chosen = await open({ directory: true, title: "Pasta do Minecraft (.minecraft)" });
    if (typeof chosen === "string") onPatch({ dir: chosen });
  }
  async function checkUpdates() {
    setChecking(true); setUpdMsg(""); setUpdate(null);
    try {
      const u = await check();
      setUpdate(u ?? null);
      setUpdMsg(u ? `Nova versão ${u.version} disponível.` : "Você está na versão mais recente.");
    } catch { setUpdMsg("Não foi possível verificar agora. Tente mais tarde."); } finally { setChecking(false); }
  }
  async function installUpdate() {
    if (!update) return;
    setUpdating("Baixando…");
    try {
      await update.downloadAndInstall(() => setUpdating("Instalando…"));
      setUpdating("Reiniciando…");
      await relaunch();
    } catch (e) { setUpdMsg(`Falha ao atualizar: ${e}`); setUpdating(""); }
  }
  function openGameDir() { void invoke("fs_reveal", { dir: server.dir, rel: "" }).catch(() => {}); }

  const cats: { id: SettingsCat; label: string; icon: IconName }[] = [
    { id: "geral", label: "Geral", icon: "settings" },
    { id: "conta", label: "Conta", icon: "friends" },
    { id: "java", label: "Java & RAM", icon: "ram" },
    { id: "minecraft", label: "Minecraft", icon: "play" },
    { id: "downloads", label: "Downloads", icon: "download" },
    { id: "interface", label: "Interface & Temas", icon: "content" },
    { id: "performance", label: "Performance", icon: "cpu" },
    { id: "atualizacoes", label: "Atualizações", icon: "refresh" },
    { id: "avancado", label: "Avançado", icon: "lock" },
  ];

  return (
    <div className="page">
      <SectionHeading title="Configurações" eyebrow="Você" />

      <div className="content-tabs settings-tabs">
        {cats.map((c) => (
          <button key={c.id} className={`content-tab ${cat === c.id ? "on" : ""}`} aria-current={cat === c.id ? "page" : undefined} onClick={() => setCat(c.id)}>
            <Icon n={c.icon} />{c.label}
          </button>
        ))}
      </div>

      {cat === "geral" && (
        <div className="setting" style={{ paddingTop: 0 }}>
          <div className="set-row">
            <div className="txt"><h5>Entrar direto no servidor</h5><p>Ao clicar em Jogar, entra no servidor pulando o menu do Minecraft.</p></div>
            <div className="ctl"><button className={`toggle ${autojoin ? "on" : ""}`} role="switch" aria-checked={autojoin} aria-label="Entrar direto no servidor" onClick={() => onAutojoin(!autojoin)} /></div>
          </div>
        </div>
      )}

      {cat === "conta" && (
        <div className="setting" style={{ paddingTop: 0 }}>
          <div className="set-row">
            <div className="txt"><h5>Nome do jogador</h5><p>Igual à whitelist (maiúsculas contam, modo offline). É por este nome que a skin é encontrada.</p></div>
            <div className="ctl row">
              <input type="text" style={{ width: 200 }} value={nick} maxLength={16} onChange={(e) => setNick(e.target.value)} />
              <button className="btn" disabled={!/^[A-Za-z0-9_]{3,16}$/.test(nick.trim()) || nick.trim() === server.username} onClick={() => onPatch({ username: nick.trim() })}>Salvar</button>
            </div>
          </div>
          <div className="set-row">
            <div className="txt"><h5>Modo de login</h5><p>Hoje o launcher entra em modo offline — serve a servidores com <code>online-mode=false</code>. Login Microsoft está no roteiro.</p></div>
            <div className="ctl"><span className="pill mute">offline</span></div>
          </div>
        </div>
      )}

      {cat === "java" && (
        <div className="setting" style={{ paddingTop: 0 }}>
          <div className="set-row">
            <div className="txt"><h5>Memória do jogo</h5><p>Quanto o Minecraft pode usar de RAM. 4–8 GB serve à maioria dos servidores com mods.</p></div>
            <div className="ctl" style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 240 }}>
              <input aria-label="Memória do jogo em GB" type="range" min={1} max={16} step={0.5} value={memGb} onChange={(e) => onPatch({ memoryMb: Math.round(Number(e.target.value) * 1024) })} />
              <b className="tnum" style={{ whiteSpace: "nowrap" }}>{memGb.toFixed(1)} GB</b>
            </div>
          </div>
          <div className="set-row">
            <div className="txt"><h5>Java</h5><p>O launcher instala e usa o Java certo (17) automaticamente para esta versão — você não precisa configurar nada.</p></div>
            <div className="ctl"><span className="pill ok">automático</span></div>
          </div>
        </div>
      )}

      {cat === "minecraft" && (
        <div className="setting" style={{ paddingTop: 0 }}>
          <div className="set-row">
            <div className="txt"><h5>Pasta do jogo</h5><p>Onde os arquivos do jogo ficam neste computador.</p></div>
            <div className="ctl row"><input type="text" style={{ width: 240 }} value={server.dir} readOnly /><button className="btn" onClick={pickDir}>Escolher…</button></div>
          </div>
          <div className="set-row">
            <div className="txt"><h5>Abrir a pasta</h5><p>Ver mods, configs e mundos no explorador de arquivos.</p></div>
            <div className="ctl"><button className="btn" onClick={openGameDir}>Abrir pasta</button></div>
          </div>
        </div>
      )}

      {cat === "downloads" && (
        <div className="setting" style={{ paddingTop: 0 }}>
          <div className="set-row">
            <div className="txt"><h5>Onde ficam os downloads</h5><p>Mods, shaders e texturas baixam para a pasta do jogo (veja em <b>Minecraft ▸ Abrir pasta</b>). O progresso ao vivo aparece na aba <b>Downloads</b>.</p></div>
          </div>
          <div className="set-row">
            <div className="txt"><h5>Limpeza automática</h5><p>Versões antigas de arquivos substituídos vão para uma lixeira interna e são podadas sozinhas — sem acumular espaço em disco.</p></div>
            <div className="ctl"><span className="pill ok">ativa</span></div>
          </div>
        </div>
      )}

      {cat === "interface" && (
        <>
          <div className="setting" style={{ paddingTop: 0 }}>
            <label>Tema</label>
            <div className="theme-live theme-live-dash">
              <ThemeMiniDash t={shownTheme.tokens} />
              <div className="theme-live-cap">
                <b>{shownTheme.label}</b>
                <span>{(hovered ?? preset) === preset ? "tema atual" : "passe o mouse para pré-visualizar"}</span>
              </div>
            </div>
            <div className="theme-grid">
              {Object.entries(THEMES).map(([id, t]) => (
                <button key={id} className={`tcard ${preset === id ? "on" : ""}`} aria-pressed={preset === id} title={t.label}
                  onMouseEnter={() => setHovered(id)} onMouseLeave={() => setHovered(null)} onClick={() => onPreset(id)}>
                  <ThemeMiniApp t={t.tokens} />
                  <span className="tname">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="setting">
            <label>Ícones de arquivo</label>
            <div className="iconpack-grid">
              {ICON_PACKS.map((p) => (
                <button key={p.id} className={`ipk ${iconPack === p.id ? "on" : ""}`} aria-pressed={iconPack === p.id} data-iconpack={p.id} onClick={() => onIconPack(p.id)}>
                  <div className="ipk-head"><b>{p.label}</b>{iconPack === p.id && <span className="ipk-check">✓</span>}</div>
                  <span className="ipk-prev">
                    <span className="pv-ico dir" data-kind="dir"><Icon n="folder" /></span>
                    <span className="pv-ico" data-kind="jar"><Icon n="mods" /></span>
                    <span className="pv-ico" data-kind="config"><Icon n="settings" /></span>
                    <span className="pv-ico" data-kind="code"><Icon n="code" /></span>
                    <span className="pv-ico" data-kind="image"><Icon n="image" /></span>
                  </span>
                  <span className="ipk-hint">{p.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {cat === "performance" && (
        <div className="setting" style={{ paddingTop: 0 }}>
          <div className="set-row">
            <div className="txt"><h5>Memória</h5><p>O ajuste que mais afeta o desempenho é a memória — configure em <b>Java & RAM</b>.</p></div>
            <div className="ctl"><b className="tnum">{memGb.toFixed(1)} GB</b></div>
          </div>
          <div className="set-row">
            <div className="txt"><h5>Argumentos da JVM</h5><p>Ajustes finos de coletor de lixo e flags avançadas chegam em breve.</p></div>
            <div className="ctl"><span className="pill mute">em breve</span></div>
          </div>
        </div>
      )}

      {cat === "atualizacoes" && (
        <>
          <div className="setting" style={{ paddingTop: 0 }}>
            <div className="set-row">
              <div className="txt"><h5>Versão do launcher</h5><p>As atualizações chegam automaticamente. Você também pode verificar agora.</p></div>
              <div className="ctl row" style={{ alignItems: "center" }}>
                <b className="tnum">{version || "—"}</b>
                {update
                  ? <button className="btn primary" disabled={!!updating} onClick={installUpdate}>{updating || `Atualizar para ${update.version}`}</button>
                  : <button className="btn" disabled={checking} onClick={checkUpdates}>{checking ? "Verificando…" : "Verificar"}</button>}
              </div>
            </div>
            {updMsg && <p className="hint" style={{ marginTop: 4 }}>{updMsg}</p>}
          </div>
          <div className="setting">
            <label>Novidades</label>
            <div className="card"><div className="changelog">
              {LAUNCHER_CHANGELOG.map((c) => (<div className="cl-row" key={c.v}><span className="v">{c.v}</span><span>{c.t}</span></div>))}
            </div></div>
          </div>
        </>
      )}

      {cat === "avancado" && (
        <div className="setting" style={{ paddingTop: 0 }}>
          <div className="set-row">
            <div className="txt"><h5>Reinstalar Java / Forge</h5><p>Refazer a instalação em caso de arquivos corrompidos chega em breve.</p></div>
            <div className="ctl"><span className="pill mute">em breve</span></div>
          </div>
          <div className="set-row">
            <div className="txt"><h5>Editar arquivos</h5><p>Para inspecionar mods, configs e mundos, use a aba <b>Arquivos</b> ou <b>Minecraft ▸ Abrir pasta</b>.</p></div>
          </div>
        </div>
      )}
    </div>
  );
}

type SettingsCat = "geral" | "conta" | "java" | "minecraft" | "downloads" | "interface" | "performance" | "atualizacoes" | "avancado";

// ================================================================ Skin ======
/** Boneco 3D da skin, rotacionável com o mouse (arraste). */
function SkinViewer3D({ skin }: { skin: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const dims = () => ({ w: Math.max(120, parent.clientWidth), h: Math.max(160, parent.clientHeight) });
    const { w, h } = dims();
    const viewer = new SkinViewer({ canvas, width: w, height: h });
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.zoom = 0.9;
    viewer.autoRotate = false;
    viewer.playerObject.rotation.y = 0.4; // ângulo inicial para parecer 3D
    viewerRef.current = viewer;
    // Acompanha o tamanho do palco: mantém o boneco centralizado ao redimensionar.
    const ro = new ResizeObserver(() => { const { w, h } = dims(); viewer.width = w; viewer.height = h; });
    ro.observe(parent);
    return () => { ro.disconnect(); viewer.dispose(); };
  }, []);
  useEffect(() => { void viewerRef.current?.loadSkin(skin).catch(() => {}); }, [skin]);
  return <canvas ref={canvasRef} className="skin-canvas" aria-label="Prévia 3D da skin — arraste para girar" />;
}

function SkinSection({ server, onPatch }: { server: Server; onPatch: (p: Partial<Server>) => void }) {
  const [nick, setNick] = useState(server.username);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [bust, setBust] = useState(0);
  // undefined = carregando · null = sem skin · string = data URI da skin
  const [skinData, setSkinData] = useState<string | null | undefined>(undefined);
  const hasSkin = skinData != null;
  useEffect(() => setNick(server.username), [server.username]);

  // Busca a skin pelo Rust (data URI) — serve ao visualizador 3D sem CORS.
  useEffect(() => {
    let alive = true;
    setSkinData(undefined);
    invoke<string | null>("skin_png", { server: server.server, username: server.username })
      .then((d) => { if (alive) setSkinData(d); })
      .catch(() => { if (alive) setSkinData(null); });
    return () => { alive = false; };
  }, [server.server, server.username, bust]);

  async function pickAndUpload() {
    setError(""); setOk("");
    const file = await open({ multiple: false, filters: [{ name: "Skin (PNG)", extensions: ["png"] }] });
    if (typeof file !== "string") return;
    setUploading(true);
    try {
      await invoke("upload_skin", { server: server.server, profileId: server.profileId, username: server.username, filePath: file });
      setOk("Skin enviada! Ela aparece no jogo com o mod de skins ativo.");
      setBust(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="page">
      <SectionHeading title="Skin" eyebrow="Skin e jogador" />

      <div className="skin-split">
        <div className="skin-preview">
          <div className="identity-caption"><span className="eyebrow">Jogador</span><h3>{server.username}</h3></div>
          <div className="skin-stage">
            {skinData ? (
              <SkinViewer3D skin={skinData} />
            ) : skinData === undefined ? (
              <div className="skin-loading">Carregando…</div>
            ) : (
              <div className="mc">
                <div className="part head"><div className="face"><i /><i /></div></div>
                <div className="arms"><span className="arm" /><span className="arm" /></div>
                <div className="part torso" />
                <div className="legs"><span className="leg" /><span className="leg" /></div>
              </div>
            )}
          </div>
          <div className={`skin-status ${hasSkin ? "on" : ""}`}>
            {skinData === undefined ? "Verificando imagem…" : hasSkin ? "✔ Arraste para girar o boneco" : "Nenhuma skin enviada"}
          </div>
        </div>

        <div className="skin-controls">
          {/* Ação principal: a skin. */}
          <div className="setting">
            <label>Skin do jogo</label>
            <p className="hint" style={{ marginBottom: 12 }}>
              Envie um PNG de skin (64×64). Fica hospedada no servidor; com o mod de skins ativo, todos veem.
            </p>
            <button className="btn primary lg" style={{ width: "100%" }} disabled={uploading} onClick={pickAndUpload}>
              {uploading ? "Enviando…" : hasSkin ? "Trocar minha skin" : "Enviar minha skin"}
            </button>
            {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
            {ok && <p className="ok" style={{ marginTop: 10 }}>{ok}</p>}
          </div>

          {/* Separado e rotulado: o nome do jogador (não é a skin). */}
          <div className="setting">
            <label>Nome do jogador</label>
            <div className="row">
              <input type="text" style={{ flex: 1 }} value={nick} onChange={(e) => setNick(e.target.value)} />
              <button className="btn" disabled={!nick.trim() || nick.trim() === server.username} onClick={() => onPatch({ username: nick.trim() })}>Salvar nome</button>
            </div>
            <p className="hint">Igual à whitelist (maiúsculas contam, modo offline). É por este nome que a skin é encontrada.</p>
          </div>

          <div className="soon">
            Para a skin aparecer no jogo, o modpack precisa do <code>CustomSkinLoader</code> apontando para o Aether — a config sincroniza para todos.
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

// =============================================================== Mods =======
interface ServerModRow { path: string; name: string; size: number; action: string; present: boolean }

/** Cor estável a partir do nome, só para o quadradinho do mod ter identidade. */
function modHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function ModsSection({ server }: { server: Server }) {
  const [mods, setMods] = useState<ServerModRow[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    setMods(null);
    setError("");
    invoke<ServerModRow[]>("server_mods", { server: server.server, profileId: server.profileId, dir: server.dir })
      .then((m) => { if (alive) setMods(m); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [server.server, server.profileId, server.dir]);

  const term = q.trim().toLowerCase();
  const list = (mods ?? []).filter((m) => m.name.toLowerCase().includes(term));

  return (
    <div className="page">
      <SectionHeading eyebrow="Servidor" title="Mods" />

      <div className="searchbar mods-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar mods pelo nome…" aria-label="Filtrar mods" />
        {mods && <span className="sb-count">{list.length} de {mods.length}</span>}
      </div>

      {error && <div className="error">Não consegui listar os mods: {error}. Verifique a conexão com o servidor.</div>}
      {!mods && !error && <div className="mods-loading">Consultando o servidor…</div>}
      {mods && list.length === 0 && !error && (
        <EmptyState icon="mods" title={term ? "Nada encontrado" : "Nenhum mod"} description={term ? "Nenhum mod bate com esse filtro." : "Este servidor não sincroniza mods."} />
      )}

      {mods && list.length > 0 && (
        <div className="mods-grid">
          {list.map((m) => (
            <div key={m.path} className="mcard" title={m.name}>
              <span className="mi" style={{ background: `linear-gradient(135deg, hsl(${modHue(m.name)} 58% 46%), hsl(${(modHue(m.name) + 40) % 360} 58% 32%))` }}>{m.name.charAt(0).toUpperCase()}</span>
              <div className="mcard-body">
                <div className="mcard-name">{m.name.replace(/\.jar$/i, "")}</div>
                <div className="mcard-meta">
                  {m.action === "optional" ? <span className="pill info">opcional</span> : <span className="pill lock"><Icon n="lock" />obrigatório</span>}
                  <span className="mcard-size tnum">{formatBytes(m.size)}</span>
                </div>
              </div>
              <span className={`mcard-dot ${m.present ? "on" : ""}`} title={m.present ? "baixado" : "pendente (baixa ao sincronizar)"} />
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

// Tags reais do Modrinth por tipo — filtram de verdade (sem contadores falsos).
const CONTENT_CATEGORIES: Record<ContentKind, { id: string; label: string }[]> = {
  shader: [
    { id: "realistic", label: "Realista" },
    { id: "fantasy", label: "Fantasia" },
    { id: "vanilla-like", label: "Vanilla+" },
    { id: "cartoon", label: "Cartoon" },
    { id: "performance", label: "Performance" },
  ],
  resourcepack: [
    { id: "realistic", label: "Realista" },
    { id: "simplistic", label: "Simples" },
    { id: "themed", label: "Temático" },
    { id: "modded", label: "Modded" },
    { id: "vanilla-like", label: "Vanilla+" },
  ],
};

/** Botão + popover para um filtro (Compatível, Categoria). Fecha ao clicar fora. */
function FilterMenu({ label, value, options, onSelect }: {
  label: string; value: string | null;
  options: { id: string | null; label: string }[];
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <div className="fmenu" ref={ref}>
      <button className={`fmenu-btn ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span className="fmenu-lbl">{label}</span><b>{current.label}</b>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="fmenu-pop">
          {options.map((o) => (
            <button key={String(o.id)} className={`fmenu-item ${o.id === value ? "on" : ""}`} onClick={() => { onSelect(o.id); setOpen(false); }}>
              <span className="fdot" />{o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ContentSection({ server }: { server: Server }) {
  const [kind, setKind] = useState<ContentKind>("shader");
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState<string | null>(null);
  const [useCompat, setUseCompat] = useState(true);
  const [category, setCategory] = useState<string | null>(null);
  const [results, setResults] = useState<ModItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState<Record<string, string>>(() => loadInstalled(server.dir, "shader"));
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<ContentProgress | null>(null);

  function switchKind(k: ContentKind) { setKind(k); setCategory(null); }

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

  async function doSearch(off = 0) {
    if (off === 0) setLoading(true); else setLoadingMore(true);
    setError("");
    try {
      const rows = await invoke<ModItem[]>("modrinth_search", { kind, query, gameVersion: useCompat ? gameVersion : null, category, offset: off });
      setResults((prev) => (off === 0 ? rows : [...prev, ...rows]));
      setHasMore(rows.length >= 24); // veio um lote cheio → provavelmente há mais
    } catch (e) { setError(String(e)); } finally { setLoading(false); setLoadingMore(false); }
  }

  // Busca quando troca de aba, categoria, compatibilidade ou a versão carrega.
  useEffect(() => { doSearch(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, useCompat, gameVersion, category]);

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
      <SectionHeading title="Conteúdo" eyebrow="Conteúdo" />

      <div className="content-toolbar">
        <div className="content-tabs">
          <button className={`content-tab ${isShader ? "on" : ""}`} onClick={() => switchKind("shader")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg>Shaders
          </button>
          <button className={`content-tab ${!isShader ? "on" : ""}`} onClick={() => switchKind("resourcepack")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></svg>Texturas
          </button>
        </div>
        <div className="c-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input placeholder={`Buscar ${isShader ? "shaders" : "texturas"} no Modrinth…`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doSearch()} />
        </div>
        <button className="btn" disabled={loading} onClick={() => doSearch(0)}>Buscar</button>
        {gameVersion && (
          <FilterMenu label="Versão" value={useCompat ? "compat" : "all"}
            options={[{ id: "compat", label: `${gameVersion}` }, { id: "all", label: "Todas" }]}
            onSelect={(v) => setUseCompat(v === "compat")} />
        )}
        <FilterMenu label="Categoria" value={category}
          options={[{ id: null, label: "Todas" }, ...CONTENT_CATEGORIES[kind]]}
          onSelect={setCategory} />
      </div>

      {error && <p className="error">{error}</p>}

      {installing && (
        <div className="c-progress">
          <div className="cp-head"><span className="cp-name">Instalando {progress?.name ?? "…"}</span>{pct !== null && <span className="cp-pct">{pct}%</span>}</div>
          <div className="progress-track"><div className={`progress-fill ${pct === null ? "indeterminate" : ""}`} style={pct !== null ? { width: `${pct}%` } : undefined} /></div>
        </div>
      )}

      {loading && results.length === 0 ? (
        <div className="content-skeleton" role="status" aria-label="Buscando conteúdo">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i}><i /><span /><span /></div>)}</div>
      ) : results.length === 0 ? (
        <EmptyState icon="content" title="Nenhum resultado por aqui" description={`Tente outro nome ou ajuste os filtros${useCompat && gameVersion ? ` (compatível com ${gameVersion})` : ""}.`} />
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

      {results.length > 0 && hasMore && (
        <div className="content-more">
          <button className="btn" disabled={loadingMore} onClick={() => doSearch(results.length)}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}

// =========================================================== Downloads ======
function DownloadsSection({ engine }: { engine: Engine }) {
  const { activity, busy } = engine;
  const syncPct = activity && activity.total > 0 ? Math.round((activity.done / activity.total) * 100) : null;
  const [installs, setInstalls] = useState<Record<string, ContentProgress>>({});
  const [done, setDone] = useState<{ name: string; kind: "sync" | "content" }[]>([]);
  const wasBusy = useRef(false);

  // Instalações do Modrinth em andamento (evento global do backend).
  useEffect(() => {
    const un = listen<ContentProgress>("content-progress", (e) => {
      const p = e.payload;
      if (p.total > 0 && p.done >= p.total) {
        setInstalls((prev) => { const n = { ...prev }; delete n[p.name]; return n; });
        setDone((prev) => [{ name: p.name, kind: "content" as const }, ...prev].slice(0, 30));
      } else {
        setInstalls((prev) => ({ ...prev, [p.name]: p }));
      }
    });
    return () => { un.then((fn) => fn()); };
  }, []);

  // Quando o sync termina, vira histórico.
  useEffect(() => {
    if (wasBusy.current && !busy) setDone((prev) => [{ name: "Sincronização do servidor", kind: "sync" as const }, ...prev].slice(0, 30));
    wasBusy.current = busy;
  }, [busy]);

  const activeInstalls = Object.values(installs);
  const activeCount = (busy ? 1 : 0) + activeInstalls.length;

  return (
    <div className="page">
      <SectionHeading eyebrow="Você" title="Downloads" />

      <div className="dl-head">
        <span className="dl-count">{activeCount > 0 ? `${activeCount} ativo${activeCount > 1 ? "s" : ""}` : "Nada em andamento"}</span>
        {done.length > 0 && <button className="btn ghost" onClick={() => setDone([])}>Limpar concluídos</button>}
      </div>

      {busy && activity && (
        <div className="dl-row">
          <div className="dl-ic"><Icon n="refresh" /></div>
          <div className="dl-main">
            <div className="dl-top"><b>{activity.label}</b><span className="st">{activity.detail}{syncPct !== null ? ` · ${syncPct}%` : ""}</span></div>
            <div className="track"><div className={`fill ${syncPct === null ? "indeterminate" : ""}`} style={syncPct !== null ? { width: `${syncPct}%` } : undefined} /></div>
          </div>
        </div>
      )}

      {activeInstalls.map((p) => {
        const pp = p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
        return (
          <div className="dl-row" key={p.name}>
            <div className="dl-ic"><Icon n="content" /></div>
            <div className="dl-main">
              <div className="dl-top"><b>{p.name}</b><span className="st">{pp !== null ? `${pp}%` : "baixando…"}</span></div>
              <div className="track"><div className={`fill ${pp === null ? "indeterminate" : ""}`} style={pp !== null ? { width: `${pp}%` } : undefined} /></div>
            </div>
          </div>
        );
      })}

      {activeCount === 0 && done.length === 0 && (
        <EmptyState icon="download" title="Nenhum download agora" description="Quando você sincronizar o servidor ou instalar shaders e texturas, o progresso aparece aqui." />
      )}

      {done.length > 0 && (
        <>
          <div className="dl-sub-h">Concluídos nesta sessão</div>
          <div className="dl-done-list">
            {done.map((d, i) => (
              <div className="dl-row done" key={i}>
                <div className="dl-ic"><Icon n={d.kind === "sync" ? "refresh" : "content"} /></div>
                <div className="dl-main"><div className="dl-top"><b>{d.name}</b><span className="st"><span className="pill ok">concluído</span></span></div></div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================== Amigos =====
const FRIENDS_KEY = "aether.launcher.friends";
function loadFriends(): string[] {
  try { const v = JSON.parse(localStorage.getItem(FRIENDS_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

function FriendsSection({ engine }: { engine: Engine }) {
  const [friends, setFriends] = useState<string[]>(loadFriends);
  const [name, setName] = useState("");
  const onlineNames = new Set((engine.info?.players?.names ?? []).map((n) => n.toLowerCase()));

  function save(next: string[]) { setFriends(next); localStorage.setItem(FRIENDS_KEY, JSON.stringify(next)); }
  function add() {
    const n = name.trim();
    if (!n || friends.some((f) => f.toLowerCase() === n.toLowerCase())) { setName(""); return; }
    save([...friends, n]); setName("");
  }
  const sorted = [...friends].sort((a, b) =>
    (onlineNames.has(b.toLowerCase()) ? 1 : 0) - (onlineNames.has(a.toLowerCase()) ? 1 : 0) || a.localeCompare(b));

  return (
    <div className="page">
      <SectionHeading eyebrow="Você" title="Amigos" />
      <div className="friend-add">
        <input value={name} maxLength={16} placeholder="Nome de jogador…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn primary" disabled={!name.trim()} onClick={add}>Adicionar amigo</button>
      </div>

      {friends.length === 0 ? (
        <EmptyState icon="friends" title="Nenhum amigo ainda" description="Adicione pelo nome de jogador para ver rapidinho quem está online no servidor." />
      ) : (
        <div className="friend-list">
          {sorted.map((f) => {
            const on = onlineNames.has(f.toLowerCase());
            return (
              <div key={f} className="friend-row">
                <span className={`friend-av ${on ? "on" : ""}`}>{f.charAt(0).toUpperCase()}</span>
                <span className="friend-name">{f}</span>
                <span className={`friend-status ${on ? "on" : ""}`}>{on ? "online" : "offline"}</span>
                <button className="btn ghost mini" onClick={() => save(friends.filter((x) => x !== f))} title="Remover">Remover</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="ctxhint"><Icon n="players" /><span>"Online" mostra quais dos seus amigos estão no <b>{engine.info?.instance_name ?? "servidor"}</b> agora. A lista fica salva neste computador.</span></div>
    </div>
  );
}

// ============================================================== Mundos ======
interface WorldRow { folder: string; name: string; icon: string | null; last_played: number }

/** Tempo relativo curto em pt-BR, a partir de um timestamp Unix em segundos. */
function relTime(secs: number): string {
  if (!secs) return "";
  const diff = Date.now() / 1000 - secs;
  if (diff < 3600) return "há pouco";
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} ${months === 1 ? "mês" : "meses"}`;
  const years = Math.floor(months / 12);
  return `há ${years} ${years === 1 ? "ano" : "anos"}`;
}

function WorldsSection({ server }: { server: Server }) {
  const [worlds, setWorlds] = useState<WorldRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setWorlds(null);
    setError("");
    invoke<WorldRow[]>("local_worlds", { dir: server.dir })
      .then((w) => { if (alive) setWorlds(w); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [server.dir]);

  return (
    <div className="page">
      <SectionHeading eyebrow="Você" title="Mundos" />

      {error && <div className="error">Não consegui ler seus mundos: {error}</div>}
      {!worlds && !error && <div className="mods-loading">Procurando mundos…</div>}
      {worlds && worlds.length === 0 && !error && (
        <EmptyState icon="worlds" title="Nenhum mundo ainda" description="Quando você criar ou entrar em um mundo, ele aparece aqui. Os mundos ficam em saves/, dentro da pasta do jogo." />
      )}
      {worlds && worlds.length > 0 && (
        <div className="world-grid">
          {worlds.map((w) => (
            <div key={w.folder} className="world-card" title={w.folder}>
              <div className="world-cover">
                {w.icon ? <img src={w.icon} alt="" /> : <div className="world-cover-empty"><Icon n="worlds" /></div>}
              </div>
              <div className="world-meta">
                <div className="world-name" title={w.name}>{w.name}</div>
                {w.last_played > 0 && <div className="world-when">{relTime(w.last_played)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

// ================================================================ Mapa ======
function MapSection({ server }: { server: Server }) {
  const url = server.mapUrl?.trim();
  const [key, setKey] = useState(0);

  if (!url) {
    return (
      <div className="page">
        <SectionHeading title="Explore além do horizonte" description="Veja o mundo e as construções do servidor em um só lugar." eyebrow="Mapa" />
        <EmptyState icon="map" title="Seu mundo, visto de cima" description="Conecte o mapa web do servidor para acompanhar suas próximas explorações." />
        <div className="soon">
          <h4>Configure o mapa</h4>
          <p className="hint">O mapa vem de um servidor de mapa web (BlueMap ou Dynmap) rodando no seu servidor. Com ele no ar:</p>
          <ul>
            <li>vá em <b>Servidores → Editar</b> e cole a <b>URL do mapa</b> (ex.: <code>http://192.168.1.10:8100</code>).</li>
            <li>volte aqui — o mapa aparece embutido.</li>
          </ul>
          <p className="hint">Peça ao administrador o endereço do mapa do servidor.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page map-page">
      <div className="page-head">
        <SectionHeading title="Mapa do servidor" description={server.label ?? "Explore seu mundo"} eyebrow="Exploração" />
        <div className="actions">
          <button className="btn ghost" onClick={() => setKey((k) => k + 1)}>Recarregar</button>
          <button className="btn ghost" onClick={() => openUrl(url)}>Abrir no navegador</button>
        </div>
      </div>
      <iframe key={key} className="map-frame" src={url} title="Mapa do servidor" referrerPolicy="no-referrer" />
    </div>
  );
}
