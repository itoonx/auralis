// The session-capture INGRESS classifier: every Claude Code hook event lands in the right lane —
// knowledge (learn, trust-tiered), observability (event only), or dropped. Pure function, no I/O.
import { describe, it, expect } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs module, no types; route() is the exported pure classifier
import { route, isDuplicateInstall } from "../hooks/session-capture.mjs";

const base = { cwd: "/Users/x/git/myrepo", session_id: "s1" };

describe("session-capture ingress", () => {
  it("a substantive prompt → timeline event + learn (human trust, NOT pinned) + recall", () => {
    const prompt = "Please refactor the auth middleware so the session token is validated before rate limiting is applied.";
    const a = route({ ...base, hook_event_name: "UserPromptSubmit", prompt });
    expect(a.map((x: any) => x.type)).toEqual(["event", "recall", "learn"]); // recall BEFORE learn — no self-echo
    const learn = a[2];
    expect(learn.source).toBe("human:prompt"); // → trust 1.0 at the server
    expect(learn.pinned).toBe(false); // ground truth but unused instructions must fade
    expect(learn.project).toBe("myrepo"); // project = repo basename, same brain the fleet uses
  });

  it("a long prompt chunks into several learns — nothing thrown away, continuations carry a [re:] anchor", () => {
    const prompt = "We should redesign the retrieval pipeline for the memory layer. ".repeat(40).trim(); // ~2,500 chars
    const a = route({ ...base, hook_event_name: "UserPromptSubmit", prompt });
    const learns = a.filter((x: any) => x.type === "learn");
    expect(learns.length).toBeGreaterThan(1); // old clip(1200) kept ~half; chunking keeps it all
    for (const l of learns) expect(l.source).toBe("human:prompt");
    expect(learns[0].pattern).toMatch(/^User instruction \(session\): We should redesign/);
    for (const l of learns.slice(1)) expect(l.pattern).toContain("[re: We should redesign"); // findable mid-chunks
    const kept = learns.reduce((n: number, l: any) => n + l.pattern.length, 0);
    expect(kept).toBeGreaterThan(prompt.length); // prefixes+anchors added, no content lost
  });

  it("a trivial prompt stays out of the brain (event + recall only)", () => {
    const a = route({ ...base, hook_event_name: "UserPromptSubmit", prompt: "ทำต่อ" });
    expect(a.map((x: any) => x.type)).toEqual(["event", "recall"]);
  });

  it("slash and shell prompts are not knowledge at all", () => {
    expect(route({ ...base, hook_event_name: "UserPromptSubmit", prompt: "/compact" })).toEqual([]);
    expect(route({ ...base, hook_event_name: "UserPromptSubmit", prompt: "! pwd" })).toEqual([]);
  });

  it("harness payloads (<task-notification>…) are not human words", () => {
    expect(route({ ...base, hook_event_name: "UserPromptSubmit", prompt: "<task-notification>done</task-notification>" })).toEqual([]);
  });

  it("fleet workers stand down entirely (their prompts must never become trust-1.0 human memories)", () => {
    process.env.AURALIS_FLEET = "1";
    try {
      const prompt = 'You are worker "probe", analysing a codebase as part of a team working AT THE SAME TIME on this repository.';
      expect(route({ ...base, hook_event_name: "UserPromptSubmit", prompt })).toEqual([]);
      expect(route({ ...base, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "x.ts" } })).toEqual([]);
    } finally {
      delete process.env.AURALIS_FLEET;
    }
  });

  it("Write/Edit → observability trace only, never learn (traces must not pollute recall)", () => {
    const a = route({ ...base, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "src/x.ts" } });
    expect(a).toHaveLength(1);
    expect(a[0].type).toBe("event");
    expect(a[0].kind).toBe("trace");
    expect(a[0].refs).toEqual(["src/x.ts"]);
  });

  it("other tools (Read/Bash/…) are dropped entirely — git already records commits", () => {
    expect(route({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" } })).toEqual([]);
    expect(route({ ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" } })).toEqual([]);
  });

  it("Stop → answer timeline event + learn for a substantive conclusion", () => {
    const p = join(tmpdir(), `sc-stop-${process.pid}.jsonl`);
    const text = "Conclusion: the ranking pipeline fuses FTS and vector lists with RRF and then applies bounded boosts before returning results.";
    writeFileSync(p, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n");
    try {
      const a = route({ ...base, hook_event_name: "Stop", transcript_path: p });
      expect(a.map((x: any) => x.type)).toEqual(["event", "learn"]);
      expect(a[0].kind).toBe("answer"); // the exchange reads prompt → traces → answer on the timeline
      expect(a[1].source).toBe("session:assistant");
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("Stop with no transcript captures nothing", () => {
    expect(route({ ...base, hook_event_name: "Stop" })).toEqual([]);
  });

  it("a global install stands down inside a repo that wires the hook itself (no double capture)", () => {
    const global = "/Users/x/git/project/auralis/hooks/session-capture.mjs";
    const wired = () => '{"hooks":{"Stop":[{"command":"node session-capture.mjs"}]}}';
    const bare = () => { throw new Error("ENOENT"); };
    expect(isDuplicateInstall(global, "/Users/x/git/other-repo", wired)).toBe(true); // repo wires it → defer
    expect(isDuplicateInstall(global, "/Users/x/git/other-repo", bare)).toBe(false); // no repo wiring → capture
    expect(isDuplicateInstall(global, "/Users/x/git/project/auralis", wired)).toBe(false); // repo-local install always runs
  });

  it("unknown events are ignored", () => {
    expect(route({ ...base, hook_event_name: "SomethingElse" })).toEqual([]);
    expect(route({})).toEqual([]);
  });
});
