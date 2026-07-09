// The lifecycle runner seam: makeRunner picks the backend by env, and ApiRunner fails loud (never a silent
// no-op) when it can't authenticate — the background lifecycle must not appear to run while doing nothing.
import { describe, it, expect } from "vitest";
import { makeRunner, ApiRunner, ClaudeCodeRunner } from "../src/runner";

describe("lifecycle runner selection", () => {
  it("makeRunner picks ApiRunner only when AURALIS_RUNNER=api, else ClaudeCodeRunner", () => {
    const prev = process.env.AURALIS_RUNNER;
    try {
      process.env.AURALIS_RUNNER = "api";
      expect(makeRunner({ cwd: "." })).toBeInstanceOf(ApiRunner);
      process.env.AURALIS_RUNNER = "claude";
      expect(makeRunner({ cwd: "." })).toBeInstanceOf(ClaudeCodeRunner);
      delete process.env.AURALIS_RUNNER;
      expect(makeRunner({ cwd: "." })).toBeInstanceOf(ClaudeCodeRunner); // default = interactive
    } finally {
      if (prev === undefined) delete process.env.AURALIS_RUNNER;
      else process.env.AURALIS_RUNNER = prev;
    }
  });

  it("ApiRunner refuses a remote URL with no key (loud throw, not a silent no-op)", async () => {
    const k = process.env.AURALIS_RUNNER_API_KEY, o = process.env.OPENAI_API_KEY;
    delete process.env.AURALIS_RUNNER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(new ApiRunner({ url: "https://api.openai.com/v1/chat/completions" }).run("hi")).rejects.toThrow(/key/i);
    } finally {
      if (k !== undefined) process.env.AURALIS_RUNNER_API_KEY = k;
      if (o !== undefined) process.env.OPENAI_API_KEY = o;
    }
  });
});
