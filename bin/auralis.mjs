#!/usr/bin/env node
// auralis — Supabase-style CLI for the production stack (docs/prd-production-docker.md).
// A thin, boring wrapper over `docker compose`: no daemon manager of its own — compose IS the daemon
// manager (restart: unless-stopped). Zero dependencies.
//
//   auralis start [--share]     bring the stack up in the background, wait for healthy, print URLs
//   auralis stop                take it down (the brain survives — bind mount)
//   auralis status              services + health + brain stats
//   auralis logs [svc] [-f]     compose logs
//   auralis restart [svc]
//   auralis backup [--install|--uninstall]   WAL-safe brain snapshot; --install schedules it daily
//   auralis doctor              docker? compose file? ports? brain reachable? token? reboot-ready?
import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = process.env.ORACLE_API_URL ?? "http://localhost:47778";
// The CLI authenticates like every internal caller: ORACLE_TOKEN from the environment, else .env.oracle —
// otherwise `status`/`doctor` read a 401 body and report "undefined docs" on an authed stack.
const ENV_ORACLE = join(ROOT, ".env.oracle");
const TOKEN = process.env.ORACLE_TOKEN ?? (existsSync(ENV_ORACLE) ? readFileSync(ENV_ORACLE, "utf8").match(/^ORACLE_TOKEN=(.+)$/m)?.[1] : undefined);
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const [cmd, ...rest] = process.argv.slice(2);

