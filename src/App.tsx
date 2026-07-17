import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import "./App.css";

interface Config {
  server: string;
  profileId: string;
  dir: string;
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

interface Progress {
  stage: "download" | "retire" | "done";
  path: string;
  done: number;
  total: number;
}

interface JavaInfo {
  path: string;
  version: string;
}

function loadConfig(): Config | null {
  const raw = localStorage.getItem("aether.launcher.config");
  return raw ? (JSON.parse(raw) as Config) : null;
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

export default function App() {
  const [config, setConfig] = useState<Config | null>(loadConfig);
  return config ? (
    <MainScreen config={config} onEdit={() => setConfig(null)} />
  ) : (
    <SetupScreen
      initial={loadConfig()}
      onSave={(c) => {
        localStorage.setItem("aether.launcher.config", JSON.stringify(c));
        setConfig(c);
      }}
    />
  );
}

function SetupScreen({
  initial,
  onSave,
}: {
  initial: Config | null;
  onSave: (c: Config) => void;
}) {
  const [server, setServer] = useState(initial?.server ?? "");
  const [profileId, setProfileId] = useState(initial?.profileId ?? "");
  const [dir, setDir] = useState(initial?.dir ?? "");
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
      onSave({ server: server.trim(), profileId: profileId.trim(), dir });
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="shell" style={{ justifyContent: "center" }}>
      <div className="brand">
        <div className="logo" />
        <h1>Aether Launcher</h1>
      </div>
      <div className="card">
        <div className="field">
          <label>Endereço do servidor</label>
          <input
            placeholder="http://192.168.20.57:8600"
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
          <label>Pasta do jogo</label>
          <div className="row">
            <input placeholder="C:\...\.minecraft" value={dir} readOnly />
            <button onClick={pickDir}>Escolher…</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <button
          className="primary big"
          disabled={!server.trim() || !profileId.trim() || !dir || testing}
          onClick={save}
        >
          {testing ? "Verificando…" : "Conectar"}
        </button>
      </div>
    </div>
  );
}

function MainScreen({ config, onEdit }: { config: Config; onEdit: () => void }) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [java, setJava] = useState<JavaInfo | null | "loading">("loading");
  const [javaPct, setJavaPct] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  function pushLog(line: string) {
    setLog((prev) => [...prev.slice(-200), line]);
  }

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      invoke<ServerInfo>("server_info", {
        server: config.server,
        profileId: config.profileId,
      })
        .then((i) => !cancelled && setInfo(i))
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [config]);

  useEffect(() => {
    invoke<JavaInfo | null>("java_status")
      .then(setJava)
      .catch(() => setJava(null));
  }, []);

  useEffect(() => {
    const unlisten = listen<{ done: number; total: number }>("java-progress", (event) => {
      const { done, total } = event.payload;
      setJavaPct(total > 0 ? Math.round((done / total) * 100) : null);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function installJava() {
    setBusy(true);
    setError("");
    setJavaPct(0);
    try {
      const result = await invoke<JavaInfo>("install_java");
      setJava(result);
      pushLog(`Java instalado: ${result.version}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setJavaPct(null);
    }
  }

  useEffect(() => {
    const unlisten = listen<Progress>("sync-progress", (event) => {
      const p = event.payload;
      setProgress(p);
      if (p.stage === "download") pushLog(`baixado  ${p.path}`);
      if (p.stage === "retire") pushLog(`removido ${p.path}`);
      if (p.stage === "done") pushLog("— sincronização concluída —");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

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
    setProgress(null);
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
    } finally {
      setBusy(false);
    }
  }

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;
  const stateClass =
    info?.state === "running" ? "online" : info?.state === "crashed" ? "crashed" : "offline";

  return (
    <div className="shell">
      <div className="brand">
        <div className="logo" />
        <h1>Aether Launcher</h1>
      </div>

      <div className="card" style={{ maxWidth: 560 }}>
        <div className="server-head">
          <span className="name">{info?.instance_name ?? "Conectando…"}</span>
          {info && <span className={`badge ${stateClass}`}>{STATE_LABEL[info.state] ?? info.state}</span>}
          {info && <span className="badge">{info.channel}</span>}
          <span style={{ marginLeft: "auto" }}>
            <button className="ghost" onClick={onEdit} title="Configurações">
              ⚙
            </button>
          </span>
        </div>
        <p className="meta">
          {info
            ? `Perfil "${info.profile_name}" · ${info.files} arquivos · ${formatBytes(info.total_size)}`
            : config.server}
          <br />
          Pasta: {config.dir}
        </p>

        <div className="row">
          <button className="primary big" disabled={busy} onClick={sync}>
            {busy ? "Sincronizando…" : "Sincronizar agora"}
          </button>
          <button disabled={busy} onClick={check}>
            Verificar
          </button>
        </div>

        {pct !== null && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="meta" style={{ margin: 0 }}>
              {progress?.stage === "done"
                ? "Concluído."
                : `${progress?.done}/${progress?.total} arquivos…`}
            </p>
          </>
        )}

        {plan?.synced && !busy && <p className="ok">✔ Tudo sincronizado com o servidor.</p>}

        <p className="meta" style={{ marginBottom: 0 }}>
          Java:{" "}
          {java === "loading" ? (
            "verificando…"
          ) : java ? (
            <span style={{ color: "var(--accent)" }}>{java.version}</span>
          ) : javaPct !== null ? (
            `baixando Temurin 17… ${javaPct}%`
          ) : (
            <>
              não instalado{" "}
              <button className="ghost" disabled={busy} onClick={installJava}>
                Instalar Java 17
              </button>
            </>
          )}
        </p>

        {error && <p className="error">{error}</p>}

        <div className="log" ref={logRef}>
          {log.join("\n") || "Pronto. Clique em Sincronizar para espelhar os mods do servidor."}
        </div>
      </div>
    </div>
  );
}
