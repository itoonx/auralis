// pnpm accept — the independent acceptance harness. Runs the BUILT program in a sandboxed subprocess
// (timeout + cwd-confined) and checks its contract from fixed inputs. This is auralis's OBJECTIVE truth,
// separate from the worker-written tests — a worker can't pass by writing assert(true). Exit 0 = the
// program runs and behaves correctly; exit 1 = it does not. AURALIS_ACCEPT picks the spec (rps | todo).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const WORKSPACE = resolve(process.env.AURALIS_PROJECT_DIR ?? ".auralis-build/rps");
const TIMEOUT = 5000;
const node = (args: string[], input?: string) => spawnSync("node", args, { cwd: WORKSPACE, input, timeout: TIMEOUT, encoding: "utf8" });
const firstLines = (s: string, n = 2) => s.split("\n").filter(Boolean).slice(0, n).join(" · ");

interface Spec {
  main: string;
  files: string[]; // must exist
  core: string; // `node -e` body: require(argv[1]) = the main file, assert, print CORE_OK
  testFile?: string;
  cli: () => { ok: boolean; detail?: string };
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
    cli: () => {
      const r = node(["cli.js"], "rock\n");
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
    cli: () => {
      // contract: `cli.js add <text>` then `cli.js list` shows the item (persisted to todos.json).
      node(["cli.js", "add", "buy milk"]);
      const r = node(["cli.js", "list"]);
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      const crashed = r.status !== 0 && r.status !== null;
      const listed = /milk/i.test(out);
      return { ok: listed && !crashed, detail: listed && !crashed ? undefined : crashed ? firstLines(out) || "crashed" : "added item not shown by list" };
    },
  },
};

const spec = SPECS[process.env.AURALIS_ACCEPT ?? "rps"] ?? SPECS.rps;
const mainPath = resolve(WORKSPACE, spec.main);
const checks: { name: string; ok: boolean; detail?: string }[] = [];

for (const f of spec.files) checks.push({ name: `${f} exists`, ok: existsSync(resolve(WORKSPACE, f)) });

if (existsSync(mainPath)) {
  const r = node(["-e", spec.core, mainPath]);
  const ok = r.status === 0 && (r.stdout ?? "").includes("CORE_OK");
  checks.push({ name: "core contract", ok, detail: ok ? undefined : firstLines(r.stderr || r.error?.message || "failed") });
} else {
  checks.push({ name: "core contract", ok: false, detail: `no ${spec.main}` });
}

checks.push({ name: "cli runs end-to-end", ...spec.cli() });

if (spec.testFile && existsSync(resolve(WORKSPACE, spec.testFile))) {
  const r = node([spec.testFile]);
  checks.push({ name: "worker tests pass (secondary)", ok: r.status === 0, detail: r.status === 0 ? undefined : "nonzero exit" });
}

// PASS = the objective core contract AND the program is usable end-to-end. Worker tests are a signal, not the truth.
const pass = !!checks.find((c) => c.name === "core contract")?.ok && !!checks.find((c) => c.name === "cli runs end-to-end")?.ok;

console.log(`\n━━━ acceptance · ${process.env.AURALIS_ACCEPT ?? "rps"} · ${WORKSPACE} ━━━`);
for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`\n${pass ? "✅ PASS — the built program runs and behaves correctly" : "❌ FAIL — the built program does not meet the contract"}`);
process.exit(pass ? 0 : 1);
