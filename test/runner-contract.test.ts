// The runner contract (docs/prd-multi-runner.md M0) — the single source of truth for "what a runner is".
// Any AgentRunner that wants to drive fleet workers must pass this suite. First subject: ToolLoopRunner
// against the scripted fake-openai server (no network, no keys). ClaudeCodeRunner honours the same
// contract by construction (this suite's assertions were extracted from it).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOpenAI, type FakeOpenAI } from "./fake-openai";
import { ToolLoopRunner, type BrainTools } from "../src/runner-toolloop";

let ws: string; // scratch workspace the runner explores/builds in

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "runner-contract-"));
  writeFileSync(join(ws, "auth.ts"), "export function login(user: string) { return checkSession(user); }\n");
  writeFileSync(join(ws, "session.ts"), "export function checkSession(u: string) { return u !== ''; }\n");
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "sub", "util.ts"), "export const noop = () => {};\n");
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const mk = (fake: FakeOpenAI, extra: Partial<ConstructorParameters<typeof ToolLoopRunner>[0]> = {}) =>
  new ToolLoopRunner({ cwd: ws, baseURL: fake.url, model: "fake-model", maxTurns: 5, ...extra });

describe("runner contract — ToolLoopRunner on fake-openai", () => {
  it("1 · tracks explored for Read/Grep/Glob with targetOf semantics", async () => {
    const fake = await startFakeOpenAI([
      { toolCalls: [{ name: "Read", args: { file_path: "auth.ts" } }, { name: "Grep", args: { pattern: "checkSession" } }, { name: "Glob", args: { pattern: "*.ts" } }] },
      { content: "auth calls checkSession from session.ts" },
    ]);
    const res = await mk(fake).run("how does auth work?");
    expect(res.result).toContain("checkSession");
    expect(res.explored).toEqual([
      { tool: "Read", target: "auth.ts" },
      { tool: "Grep", target: "checkSession" },
      { tool: "Glob", target: "*.ts" },
    ]);
    // and the tool outputs really reached the model (second request carries them)
    const second = fake.requests[1];
    const toolMsgs = second.messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs[0].content).toContain("checkSession(user)"); // real file content
    expect(toolMsgs[1].content).toContain("session.ts"); // grep found the definition
    await fake.close();
  });

  it("2 · claim-denied Read: not explored, model told to reuse the teammate's finding", async () => {
    const fake = await startFakeOpenAI([
      { toolCalls: [{ name: "Read", args: { file_path: "auth.ts" } }] },
      { content: "reused w1's finding instead" },
    ]);
    const res = await mk(fake, { claim: async () => ({ ok: false, owner: "w1" }) }).run("task");
    expect(res.explored).toEqual([]); // a denied read never happened
    const toolMsg = fake.requests[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("w1"); // the redirect names the owner
    expect(toolMsg.content).toContain("mcp__oracle__search"); // and teaches the fallback
    await fake.close();
  });

  it("3a · build mode: writes outside the workspace are denied (confinement)", async () => {
    const fake = await startFakeOpenAI([
      { toolCalls: [{ name: "Write", args: { file_path: "../escape.txt", content: "x" } }] },
      { content: "done" },
    ]);
    const res = await mk(fake, { build: true }).run("build");
    expect(res.explored).toEqual([]); // denied write never happened
    expect(existsSync(join(ws, "..", "escape.txt"))).toBe(false);
    expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("outside the build workspace");
    await fake.close();
  });

  it("3b · build mode writes inside the workspace; analyse mode never offers Write", async () => {
    const fake = await startFakeOpenAI([
      { toolCalls: [{ name: "Write", args: { file_path: "out.js", content: "module.exports = 1;" } }] },
      { content: "wrote it" },
    ]);
    const res = await mk(fake, { build: true }).run("build out.js");
    expect(readFileSync(join(ws, "out.js"), "utf8")).toContain("module.exports");
    expect(res.explored).toEqual([{ tool: "Write", target: "out.js" }]); // build tracks writes
    // analyse mode: the tool schema itself must not offer Write/Edit
    const fake2 = await startFakeOpenAI([{ content: "ok" }]);
    await mk(fake2).run("analyse");
    const offered = fake2.requests[0].tools.map((t: any) => t.function.name);
    expect(offered).toContain("Read");
    expect(offered).not.toContain("Write");
    await fake.close();
    await fake2.close();
  });

  it("4 · brain tools exposed under the exact mcp__oracle__ names and routed to the brain", async () => {
    const seen: string[] = [];
    const brain: BrainTools = {
      search: async (q) => { seen.push(`search:${q}`); return "- [id1] w1: auth uses sessions"; },
      learn: async (p) => { seen.push(`learn:${p}`); return "learned id2"; },
    };
    const fake = await startFakeOpenAI([
      { toolCalls: [{ name: "mcp__oracle__search", args: { query: "auth" } }] },
      { toolCalls: [{ name: "mcp__oracle__learn", args: { pattern: "auth.ts exports login()" } }] },
      { content: "published" },
    ]);
    const res = await mk(fake, { brain }).run("task");
    const offered = fake.requests[0].tools.map((t: any) => t.function.name);
    for (const n of ["mcp__oracle__search", "mcp__oracle__learn", "mcp__oracle__decide", "mcp__oracle__note", "mcp__oracle__cite"]) expect(offered).toContain(n);
    expect(seen).toEqual(["search:auth", "learn:auth.ts exports login()"]);
    expect(res.explored).toEqual([]); // brain calls are NOT exploration
    await fake.close();
  });

  it("5 · onStep fires for every tool call, brain calls included", async () => {
    const steps: string[] = [];
    const fake = await startFakeOpenAI([
      { toolCalls: [{ name: "Read", args: { file_path: "auth.ts" } }, { name: "mcp__oracle__search", args: { query: "x" } }] },
      { content: "done" },
    ]);
    await mk(fake, { brain: { search: async () => "", learn: async () => "" }, onStep: (t, target) => steps.push(`${t}${target ? ":" + target : ""}`) }).run("t");
    expect(steps).toEqual(["Read:auth.ts", "mcp__oracle__search"]);
    await fake.close();
  });

  it("6 · respects the turn budget and keeps explored on early stop", async () => {
    const fake = await startFakeOpenAI([
      { toolCalls: [{ name: "Read", args: { file_path: "auth.ts" } }] },
      { toolCalls: [{ name: "Read", args: { file_path: "session.ts" } }] },
      { toolCalls: [{ name: "Read", args: { file_path: "sub/util.ts" } }] }, // never reached: budget = 2
    ]);
    const res = await mk(fake, { maxTurns: 2 }).run("t");
    expect(res.result).toContain("worker stopped early");
    expect(res.explored.map((e) => e.target)).toEqual(["auth.ts", "session.ts"]);
    await fake.close();
  });

  it("7 · provider failure degrades loudly with Critic-rejectable text (after one retry)", async () => {
    const fake = await startFakeOpenAI([
      { status: 500, error: "upstream exploded" },
      { status: 500, error: "upstream exploded again" },
    ]);
    const res = await mk(fake).run("t");
    expect(res.result).toContain("provider error");
    expect(res.result).toContain("500");
    expect(fake.requests).toHaveLength(2); // exactly one retry
    await fake.close();
  });
});
