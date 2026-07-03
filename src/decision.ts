// Decisions as first-class brain knowledge — an "honest ADR". Instead of a markdown file that rots in
// git, a decision is recorded INTO the shared brain, so the next agent that touches this area SEARCHES
// and finds it. Crucially it is honest about its own blind spots: it keeps the rejected alternatives
// (the road not taken is the most valuable and most-often-lost part), and it explicitly flags that
// external constraints — deadlines, licensing, team skills, lock-in — are things only a human can see,
// rather than inventing clean technical-sounding reasons for everything.
import type { MemoryAdapter } from "./memory";

export interface Decision {
  title: string;
  chose: string;
  because: string; // technical rationale the agent could actually see
  rejected?: { option: string; why: string }[]; // alternatives weighed and dropped
  external?: string[]; // external constraints the agent DOES know of (a human may know more)
  revisitIf?: string;
}

export const SENTINEL = "Architecture Decision Record";

export function formatDecision(d: Decision): string {
  const rejected = d.rejected?.length
    ? d.rejected.map((r) => `  - ${r.option} — rejected because ${r.why}`).join("\n")
    : "  (none recorded — a capable agent may have gone straight to the answer; the road not taken is missing)";
  const external = d.external?.length
    ? d.external.map((e) => `  - ${e}`).join("\n")
    : "  ⚠ none captured by the agent — a HUMAN must confirm the external constraints an agent can't see\n" +
      "    (deadlines, licensing, team skills, existing lock-in). Absence here does NOT mean there were none.";
  return [
    `${SENTINEL}: ${d.title}`,
    ``,
    `Chose: ${d.chose}`,
    `Because (technical rationale the agent could see): ${d.because}`,
    ``,
    `Alternatives considered & rejected:`,
    rejected,
    ``,
    `External constraints (only a human sees these fully):`,
    external,
    d.revisitIf ? `\nRevisit if: ${d.revisitIf}` : "",
  ].join("\n");
}

export async function recordDecision(adapter: MemoryAdapter, project: string, d: Decision): Promise<{ id: string }> {
  return adapter.learn(formatDecision(d), { project, concepts: ["decision", "adr"], source: "auralis:decision" });
}

export async function listDecisions(adapter: MemoryAdapter, project: string): Promise<{ id: string; text: string }[]> {
  const hits = await adapter.search(SENTINEL, { project, limit: 50 });
  return hits.filter((h) => h.content.includes(SENTINEL)).map((h) => ({ id: h.id, text: h.content }));
}

// Reverse/replace a prior decision. The old one is SUPERSEDED, never deleted — so a future agent that
// searches this area finds both the original call and the fact (and reason) it was reversed. A static
// .md file can't do this, which is exactly why hand-kept ADRs rot.
export async function reverseDecision(
  adapter: MemoryAdapter,
  project: string,
  oldId: string,
  replacement: Decision,
): Promise<{ id: string }> {
  const { id } = await recordDecision(adapter, project, replacement);
  await adapter.supersede?.(oldId, id, `reversed by a newer decision: ${replacement.title}`);
  return { id };
}
