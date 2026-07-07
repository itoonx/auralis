// The heuristic entity/triplet extractor — PURE, dependency-free (like claim.ts), so oracle-lite can run
// it at the ingress itself: every /api/learn builds the graph incrementally for free (8.5ms measured),
// keeping the write path LLM-free. graph.ts re-exports these and layers the optional LLM extractor on top
// (that one needs an AgentRunner, which must never be imported by the server or its Docker image).

export interface Triplet {
  subject: string;
  predicate: string;
  object: string;
}

export function normalizeEntity(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// Deterministic entity extraction: pull candidates (file paths, `code` idents, CamelCase terms), dedup by
// normalized key, return most-mentioned first. Shared by triplet extraction (write) and graph retrieval
// (read). ponytail: shallow lexical extraction; embeddings/NER are the upgrade path.
export function extractEntities(text: string): string[] {
  const cands = new Map<string, number>(); // first-seen casing -> mention count
  const bump = (raw: string) => {
    const k = raw.trim();
    if (k.length < 2 || k.length > 80) return;
    for (const [seen, n] of cands) {
      if (normalizeEntity(seen) === normalizeEntity(k)) { cands.set(seen, n + 1); return; }
    }
    cands.set(k, 1);
  };
  for (const m of text.matchAll(/`([^`]+)`/g)) bump(m[1]);                    // `identifiers`
  for (const m of text.matchAll(/\b[\w-]+(?:\/[\w.-]+)+\b/g)) bump(m[0]);     // path/like/file.ts
  for (const m of text.matchAll(/\b[\w-]+\.[a-z]{1,4}\b/g)) bump(m[0]);       // file.ts, foo.py
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g)) bump(m[1]); // CamelCase
  return [...cands.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
}

// Link the most-mentioned "hub" entity to the rest by co-occurrence. ponytail: shallow — real predicates
// come from the LLM path; this just guarantees the graph is never empty and stays offline-safe.
export function extractTriplets(text: string): Triplet[] {
  const ents = extractEntities(text);
  if (ents.length < 2) return [];
  const hub = ents[0];
  return ents.slice(1).map((e) => ({ subject: hub, predicate: "relates-to", object: e }));
}