const sh = (args, opts = {}) => spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: "inherit", ...opts });
const compose = (...args) => sh(["docker", "compose", ...args]);
const composeJson = () => {
  try {
    const out = execSync("docker compose ps --format json", { cwd: ROOT, encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const health = async (base = ORACLE) => {
  try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
};

// -- backup: WAL-safe brain snapshots (Supabase-style) -------------------------------------------------
// SEPARATE from the server's /api/snapshot 5-slot pre-mutation safety net: this is the periodic backup,
// its own dir + retention so daily copies are never evicted by pre-sleep snapshots.
const DAILY_DIR = join(ROOT, ".auralis-out", "backups", "daily");
const DAILY_KEEP = 14;
const PLIST = join(homedir(), "Library", "LaunchAgents", "dev.auralis.backup.plist");
const BRAIN = join(ROOT, ".auralis-out", "brain.sqlite");

function backup() {
  if (!existsSync(BRAIN)) return fail(`brain not found: ${BRAIN}`);
  mkdirSync(DAILY_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-07-10T11-50-00
  const out = join(DAILY_DIR, `brain-${ts}.db`);
  // WAL-safe: SQLite's online-backup API via the sqlite3 CLI — NOT `cp` (a raw copy of a live WAL'd db
  // corrupts; found live while a daemon held it open). LanceDB vectors are re-derivable by re-embedding
  // the docs, so the sqlite brain (source of truth) IS the whole backup.
  if (sh(["sqlite3", BRAIN, `.backup ${out}`]).status !== 0 || !existsSync(out)) return fail("sqlite3 .backup failed");
  const kept = readdirSync(DAILY_DIR).filter((f) => /^brain-.*\.db$/.test(f)).sort(); // ISO names sort chronologically
  for (const f of kept.slice(0, -DAILY_KEEP)) unlinkSync(join(DAILY_DIR, f)); // prune oldest beyond KEEP
  console.log(`✓ backup → ${out}  (${Math.min(kept.length, DAILY_KEEP)} kept, max ${DAILY_KEEP})`);
}

function installSchedule() {
  // No cron on stock macOS → launchd. Absolute paths only (LaunchAgents run with a minimal PATH).
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.auralis.backup</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${join(ROOT, "bin", "auralis.mjs")}</string>
    <string>backup</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${join(ROOT, ".auralis-out", "backups", "backup.log")}</string>
  <key>StandardErrorPath</key><string>${join(ROOT, ".auralis-out", "backups", "backup.log")}</string>
</dict></plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);
  sh(["launchctl", "unload", PLIST], { stdio: "ignore" }); // idempotent reinstall
  if (sh(["launchctl", "load", PLIST]).status !== 0) return fail("launchctl load failed");
  console.log(`✓ daily backup scheduled 04:00 → ${PLIST}`);
}

function uninstallSchedule() {
  sh(["launchctl", "unload", PLIST], { stdio: "ignore" });
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log("✓ daily backup schedule removed");
}

// -- bge-sidecar: the semantic embed+rerank service (src/bge-sidecar.py) -------------------------------
// A HOST process, not a compose service: it needs Apple-GPU (MPS) which containers can't reach. The oracle
// container reaches it via host.docker.internal (ORACLE_EMBED_URL/ORACLE_RERANK_URL in .env.oracle). If it's
// down the oracle degrades per-call to its builtin embedder — counted in /api/stats embed_fallbacks, so a
// rising counter is the "sidecar is down" alarm. KeepAlive restarts it on crash and on reboot.
const SIDECAR_PLIST = join(homedir(), "Library", "LaunchAgents", "dev.auralis.bge-sidecar.plist");
const SIDECAR_PY = join(ROOT, ".auralis-out", "venv-bge", "bin", "python");

function installSidecar() {
  if (!existsSync(SIDECAR_PY)) return fail(`venv not found: ${SIDECAR_PY}  (python3 -m venv .auralis-out/venv-bge && .auralis-out/venv-bge/bin/pip install FlagEmbedding)`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.auralis.bge-sidecar</string>
  <key>ProgramArguments</key><array>
    <string>${SIDECAR_PY}</string>
    <string>${join(ROOT, "src", "bge-sidecar.py")}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(ROOT, ".auralis-out", "bge-sidecar.log")}</string>
  <key>StandardErrorPath</key><string>${join(ROOT, ".auralis-out", "bge-sidecar.log")}</string>
</dict></plist>
`;
  mkdirSync(dirname(SIDECAR_PLIST), { recursive: true });
  writeFileSync(SIDECAR_PLIST, plist);
  sh(["launchctl", "unload", SIDECAR_PLIST], { stdio: "ignore" }); // idempotent reinstall
  if (sh(["launchctl", "load", SIDECAR_PLIST]).status !== 0) return fail("launchctl load failed");
  console.log(`✓ bge-sidecar autostart installed (KeepAlive) → ${SIDECAR_PLIST}`);
}

function uninstallSidecar() {
  sh(["launchctl", "unload", SIDECAR_PLIST], { stdio: "ignore" });
  if (existsSync(SIDECAR_PLIST)) unlinkSync(SIDECAR_PLIST);
  console.log("✓ bge-sidecar autostart removed (running instance stopped)");
}

async function sidecarStatus() {
  try {
    const r = await (await fetch("http://127.0.0.1:47783/health", { signal: AbortSignal.timeout(10_000) })).json();
    console.log(`  bge-sidecar  ${r.ok ? "✅" : "✗"} ${r.model ?? ""} dim=${r.dim ?? "?"} sparse=${!!r.sparse}`);
  } catch { console.log("  bge-sidecar  ✗ unreachable on :47783"); }
  console.log(`  autostart    ${existsSync(SIDECAR_PLIST) ? "✅ installed" : "✗ not installed (auralis sidecar --install)"}`);
}

// -- setup: zero → running, one command, idempotent (re-run any time; every step skips what exists) ------
const envOracleHas = (key) => existsSync(ENV_ORACLE) && readFileSync(ENV_ORACLE, "utf8").includes(`${key}=`);

async function setup() {
  const noSemantic = rest.includes("--no-semantic");
  // 1 · preflight — hard requirements first, one clear list (no partial installs on a broken machine)
  const need = [
    ["node 20+", true], // you're running it
    ["pnpm", sh(["pnpm", "--version"], { stdio: "ignore" }).status === 0],
    ["bun", sh(["bun", "--version"], { stdio: "ignore" }).status === 0],
    ["docker", sh(["docker", "info"], { stdio: "ignore" }).status === 0],
    ["sqlite3", sh(["sqlite3", "--version"], { stdio: "ignore" }).status === 0],
  ];
  const missing = need.filter(([, ok]) => !ok).map(([n]) => n);
  console.log("① prerequisites");
  for (const [n, ok] of need) console.log(`   ${ok ? "✅" : "✗"} ${n}`);
  if (missing.length) return fail(`install these first, then re-run: ${missing.join(", ")}`);
  const hasPython = sh(["python3", "--version"], { stdio: "ignore" }).status === 0;

  // 2 · deps
  console.log("② dependencies");
  if (existsSync(join(ROOT, "node_modules"))) console.log("   ✅ node_modules (skip)");
  else if (sh(["pnpm", "install"]).status !== 0) return fail("pnpm install failed");

  // 3 · secrets — BEFORE the stack, so containers are created with auth already wired
  console.log("③ auth secrets (.env.oracle)");
  for (const key of ["ORACLE_TOKEN", "ORACLE_JWT_SECRET"]) {
    if (envOracleHas(key)) { console.log(`   ✅ ${key} (exists)`); continue; }
    appendFileSync(ENV_ORACLE, `${key}=${randomBytes(32).toString("hex")}\n`);
    console.log(`   ✅ ${key} generated`);
  }

  // 4 · semantic sidecar (optional; before `start` so the oracle is created pointing at it)
  if (!noSemantic && hasPython) {
    console.log("④ semantic recall (BGE-M3 sidecar)");
    if (!existsSync(SIDECAR_PY)) {
      console.log("   · creating venv + installing FlagEmbedding (~2GB, one-time)…");
      if (sh(["python3", "-m", "venv", join(ROOT, ".auralis-out", "venv-bge")]).status !== 0) return fail("venv failed");
      if (sh([join(ROOT, ".auralis-out", "venv-bge", "bin", "pip"), "install", "-q", "FlagEmbedding"]).status !== 0) return fail("pip install FlagEmbedding failed");
    } else console.log("   ✅ venv (exists)");
    if (!envOracleHas("ORACLE_EMBED_URL")) {
      appendFileSync(ENV_ORACLE, "ORACLE_EMBED_URL=http://host.docker.internal:47783\nORACLE_RERANK_URL=http://host.docker.internal:47783\n");
      console.log("   ✅ oracle → sidecar URLs added");
    } else console.log("   ✅ sidecar URLs (exist)");
    installSidecar(); // idempotent; launchd starts it now and on every login/crash
  } else console.log(`④ semantic recall — skipped (${noSemantic ? "--no-semantic" : "python3 not found"}); brain runs lexical-only`);

  // 5 · the stack (builds dashboard on first run, waits for healthy) + daily backup
  console.log("⑤ stack");
  await start();
  console.log("⑥ daily backup schedule");
  installSchedule();

  // 6 · first-run semantic backfill — the model downloads ~4.6GB lazily; don't block setup forever
  if (!noSemantic && hasPython) {
    process.stdout.write("⑦ waiting for the sidecar model (first run downloads ~4.6GB)");
    let up = false;
    for (let i = 0; i < 36; i++) { // ~3 min, then hand off
      try { if ((await fetch("http://127.0.0.1:47783/health", { signal: AbortSignal.timeout(5000) })).ok) { up = true; break; } } catch { /* loading */ }
      process.stdout.write("."); await new Promise((r) => setTimeout(r, 5000));
    }
    console.log("");
    if (up) {
      const token = readFileSync(ENV_ORACLE, "utf8").match(/^ORACLE_TOKEN=(.+)$/m)?.[1] ?? "";
      try {
        const r = await (await fetch(`${ORACLE}/api/reembed`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(600_000) })).json();
        console.log(`   ✅ brain embedded semantically: ${r.embedded}/${r.docs} (fallbacks ${r.embed_fallbacks ?? 0})`);
      } catch { console.log("   ⚠ reembed didn't finish — run later: auralis reembed"); }
    } else console.log("   ⚠ still downloading — later, when `auralis sidecar` shows ✅, run: auralis reembed");
  }

  console.log("\n✓ setup complete — `auralis doctor` any time to re-check\n");
  await doctor();
}

// one-shot backfill of the vector table (used by setup; safe to re-run — it rebuilds idempotently)
async function reembed() {
  const token = existsSync(ENV_ORACLE) ? (readFileSync(ENV_ORACLE, "utf8").match(/^ORACLE_TOKEN=(.+)$/m)?.[1] ?? "") : "";
  try {
    const r = await (await fetch(`${ORACLE}/api/reembed`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(600_000) })).json();
    if (r.error) return fail(`reembed: ${r.error}`);
    console.log(`✓ reembedded ${r.embedded}/${r.docs} docs (embedder=${r.embedder}, fallbacks=${r.embed_fallbacks ?? 0})`);
  } catch (e) { fail(`oracle unreachable or reembed failed: ${String(e).slice(0, 120)}`); }
}

async function start() {
  const share = rest.includes("--share");
  // studio ships the dashboard's production build — build it if missing (host-build keeps the image tiny).
  if (!existsSync(join(ROOT, "dashboard/dist/index.html"))) {
    console.log("· building dashboard (first run)…");
    if (sh(["pnpm", "-C", "dashboard", "build"]).status !== 0) return fail("dashboard build failed");
  }
  const args = ["up", "-d", "--build"];
  if (share) args.splice(1, 0, "--profile", "share");
  if (compose(...args).status !== 0) return fail("docker compose up failed");
  process.stdout.write("· waiting for healthy");
  for (let i = 0; i < 60; i++) {
    const rows = composeJson();
    if (rows.length >= 2 && rows.every((r) => /healthy/.test(r.Health ?? ""))) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("\n");
  console.log("auralis is running (daemon — survives terminal close; `auralis stop` to end it)\n");
  console.log(`  studio     http://localhost:47780`);
  console.log(`  oracle API ${ORACLE}${process.env.ORACLE_TOKEN ? "   (ORACLE_TOKEN required)" : ""}`);
  console.log(`  data dir   ${join(ROOT, ".auralis-out")} (bind mount — survives rebuilds)`);
  if (share) console.log(`  tunnel     docker compose logs tunnel | grep trycloudflare`);
  console.log(`\n  fleet/MCP on this machine: ORACLE_API_URL=${ORACLE}`);
  await status();
}

async function status() {
  const rows = composeJson();
  if (!rows.length) return console.log("stack is not running (`auralis start`)");
  console.log("\nSERVICE   STATE");
  for (const r of rows) console.log(`  ${String(r.Service).padEnd(8)} ${r.Status}`);
  if (await health()) {
    try {
      const s = await (await fetch(`${ORACLE}/api/stats`, { headers: AUTH, signal: AbortSignal.timeout(2000) })).json();
      console.log(`  brain    ${s.count} docs · ${s.edges} edges · vectors=${s.vectors ? "on" : "off"}`);
    } catch { console.log("  brain    reachable (stats need ORACLE_TOKEN)"); }
  } else console.log("  brain    UNREACHABLE");
}

async function doctor() {
  const orbLogin = (() => { try { return execSync("orb config get app.start_at_login", { encoding: "utf8" }).trim() === "true"; } catch { return false; } })();
  const checks = [];
  checks.push(["docker", sh(["docker", "--version"], { stdio: "ignore" }).status === 0]);
  checks.push(["compose file", existsSync(join(ROOT, "docker-compose.yml"))]);
  checks.push(["dashboard dist", existsSync(join(ROOT, "dashboard/dist/index.html"))]);
  checks.push(["oracle reachable", await health()]);
  checks.push(["token set", !!TOKEN]);
  checks.push(["reboot: orbstack start-at-login", orbLogin]);
  checks.push(["backup: sqlite3 present", sh(["sqlite3", "--version"], { stdio: "ignore" }).status === 0]);
  checks.push(["backup: daily schedule installed", existsSync(PLIST)]);
  checks.push(["bge-sidecar reachable", await health("http://127.0.0.1:47783")]);
  checks.push(["bge-sidecar autostart installed", existsSync(SIDECAR_PLIST)]);
  for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "✗"} ${name}`);
  const critical = checks.slice(0, 2).every(([, ok]) => ok);
  if (!critical) fail("docker or compose file missing");
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

switch (cmd) {
  case "setup": await setup(); break;
  case "reembed": await reembed(); break;
  case "start": await start(); break;
  case "stop": compose("down"); break;
  case "status": await status(); break;
  case "restart": compose("restart", ...rest.filter((a) => !a.startsWith("-"))); break;
  case "logs": compose("logs", ...rest); break;
  case "backup":
    if (rest.includes("--install")) installSchedule();
    else if (rest.includes("--uninstall")) uninstallSchedule();
    else backup();
    break;
  case "sidecar":
    if (rest.includes("--install")) installSidecar();
    else if (rest.includes("--uninstall")) uninstallSidecar();
    else await sidecarStatus();
    break;
  case "doctor": await doctor(); break;
  default:
    console.log("auralis — production stack CLI\n");
    console.log("  auralis setup [--no-semantic]  ONE command: prereq check → deps → auth → sidecar → stack → backup");
    console.log("  auralis start [--share]   up as daemons (+public tunnel with --share)");
    console.log("  auralis stop              down (brain data survives)");
    console.log("  auralis status            services + brain stats");
    console.log("  auralis logs [svc] [-f]   service logs");
    console.log("  auralis restart [svc]");
    console.log("  auralis backup            WAL-safe brain snapshot now (keeps last 14)");
    console.log("  auralis backup --install  schedule a daily backup (launchd, 04:00)");
    console.log("  auralis sidecar           bge-sidecar (semantic embed+rerank) health");
    console.log("  auralis sidecar --install autostart it via launchd (KeepAlive, reboot-safe)");
    console.log("  auralis doctor            environment + reboot/backup readiness");
    process.exit(cmd ? 1 : 0);
}
