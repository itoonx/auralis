// Gate-first verifier plumbing (src/gate.ts) — deterministic, no LLM. Proves the two disciplines that make
// a GENERATED gate safe to trust: (1) a gate that crashes is flagged MALFORMED, never read as pass/fail;
// (2) gateInvalidReason rejects syntax-broken, crashing, and too-weak gates, accepting only one that goes
// cleanly RED on an empty project (baseline-red).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, gateInvalidReason } from "../src/gate";

// A sound gate: RED on an empty project, GREEN once marker.txt exists.
const SOUND = `const {existsSync}=require('fs');
if(existsSync('marker.txt')){console.log('PASS: marker.txt exists');process.exit(0);}
console.log('FAIL: expected marker.txt, found nothing, at marker.txt — create it');process.exit(1);`;

describe("runGate", () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "gate-test-")); });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("goes cleanly RED on a missing requirement (fail line, not a crash)", () => {
    const r = runGate(SOUND, ws);
    expect(r.pass).toBe(false);
    expect(r.malformed).toBe(false);
    expect(r.failLines).toHaveLength(1);
    expect(r.failLines[0]).toMatch(/^FAIL: expected marker\.txt/);
  });

  it("PASSes once the requirement is met", () => {
    writeFileSync(join(ws, "marker.txt"), "x");
    const r = runGate(SOUND, ws);
    expect(r.pass).toBe(true);
    expect(r.passLines).toHaveLength(1);
    expect(r.failLines).toHaveLength(0);
  });

  it("flags a crashing gate as MALFORMED (never a verdict)", () => {
    // node --check passes (valid syntax) but it throws at runtime — no PASS/FAIL ever prints.
    const crash = `console.log(neverDeclared);`;
    const r = runGate(crash, ws);
    expect(r.malformed).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it("does NOT pass a gate that exits 0 while printing FAIL", () => {
    const sloppy = `console.log('FAIL: something wrong, at x — fix it');process.exit(0);`;
    const r = runGate(sloppy, ws);
    expect(r.pass).toBe(false);
    expect(r.failLines).toHaveLength(1);
  });
});

describe("gateInvalidReason (baseline-red discipline)", () => {
  it("accepts a sound gate (goes red on an empty project)", () => {
    expect(gateInvalidReason(SOUND)).toBeNull();
  });

  it("rejects a syntactically broken gate", () => {
    expect(gateInvalidReason(`const x = ;`)).toMatch(/syntax/i);
  });

  it("rejects a gate that crashes at runtime", () => {
    expect(gateInvalidReason(`console.log(neverDeclared);`)).toMatch(/crash/i);
  });

  it("rejects a too-weak gate that passes on an empty project", () => {
    expect(gateInvalidReason(`console.log('PASS: nothing checked');process.exit(0);`)).toMatch(/empty/i);
  });
});
