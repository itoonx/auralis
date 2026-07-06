// pnpm accept — the independent acceptance harness. Runs the BUILT rock-paper-scissors game in a
// sandboxed subprocess (timeout + cwd-confined) and checks the RPS contract from fixed inputs. This is
// auralis's OBJECTIVE truth, separate from the worker's own tests — a worker can't pass by writing
// assert(true). Exit 0 = the game runs and plays correctly; exit 1 = it does not.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const WORKSPACE = resolve(process.env.AURALIS_PROJECT_DIR ?? ".auralis-build/rps");
const gamePath = resolve(WORKSPACE, "game.js");
const cliPath = resolve(WORKSPACE, "cli.js");
const testPath = resolve(WORKSPACE, "game.test.js");
const TIMEOUT = 5000;

// Runs inside `node -e` with game.js as argv[1]. Asserts the contract the build task specified:
// play(a,b) -> 'win'|'lose'|'tie' from the FIRST player's perspective, invalid input throws.
const CORE = `
const assert = require('assert');
const g = require(process.argv[1]);
const eq = (a, b, m) => assert.strictEqual(a, b, m);
eq(g.play('rock','scissors'),'win','rock beats scissors');
eq(g.play('scissors','paper'),'win','scissors beats paper');
eq(g.play('paper','rock'),'win','paper beats rock');
eq(g.play('rock','paper'),'lose','rock loses to paper');
eq(g.play('scissors','rock'),'lose','scissors loses to rock');
eq(g.play('paper','scissors'),'lose','paper loses to scissors');
eq(g.play('rock','rock'),'tie','tie on equal moves');
assert.strictEqual(typeof g.beats, 'function', 'beats is exported');
let threw = false; try { g.play('banana','rock'); } catch (e) { threw = true; }
assert.ok(threw, 'invalid input must throw');
console.log('CORE_OK');
`;

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const firstLines = (s: string, n = 2) => s.split("\n").filter(Boolean).slice(0, n).join(" · ");

checks.push({ name: "game.js exists", ok: existsSync(gamePath) });
checks.push({ name: "cli.js exists", ok: existsSync(cliPath) });

if (existsSync(gamePath)) {
  const r = spawnSync("node", ["-e", CORE, gamePath], { cwd: WORKSPACE, timeout: TIMEOUT, encoding: "utf8" });
  const ok = r.status === 0 && (r.stdout ?? "").includes("CORE_OK");
  checks.push({ name: "RPS core contract", ok, detail: ok ? undefined : firstLines(r.stderr || r.error?.message || "failed") });
} else {
  checks.push({ name: "RPS core contract", ok: false, detail: "no game.js" });
}

if (existsSync(cliPath)) {
  // Feed one move; the CLI must print an outcome. A timeout-kill (status null) is fine — it may loop by
  // design; a nonzero exit is a real crash.
  const r = spawnSync("node", [cliPath], { cwd: WORKSPACE, input: "rock\n", timeout: TIMEOUT, encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const crashed = r.status !== 0 && r.status !== null;
  const emitted = /\b(win|lose|tie)\b/i.test(out);
  checks.push({ name: "cli runs end-to-end", ok: emitted && !crashed, detail: emitted && !crashed ? undefined : crashed ? firstLines(out) || "cli crashed" : "no win/lose/tie printed" });
} else {
  checks.push({ name: "cli runs end-to-end", ok: false, detail: "no cli.js" });
}

if (existsSync(testPath)) {
  const r = spawnSync("node", [testPath], { cwd: WORKSPACE, timeout: TIMEOUT, encoding: "utf8" });
  checks.push({ name: "worker tests pass (secondary)", ok: r.status === 0, detail: r.status === 0 ? undefined : "nonzero exit" });
}

// PASS = the objective core contract AND the game is playable end-to-end. Worker tests are a signal, not the truth.
const core = checks.find((c) => c.name === "RPS core contract")!.ok;
const cli = checks.find((c) => c.name === "cli runs end-to-end")!.ok;
const pass = core && cli;

console.log(`\n━━━ acceptance · ${WORKSPACE} ━━━`);
for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`\n${pass ? "✅ PASS — the built RPS game runs and plays correctly" : "❌ FAIL — the built game does not meet the contract"}`);
process.exit(pass ? 0 : 1);
