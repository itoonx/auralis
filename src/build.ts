// The build loop, shared by the CLI (run.ts) and the MCP build tool: run the fleet, verify against a spec,
// and on failure rework with the failure as feedback (bounded). Extracted so both paths self-heal identically
// instead of the loop living only in run.ts.
import { runFleet, type FleetCfg } from "./fleet";
import { runAcceptance, type AcceptResult } from "./accept";
import type { MemoryAdapter } from "./memory";
import type { DagNode } from "./dag";
import { log } from "./log";

export interface BuildOutcome {
  shared: Awaited<ReturnType<typeof runFleet>>;
  acc?: AcceptResult; // undefined when no spec was given (e.g. analyse, or build without accept)
  attempts: number; // reworks performed (0 = passed first try or no spec)
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
  let acc: AcceptResult | undefined = opts.accept ? runAcceptance(opts.projectDir, opts.accept) : undefined;
  let attempts = 0;
  for (; acc && !acc.pass && attempts < opts.retries; attempts++) {
    const line = `↻ acceptance FAILED — rework ${attempts + 1}/${opts.retries}:\n${acc.failLines}`;
    console.log(line);
    cfg.onProgress?.(line);
    const fb = `\n\nA PRIOR ATTEMPT FAILED the acceptance check:\n${acc.failLines}\nRead the existing files in this directory and CHANGE only what is needed to make it pass; do not rewrite files that already work.`;
    const reworkNodes = nodes.map((n) => ({ ...n, question: n.question + fb }));
    shared = await log.time("arm.shared", `rework${attempts + 1}`, () => runFleet("shared", adapter, reworkNodes, cfg));
    acc = runAcceptance(opts.projectDir, opts.accept!);
  }
  return { shared, acc, attempts };
}
