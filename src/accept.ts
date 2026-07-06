// The independent acceptance harness. Runs the BUILT program in a sandboxed subprocess (timeout +
// cwd-confined) and checks its contract from fixed inputs — auralis's OBJECTIVE truth, separate from the
// worker-written tests. `runAcceptance()` is importable (run.ts closes the build->accept->rework loop with
// it); run directly, `pnpm accept` prints the report and exits 0 (PASS) / 1 (FAIL). AURALIS_ACCEPT = spec.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

// The restapi "core" is a self-managing driver: it spawns the built server.js (argv[1]) on a private port,
// waits for it to listen, POSTs a todo, GETs the list, asserts the item round-trips, then kills the server.
// It manages the whole server lifecycle itself and exits, so the sync harness just waits for it — no need to
// make runAcceptance async. Self-deadlines under the spawnSync timeout so a broken server can't leak a port.
const REST_DRIVER = `
const http=require('http'),{spawn}=require('child_process');
const PORT=47901,base='http://127.0.0.1:'+PORT,deadline=Date.now()+4000;
const srv=spawn(process.execPath,[process.argv[1]],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT)},stdio:'ignore'});
let done=false;
const end=(code,msg)=>{if(done)return;done=true;try{srv.kill('SIGKILL')}catch(e){}if(msg)console.error(msg);process.exit(code);};
const req=(method,path,body)=>new Promise((res,rej)=>{const d=body?JSON.stringify(body):null;
  const r=http.request(base+path,{method,headers:d?{'content-type':'application/json','content-length':Buffer.byteLength(d)}:{}},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>res({status:x.statusCode,body:b}));});
  r.on('error',rej);if(d)r.write(d);r.end();});
const waitUp=()=>new Promise((res,rej)=>{(function poll(){if(Date.now()>deadline)return rej(new Error('server did not listen within 4s'));
  http.request(base+'/todos',{method:'GET'},()=>res()).on('error',()=>setTimeout(poll,100)).end();})();});
(async()=>{try{
  await waitUp();
  const p=await req('POST','/todos',{text:'buy milk'});
  if(p.status!==201)return end(1,'POST /todos expected 201, got '+p.status);
  const g=await req('GET','/todos');
  if(g.status!==200)return end(1,'GET /todos expected 200, got '+g.status);
  let arr;try{arr=JSON.parse(g.body)}catch(e){return end(1,'GET /todos body is not JSON')}
  if(!Array.isArray(arr)||!arr.some(t=>t&&t.text==='buy milk'))return end(1,'posted item not returned by GET');
  console.log('CORE_OK');end(0);
}catch(e){end(1,String(e&&e.message||e));}})();
`;

const SPECS: Record<string, Spec> = {
  rps: {
    main: "game.js",
    files: ["game.js", "cli.js"],
    core: RPS_CORE,
    testFile: "game.test.js",
    cli: (ws) => {
      // A CLI may read a move from stdin (readline) OR from argv — accept either; the game logic is the
      // contract, the I/O style is not. Try each; pass if any prints an outcome without crashing.
      const attempts: { args: string[]; input?: string }[] = [
        { args: ["cli.js"], input: "rock\n" },
        { args: ["cli.js", "rock"] },
        { args: ["cli.js", "rock", "scissors"] },
      ];
      for (const a of attempts) {
        const r = runNode(ws, a.args, a.input);
        const out = (r.stdout ?? "") + (r.stderr ?? "");
        const crashed = r.status !== 0 && r.status !== null; // null = timeout-kill (a stdin loop) is fine
        if (!crashed && /\b(win|lose|tie)\b/i.test(out)) return { ok: true };
      }
      return { ok: false, detail: "cli printed no win/lose/tie via stdin or argv" };
    },
  },
  restapi: {
    main: "server.js",
    files: ["server.js", "router.js", "store.js"],
    core: REST_DRIVER, // spawns server.js, POST+GET round-trip over http — the live contract
    cli: (ws) => {
      // Persistence check (independent of the live server): the POST from the core driver must have been
      // written through to todos.json, so a restart would see it. store.js owns this.
      const f = resolve(ws, "todos.json");
      if (!existsSync(f)) return { ok: false, detail: "todos.json not written — POST did not persist" };
      let txt = "";
      try { txt = readFileSync(f, "utf8"); } catch { /* unreadable → fails below */ }
      return /buy milk/.test(txt) ? { ok: true } : { ok: false, detail: "todos.json is missing the posted item" };
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
