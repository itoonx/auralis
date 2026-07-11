#!/usr/bin/env node
// Session capture: Claude Code hooks → oracle-lite. Runs alongside Cognee (different lanes, no conflict):
// Cognee is global ambient memory; this is the REPO's engineering brain — the same one the fleet uses, so
// what you tell Claude Code becomes recallable by workers, and fleet findings surface back in your session.
//
// The whole point is the INGRESS: every event is classified into the right lane AT WRITE TIME,
// deterministically, with no LLM in the path (free, instant-searchable — no cognify queue):
//   knowledge      → /api/learn  (docs: ranked, trust-tiered from birth, decays unless cited)
//   observability  → /api/event  (timeline only — NEVER pollutes recall; the retrieved-but-never-cited lesson)
//   already-durable→ dropped     (git records commits; don't save what the repo already records)
//
// Fail-silent by design: a dead oracle or a slow request must never break the user's session.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// Carry the same ORACLE_TOKEN / ORACLE_API_URL the container reads: one repo .env feeds both the daemon
// (via compose) and this host-side hook, so once auth is on the hook still authenticates. Without this the
// POST below would 401 and be swallowed by its fail-silent catch — the brain would stop learning, silently.
// Skip under vitest: this module is imported for its pure functions there, and loading prod secrets into
// the test process would make the tests' scratch oracle demand auth and break the suite.
if (!process.env.VITEST) {
  try { process.loadEnvFile(fileURLToPath(new URL("../.env.oracle", import.meta.url))); } catch { /* no .env.oracle — fine */ }
}

const ORACLE = process.env.ORACLE_API_URL ?? "http://localhost:47778";
const TIMEOUT = 1500; // ms — a memory write is never worth a laggy prompt
const AUTH = process.env.ORACLE_TOKEN ? { authorization: `Bearer ${process.env.ORACLE_TOKEN}` } : {};

// Ingress secret-scrub: a pasted key/token must NEVER reach the persistent brain. It did once — an OpenAI
// key landed in docs.content (2 chunks) and events.human (3 prompt logs) before this existed. Redact at the
// source, so every downstream use (learn, event, recall query) is already clean. Patterns are conservative:
// each requires the vendor prefix + a real-length secret body, so ordinary prose ("risky", "task-3") is safe.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,                 // OpenAI / Anthropic (sk-, sk-proj-, sk-ant-)
  /gh[pousr]_[A-Za-z0-9]{20,}/g,            // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /AKIA[0-9A-Z]{16}/g,                      // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/g,                 // Google API key
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,          // Slack token
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g,// bearer / authorization tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM key blocks
];
export function scrub(s) {
  let out = String(s ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// ---- pure ingress classifier (unit-tested) ----------------------------------------------------------
// Decide what to do with one hook payload. Returns a list of actions; the I/O layer just executes them.
export function route(payload) {
  const kind = payload?.hook_event_name;
  const project = basename(payload?.cwd ?? "") || "session";
  const actions = [];

  // Fleet workers are Claude subprocesses that inherit this repo's hooks — their prompts/answers are NOT
  // the human's session. Found live: a worker prompt landed as a trust-1.0 "human instruction". Stand down.
  // AURALIS_NO_CAPTURE covers the same hazard for benchmark/harness SDK sub-queries (pnpm lme): found live —
  // 89 LongMemEval answer-prompts leaked into the prod brain because the hook fires on those sub-sessions too.
  if (process.env.AURALIS_FLEET || process.env.AURALIS_NO_CAPTURE) return actions;

  if (kind === "UserPromptSubmit") {
    const prompt = scrub(String(payload?.prompt ?? "").trim());
    if (!prompt || prompt.startsWith("/") || prompt.startsWith("!")) return actions; // slash/shell — not knowledge
    if (prompt.startsWith("<")) return actions; // harness payloads (<task-notification> etc.) — not human words
    // Always on the timeline (episodic); into the brain only when substantive. Human ground truth is born
    // trust 1.0 (source prefix "human") but NOT pinned — an instruction nobody ever recalls should fade.
    actions.push({ type: "event", project, kind: "prompt", actor: "human", human: `🗣 ${clip(prompt, 200)}` });
    actions.push({ type: "recall", project, query: prompt }); // BEFORE learn — don't echo this prompt back at itself
    if (prompt.length >= 80) {
      actions.push(...learnChunks(project, "human:prompt", "User instruction (session): ", prompt));
    }
    return actions;
  }

  if (kind === "PostToolUse") {
    const tool = String(payload?.tool_name ?? "");
    // Only writes are worth a timeline mark; traces are observability, never knowledge. Everything else is noise.
    if (tool === "Write" || tool === "Edit") {
      const file = payload?.tool_input?.file_path;
      if (file) actions.push({ type: "event", project, kind: "trace", actor: "claude-code", human: `✎ ${tool} ${file}`, refs: [file] });
    }
    return actions;
  }

  if (kind === "Stop") {
    const text = scrub(lastAssistantText(payload?.transcript_path));
    if (!text) return actions;
    // The timeline shows the full exchange — prompt → traces → ANSWER — so a replay reads as a story.
    if (text.length >= 40) actions.push({ type: "event", project, kind: "answer", actor: "claude-code", human: `✦ ${clip(text, 200)}` });
    // Into the brain only when substantive; born agent-tier (0.5) — credibility is earned via cite.
    if (text.length >= 120) {
      actions.push(...learnChunks(project, "session:assistant", "Assistant conclusion (session): ", text));
    }
    return actions;
  }

  return actions;
}

const clip = (s, n) => s.replace(/\s+/g, " ").trim().slice(0, n);

// A memory unit is a unit of thought, not a turn (LongMemEval diagnosis, 58%→76%): clip() at write time
// threw away everything past the cut — unrecoverable in an append-only store. Long text splits at
// sentence boundaries instead; nothing is lost, and each chunk fits whole in a recall excerpt.
export function chunkTurn(text, max = 600) {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?\n])\s+/).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > max) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Learn actions for one lane: chunk, then give continuation chunks a [re: …] anchor — a mid-list chunk
// ("7. Transcriptionist…") loses the topic words that make it findable without one.
function learnChunks(project, source, prefix, text) {
  const t = text.trim().slice(0, 6000); // ponytail: 6k ceiling, raise if a real conclusion outgrows it
  const chunks = chunkTurn(t).map((c) => clip(c, 600));
  const anchor = chunks.length > 1 ? chunks[0].slice(0, 80).replace(/\s+\S*$/, "") : "";
  return chunks.map((c, i) => ({
    type: "learn", project, source, pinned: false,
    pattern: i === 0 ? `${prefix}${c}` : `${prefix}[re: ${anchor}…] ${c}`,
  }));
}

