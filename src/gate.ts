// Gate-first generated verifier (adopted from disler/fusion-harness's /auto-validate — see
// memory fusion-harness-adopt). The idea auralis was missing: instead of grading the builder's PROSE report
// (what the LLM critic does), GENERATE an objective check per request and EXECUTE it against the real files.
// `runAcceptance` (src/accept.ts) already does this for 4 hardcoded specs; this generalizes it to ANY
// request by having an architect write the gate.
//
// The gate is a plain Node script (auralis is node/bun — no python/uv needed) that prints one line per
// check and exits 0 IFF every explicit requirement holds:
//   PASS: <what was verified>
//   FAIL: expected X, found Y, at <path> — <exact fix>     ← fed back to the builder verbatim
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface GateResult {
  pass: boolean;
  exitCode: number | null;
  output: string;
  passLines: string[];
  failLines: string[]; // the builder's next instructions, verbatim
  malformed: boolean; // the gate crashed / printed no PASS or FAIL line — it never graded anything
}

// VALIDATOR contract (adapted from fusion-harness SYSTEM_PROMPT_VALIDATOR, MIT). A text runner returns the
// gate SCRIPT as its whole reply; we strip any accidental fence and write it ourselves (robust to models
// that wrap code). For greenfield build tasks the REQUEST is the contract, so no project inspection is
// needed; an inspect-the-repo variant (a code runner with Read/Grep) is the next step for existing code.
const VALIDATOR = (request: string, cwd: string) =>
  `You are the VALIDATOR in an auto-validation loop: you design the ACCEPTANCE GATE that decides when a ` +
  `separate BUILDER agent's work is genuinely done. The build has NOT happened yet.\n\n` +
  `# REQUEST (the builder will be asked to do EXACTLY this)\n${request}\n\n` +
  `Project root at runtime: ${cwd}\n\n` +
  `Write a single self-contained Node.js script (built-in modules only, no dependencies, no network) that:\n` +
  `- Runs from the project root and EXECUTES the built program (spawn it, check real stdout/stderr/exit ` +
  `codes/files) — never mere file existence when behaviour was requested, never vibes.\n` +
  `- Enumerates EVERY explicit requirement in the REQUEST and maps each to at least one concrete check. ` +
  `Nothing asked for may go unchecked; nothing that wasn't asked for may be required.\n` +
  `- Prints EXACTLY one line per check to stdout:\n` +
  `    PASS: <what was verified>\n` +
  `    FAIL: expected <X>, found <Y>, at <path or command> — <exactly what to do to fix it>\n` +
  `- Uses EXACTLY ONE boolean accumulator: \`let allPass = true;\` — every failing check sets ` +
  `\`allPass = false;\`. End the script with \`process.exit(allPass ? 0 : 1);\`. Never reference a ` +
  `variable you did not declare (a common bug: naming the accumulator two different things).\n` +
  `- Deterministic, <30s, no side effects on the project (write only to os.tmpdir if you must).\n` +
  `- Against the CURRENT empty/partial state it must FAIL (red) and pass only once the request is truly done.\n\n` +
  `Output ONLY the raw script source — valid JavaScript from the first character to the last. No markdown ` +
  `fence, no explanation, and NOTHING after the final \`process.exit(...)\` line (no notes, no "skipped:" ` +
  `commentary — trailing prose corrupts the script).`;

// Strip a leading ```lang / trailing ``` fence if a model added one; otherwise pass through.
function extractScript(raw: string): string {
  const fenced = raw.match(/```(?:js|javascript|node)?\s*\n([\s\S]*?)\n```/);
  return (fenced ? fenced[1] : raw).trim();
}

export async function generateGate(request: string, cwd: string, run: (prompt: string) => Promise<string>): Promise<string> {
  return extractScript(await run(VALIDATOR(request, resolve(cwd))));
}

// Execute a gate script against a workspace. The gate lives OUTSIDE the workspace (the builder can't touch
// it) but runs with cwd = the workspace, so its relative paths resolve to the built files.
export function runGate(gateScript: string, workspace: string, timeoutMs = 30_000): GateResult {
  const dir = mkdtempSync(join(tmpdir(), "auralis-gate-"));
  const gatePath = join(dir, "gate.js");
  writeFileSync(gatePath, gateScript);
  const r = spawnSync("node", [gatePath], { cwd: resolve(workspace), timeout: timeoutMs, encoding: "utf8" });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const failLines = lines.filter((l) => /^FAIL:/i.test(l));
  const passLines = lines.filter((l) => /^PASS:/i.test(l));
  // A gate that printed NEITHER a PASS nor a FAIL line never actually graded — it crashed (undefined var,
  // syntax error, threw). That is NOT a verdict; flag it so a broken gate can't be read as pass OR fail.
  const malformed = passLines.length === 0 && failLines.length === 0;
  // PASS only on a clean exit 0, no FAIL lines, and at least one real PASS line (baseline-red discipline).
  const pass = !malformed && r.status === 0 && failLines.length === 0;
  return { pass, exitCode: r.status, output, passLines, failLines, malformed };
}

// A generated gate is only trustworthy if it (a) is syntactically valid and (b) goes cleanly RED (real FAIL
// lines, not a crash) against an empty project. This is the baseline-red discipline that catches a broken
// gate before it grades anything — the reason fusion-harness ships a gate-repair step. Returns the reason
// it's invalid, or null if the gate is sound.
export function gateInvalidReason(gateScript: string, timeoutMs = 30_000): string | null {
  const dir = mkdtempSync(join(tmpdir(), "auralis-gate-chk-"));
  const p = join(dir, "gate.js");
  writeFileSync(p, gateScript);
  const syntax = spawnSync("node", ["--check", p], { encoding: "utf8", timeout: timeoutMs });
  if (syntax.status !== 0) return `syntax error: ${(syntax.stderr ?? "").split("\n").find(Boolean) ?? "invalid JS"}`;
  const empty = mkdtempSync(join(tmpdir(), "auralis-gate-empty-"));
  const base = runGate(gateScript, empty, timeoutMs);
  if (base.malformed) return `crashes at runtime (no PASS/FAIL printed): ${base.output.split("\n").find(Boolean) ?? "?"}`;
  if (base.pass) return "passes on an EMPTY project — the gate is too weak (baseline must fail red)";
  return null;
}

// Self-check: a trivial gate PASSes on a matching workspace and FAILs (red) on an empty one. Run: `tsx src/gate.ts`
const isMain = process.argv[1] ? resolve(process.argv[1]) === new URL(import.meta.url).pathname : false;
if (isMain) {
  const gate = `const {existsSync}=require('fs');
if(existsSync('marker.txt')){console.log('PASS: marker.txt exists');process.exit(0);}
console.log('FAIL: expected marker.txt, found nothing, at marker.txt — create it');process.exit(1);`;
  const empty = mkdtempSync(join(tmpdir(), "gate-selfcheck-"));
  const red = runGate(gate, empty);
  const full = mkdtempSync(join(tmpdir(), "gate-selfcheck-"));
  writeFileSync(join(full, "marker.txt"), "x");
  const green = runGate(gate, full);
  const ok = red.pass === false && red.failLines.length === 1 && green.pass === true && green.passLines.length === 1;
  console.log(`baseline empty → ${red.pass ? "PASS" : "red"} (${red.failLines[0] ?? ""})`);
  console.log(`with marker    → ${green.pass ? "PASS" : "red"} (${green.passLines[0] ?? ""})`);
  console.log(ok ? "✓ gate self-check OK" : "✗ gate self-check FAILED");
  process.exit(ok ? 0 : 1);
}
