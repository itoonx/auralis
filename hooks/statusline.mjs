#!/usr/bin/env node
// auralis statusline for Claude Code — one line, refreshed by the CLI:
//   📦 <active project scope> · ⎇ <branch><dirty*> · <model> · ctx <tokens> (<pct>%) · $<cost> · +added/-removed
// The PROJECT is the same ground truth the session-capture hook resolves (the repo your Write/Edits actually
// land in, remembered per session in ${tmpdir}/auralis-scope-<session_id>) — so the bar always names the
// project the brain is capturing to, not merely the directory the session was launched from.
// Fail-silent everywhere: a statusline must never break or slow the CLI (every probe has a timeout/fallback).
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir, homedir } from "node:os";

let d = {};
try { d = JSON.parse(readFileSync(0, "utf8")); } catch { /* no stdin — render what we can */ }

const sid = d.session_id ?? "unknown";
const cwd = d.workspace?.current_dir ?? d.cwd ?? process.cwd();

// Active scope: the capture hook's state file wins (work-follows-files); launch dir is the fallback.
let scope = "";
try { scope = readFileSync(join(tmpdir(), `auralis-scope-${sid}`), "utf8").trim(); } catch { /* no writes yet */ }
if (!scope) scope = basename(cwd) || "session";

// Branch + dirty marker of the ACTIVE project (not the launch dir): ~/git/project/<scope> when it exists.
const git = (dir, args) => execSync(`git -C ${JSON.stringify(dir)} ${args}`, { timeout: 800, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
let branch = "";
try {
  const projDir = [join(homedir(), "git", "project", scope), cwd].find((p) => existsSync(join(p, ".git")));
  if (projDir) {
    branch = git(projDir, "symbolic-ref --short -q HEAD") || git(projDir, "rev-parse --short HEAD");
    if (git(projDir, "status --porcelain --untracked-files=no").length) branch += "*";
  }
} catch { /* detached/none — skip */ }

// Context size: last usage block in the transcript tail (the CLI does not pass token counts directly).
// Tail-read only (256 KiB) — transcripts grow to many MB and this runs on every refresh.
let ctx = null;
try {
  const p = d.transcript_path;
  const size = statSync(p).size;
  const N = Math.min(size, 262144);
  const fd = openSync(p, "r");
  const buf = Buffer.alloc(N);
  readSync(fd, buf, 0, N, size - N);
  closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const u = JSON.parse(lines[i])?.message?.usage;
      if (u?.input_tokens != null) {
        ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        break;
      }
    } catch { /* partial tail line — keep scanning */ }
  }
} catch { /* no transcript — skip */ }

const DIM = "\x1b[2m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m", RED = "\x1b[31m", RESET = "\x1b[0m";
const parts = [`${CYAN}📦 ${scope}${RESET}`];
if (branch) parts.push(`⎇ ${branch}`);
const model = d.model?.display_name ?? d.model?.id ?? "";
if (model) parts.push(model);
if (ctx != null) {
  const k = ctx >= 1000 ? `${Math.round(ctx / 1000)}k` : String(ctx);
  // Percent only when the CLI tells us the window size — models differ (this machine has seen >400k live),
  // so a hard-coded 200k denominator would lie. Unknown limit → tokens only, no colour judgement.
  const limit = d.context_window ?? d.model?.context_window ?? d.context?.limit ?? null;
  if (limit > 0) {
    const pct = Math.round((ctx / limit) * 100);
    const tone = pct >= 90 ? RED : pct >= 70 ? YELLOW : "";
    parts.push(`${tone}ctx ${k} (${pct}%)${tone ? RESET : ""}`);
  } else {
    parts.push(`ctx ${k}`);
  }
}
const cost = d.cost?.total_cost_usd;
if (typeof cost === "number" && cost > 0) parts.push(`$${cost.toFixed(2)}`);
const la = d.cost?.total_lines_added ?? 0, lr = d.cost?.total_lines_removed ?? 0;
if (la + lr > 0) parts.push(`+${la}/-${lr}`);
console.log(parts.join(`${DIM} · ${RESET}`));