// Last assistant text from the session transcript (JSONL). Tolerant: any failure → null, capture skipped.
function lastAssistantText(path) {
  if (!path) return null;
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let m;
      try { m = JSON.parse(lines[i]); } catch { continue; }
      if (m?.type === "assistant") {
        const blocks = m?.message?.content ?? [];
        const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
        if (text) return text;
      }
    }
  } catch { /* no transcript — skip */ }
  return null;
}

// ---- I/O layer --------------------------------------------------------------------------------------
async function post(path, body) {
  try {
    await fetch(new URL(path, ORACLE), {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch { /* oracle down or slow — the session must not care */ }
}

async function recall(project, query) {
  try {
    const u = new URL("/api/search", ORACLE);
    u.searchParams.set("q", query.slice(0, 300));
    u.searchParams.set("project", project);
    u.searchParams.set("limit", "3");
    // M2 adjacency expansion, flag-gated (default OFF): hits carry their neighbouring chunks —
    // useful when the answer to "what came after X" lives in the chunk next to the match.
    if (process.env.AURALIS_RECALL_EXPAND === "1") u.searchParams.set("expand", "1");
    const r = await fetch(u, { headers: AUTH, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) return null;
    const hits = (await r.json()).results ?? [];
    if (!hits.length) return null;
    const lines = hits.map((h) => {
      let l = `- [${h.id}] ${clip(String(h.content), 220)}`;
      for (const n of h.neighbors ?? []) l += `\n  ↳ ${clip(String(n.content), 160)}`;
      return l;
    });
    return `[oracle-lite recall — this repo's brain]\n${lines.join("\n")}\n(if one materially helps, cite it: mcp__oracle__cite)`;
  } catch {
    return null;
  }
}

// When installed globally (~/.claude/settings.json) AND the repo wires this hook itself, both copies
// fire on every event — the global one stands down or every prompt in this repo lands twice.
export function isDuplicateInstall(hookPath, cwd, readSettings) {
  if (!cwd || hookPath.startsWith(cwd)) return false; // repo-local install: always runs
  try { return readSettings(`${cwd}/.claude/settings.json`).includes("session-capture"); } catch { return false; }
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { /* no stdin — nothing to do */ }
  if (isDuplicateInstall(process.argv[1] ?? "", payload?.cwd ?? "", (p) => readFileSync(p, "utf8"))) process.exit(0);
  const actions = route(payload);
  let context = null;
  for (const a of actions) {
    if (a.type === "event") await post("/api/event", { runId: `session:${payload?.session_id ?? "unknown"}`, project: a.project, kind: a.kind, actor: a.actor, human: a.human, refs: a.refs });
    else if (a.type === "learn") await post("/api/learn", { pattern: a.pattern, project: a.project, source: a.source, pinned: a.pinned });
    else if (a.type === "recall") context = await recall(a.project, a.query);
  }
  if (context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
  }
  process.exit(0); // ALWAYS 0 — capture is best-effort, never a gate
}

// Only run the I/O when invoked as a hook, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) main();
