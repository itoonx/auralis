// Boots the oracle-lite sidecar for the live read-after-write test, then tears it down.
import { spawn, type ChildProcess } from "node:child_process";

let child: ChildProcess | undefined;

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:47778/health", { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function setup() {
  if (await reachable()) return;
  child = spawn("bun", ["run", "oracle-lite/server.ts"], {
    env: { ...process.env, ORACLE_RESET: "1", ORACLE_DB: ".auralis-out/test-brain.sqlite" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if (await reachable()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("oracle-lite did not start for tests");
}

export async function teardown() {
  child?.kill();
}
