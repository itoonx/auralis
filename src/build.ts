// The build loop, shared by the CLI (run.ts) and the MCP build tool: run the fleet, verify against a spec,
// and on failure rework with the failure as feedback (bounded). Extracted so both paths self-heal identically
// instead of the loop living only in run.ts.
import { runFleet, type FleetCfg } from "./fleet";
import { runAcceptance, type AcceptResult } from "./accept";
import type { MemoryAdapter } from "./memory";
import type { DagNode } from "./dag";
import { makeEmitter } from "./narrate";
import { log } from "./log";

export interface BuildOutcome {
  shared: Awaited<ReturnType<typeof runFleet>>;
  acc?: AcceptResult; // undefined when no spec was given (e.g. analyse, or build without accept)
  attempts: number; // reworks performed (0 = passed first try or no spec)
  firstFail: string; // what acceptance attempt #1 was missing ("" if it passed first try) — the retro lesson
}

// runFleet once; if an acceptance spec is given and fails, rework the fleet with the failure as feedback,
// up to `retries`, then fail-forward. onProgress (via cfg) narrates each rework live.
export async function buildWithRework(
  adapter: MemoryAdapter,
  nodes: DagNode[],
  cfg: FleetCfg,
  opts: { accept?: string; retries: number; projectDir: string },
): Promise<BuildOutcome> {
  let shared = await log.time("arm.shared", undefined, () => runFleet("shared", adapter, nodes, cfg));
  // Acceptance verdicts and reworks belong on the SAME run's timeline (fleet events live under shared.runId)
  // — a replay must show the whole build→verify→rework story, not stop at the last worker finding.
  const acceptEmit = (kind: string, body: string) =>
    adapter.recordEvent &&
    makeEmitter({ adapter, runId: shared.runId, project: cfg.project, onEvent: cfg.onProgress ? (_k, _a, human) => cfg.onProgress!(human) : undefined })(kind, "acceptance", body);
  let acc: AcceptResult | undefined = opts.accept ? runAcceptance(opts.projectDir, opts.accept) : undefined;
  if (acc) acceptEmit(acc.pass ? "finding" : "repair", acc.pass ? `acceptance PASS (${opts.accept})` : `acceptance FAILED (${opts.accept}): ${acc.failLines.replace(/\n/g, "; ").slice(0, 200)}`);
  const firstFail = acc && !acc.pass ? acc.failLines : ""; // capture attempt #1's miss before rework overwrites acc
  let attempts = 0;
  for (; acc && !acc.pass && attempts < opts.retries; attempts++) {
    const line = `↻ acceptance FAILED — rework ${attempts + 1}/${opts.retries}:\n${acc.failLines}`;
    console.log(line);
    cfg.onProgress?.(line);
    acceptEmit("repair", `rework ${attempts + 1}/${opts.retries} — refitting the fleet with the failure as feedback`);
    const fb = `\n\nA PRIOR ATTEMPT FAILED the acceptance check:\n${acc.failLines}\nRead the existing files in this directory and CHANGE only what is needed to make it pass; do not rewrite files that already work.`;
    const reworkNodes = nodes.map((n) => ({ ...n, question: n.question + fb }));
    shared = await log.time("arm.shared", `rework${attempts + 1}`, () => runFleet("shared", adapter, reworkNodes, cfg));
    acc = runAcceptance(opts.projectDir, opts.accept!);
    acceptEmit(acc.pass ? "finding" : "repair", acc.pass ? `acceptance PASS after rework ${attempts + 1} (${opts.accept})` : `acceptance still FAILING after rework ${attempts + 1}: ${acc.failLines.replace(/\n/g, "; ").slice(0, 200)}`);
  }
  return { shared, acc, attempts, firstFail };
}
