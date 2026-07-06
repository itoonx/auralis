// The independent acceptance harness. Runs the BUILT program in a sandboxed subprocess (timeout +
// cwd-confined) and checks its contract from fixed inputs — auralis's OBJECTIVE truth, separate from the
// worker-written tests. `runAcceptance()` is importable (run.ts closes the build->accept->rework loop with
// it); run directly, `pnpm accept` prints the report and exits 0 (PASS) / 1 (FAIL). AURALIS_ACCEPT = spec.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT = 5000;
const runNode = (ws: string, args: string[], input?: string) => spawnSync("node", args, { cwd: ws, input, timeout: TIMEOUT, encoding: "utf8" });
const firstLines = (s: string, n = 2) => s.split("\n").filter(Boolean).slice(0, n).join(" · ");

interface Spec {
  main: string;
  files: string[]; // must exist
  core: string; // `node -e` body: require(argv[1]) = the main file, assert, print CORE_OK
  testFile?: string;
  cli: (ws: string) => { ok: boolean; detail?: string };
}

const RPS_CORE = `
const assert=require('assert');const g=require(process.argv[1]);const eq=(a,b,m)=>assert.strictEqual(a,b,m);
eq(g.play('rock','scissors'),'win','rock beats scissors');eq(g.play('scissors','paper'),'win','scissors beats paper');
eq(g.play('paper','rock'),'win','paper beats rock');eq(g.play('rock','paper'),'lose','rock loses to paper');
eq(g.play('rock','rock'),'tie','tie');assert.strictEqual(typeof g.beats,'function','beats exported');
let t=false;try{g.play('banana','rock')}catch(e){t=true}assert.ok(t,'invalid throws');console.log('CORE_OK');
`;

const TODO_CORE = `
const assert=require('assert');const t=require(process.argv[1]);
let l=t.addTodo([], 'buy milk');assert.strictEqual(l.length,1,'add one');
assert.strictEqual(l[0].text,'buy milk','text');assert.strictEqual(!!l[0].done,false,'not done');
l=t.addTodo(l,'walk dog');assert.strictEqual(l.length,2,'add two');
l=t.toggle(l,0);assert.strictEqual(l[0].done,true,'toggled');
l=t.remove(l,0);assert.strictEqual(l.length,1,'removed');assert.strictEqual(l[0].text,'walk dog','right one left');
console.log('CORE_OK');
`;

const SPECS: Record<string, Spec> = {
  rps: {
    main: "game.js",
    files: ["game.js", "cli.js"],
    core: RPS_CORE,
    testFile: "game.test.js",
    cli: (ws) => {
      const r = runNode(ws, ["cli.js"], "rock\n");
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      const crashed = r.status !== 0 && r.status !== null; // null = timeout-kill (loop by design) is OK
      const emitted = /\b(win|lose|tie)\b/i.test(out);
      return { ok: emitted && !crashed, detail: emitted && !crashed ? undefined : crashed ? firstLines(out) || "crashed" : "no win/lose/tie printed" };
    },
  },
  todo: {
    main: "todo.js",
    files: ["todo.js", "cli.js"],
    core: TODO_CORE,
    testFile: "todo.test.js",
    cli: (ws) => {
      // contract: `cli.js add <text>` then `cli.js list` shows the item (persisted to todos.json).
      runNode(ws, ["cli.js", "add", "buy milk"]);
      const r = runNode(ws, ["cli.js", "list"]);
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      const crashed = r.status !== 0 && r.status !== null;
      const listed = /milk/i.test(out);
      return { ok: listed && !crashed, detail: listed && !crashed ? undefined : crashed ? firstLines(out) || "crashed" : "added item not shown by list" };
    },
  },
};

export interface AcceptResult {
  pass: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  failLines: string; // one line per failing check, for rework feedback
}

// Run the acceptance spec against a workspace. Pure (no exit/print) so run.ts can loop on it.
export function runAcceptance(workspace: string, specName = "rps"): AcceptResult {
  const ws = resolve(workspace);
  const spec = SPECS[specName] ?? SPECS.rps;
  const mainPath = resolve(ws, spec.main);
  const checks: AcceptResult["checks"] = [];

  for (const f of spec.files) checks.push({ name: `${f} exists`, ok: existsSync(resolve(ws, f)) });

  if (existsSync(mainPath)) {
    const r = runNode(ws, ["-e", spec.core, mainPath]);
    const ok = r.status === 0 && (r.stdout ?? "").includes("CORE_OK");
    checks.push({ name: "core contract", ok, detail: ok ? undefined : firstLines(r.stderr || r.error?.message || "failed") });
  } else {
    checks.push({ name: "core contract", ok: false, detail: `no ${spec.main}` });
  }

  checks.push({ name: "cli runs end-to-end", ...spec.cli(ws) });

  if (spec.testFile && existsSync(resolve(ws, spec.testFile))) {
    const r = runNode(ws, [spec.testFile]);
    checks.push({ name: "worker tests pass (secondary)", ok: r.status === 0, detail: r.status === 0 ? undefined : "nonzero exit" });
  }

  // PASS = the objective core contract AND the program is usable end-to-end. Worker tests are a signal, not the truth.
  const pass = !!checks.find((c) => c.name === "core contract")?.ok && !!checks.find((c) => c.name === "cli runs end-to-end")?.ok;
  const failLines = checks.filter((c) => !c.ok).map((c) => `- ${c.name}${c.detail ? `: ${c.detail}` : ""}`).join("\n");
  return { pass, checks, failLines };
}

// CLI: `pnpm accept`. Only runs when invoked directly, not when run.ts imports runAcceptance.
const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const workspace = process.env.AURALIS_PROJECT_DIR ?? ".auralis-build/rps";
  const specName = process.env.AURALIS_ACCEPT ?? "rps";
  const r = runAcceptance(workspace, specName);
  console.log(`\n━━━ acceptance · ${specName} · ${resolve(workspace)} ━━━`);
  for (const c of r.checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  console.log(`\n${r.pass ? "✅ PASS — the built program runs and behaves correctly" : "❌ FAIL — the built program does not meet the contract"}`);
  process.exit(r.pass ? 0 : 1);
}
