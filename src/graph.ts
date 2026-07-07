// The "buildGraph" step: turn a flat finding into entity/relationship triplets so the shared brain becomes
// a traversable graph, not just a bag of text. Heuristic extraction is deterministic + free; an optional
// LLM path (via Claude Code) gives real predicates. Entity resolution is by normalized name.
import type { MemoryAdapter, Triplet } from "./memory";
import type { AgentRunner } from "./runner";
// The pure heuristic extractor lives in triplets.ts (dependency-free, like claim.ts) so oracle-lite can
// run it AT THE INGRESS — every /api/learn builds the graph incrementally without this module's AgentRunner
// dependency chain. Re-exported here so existing importers keep one entry point.
import { normalizeEntity, extractEntities, extractTriplets } from "./triplets";
export { normalizeEntity, extractEntities, extractTriplets };

// Optional LLM extraction — real predicates via Claude Code. Falls back to the heuristic on any failure.
export async function llmExtractTriplets(text: string, runner: AgentRunner): Promise<Triplet[]> {
  const prompt =
    "Extract the key entities and their relationships from the finding below as JSON: an array of " +
    '{"subject","predicate","object"} triplets, predicates as short verb phrases. Output ONLY the JSON array.\n\n' +
    text.slice(0, 2000);
  try {
    const { result } = await runner.run(prompt);
    const m = result.match(/\[[\s\S]*\]/);
    if (!m) return extractTriplets(text);
    const arr = JSON.parse(m[0]) as any[];
    const triplets = arr
      .filter((t) => t && t.subject && t.object)
      .map((t) => ({ subject: String(t.subject), predicate: String(t.predicate ?? "relates-to"), object: String(t.object) }));
    return triplets.length ? triplets : extractTriplets(text);
  } catch {
    return extractTriplets(text);
  }
}

// BuildGraph one finding: extract triplets and store them as edges linked to the finding's doc id.
export async function buildGraph(
  adapter: MemoryAdapter,
  docId: string,
  project: string,
  text: string,
  opts: { extract?: (t: string) => Triplet[] | Promise<Triplet[]> } = {},
): Promise<Triplet[]> {
  const extract = opts.extract ?? extractTriplets;
  const triplets = await extract(text);
  if (triplets.length) await adapter.relate?.(docId, project, triplets);
  return triplets;
}

// Fuzzy entity resolution: a name's lookup variants, so `auth/session.ts`, `session.ts`, and `session`
// resolve to the same neighborhood instead of fragmenting the graph. ponytail: deterministic path/ext
// stripping; embedding-based resolution is the upgrade path.
export function entityVariants(name: string): string[] {
  const base = normalizeEntity(name);
  const out = new Set<string>([base]);
  const slash = base.lastIndexOf("/");
  const basename = slash >= 0 ? base.slice(slash + 1) : base;
  if (basename.length >= 3) out.add(basename); // path -> basename
  const dot = basename.lastIndexOf(".");
  if (dot > 0 && basename.slice(0, dot).length >= 3) out.add(basename.slice(0, dot)); // strip extension
  return [...out];
}

// graph-linked recall — graph-expand a query: find seed entities in the text, pull each one's neighborhood
// from the brain, and format the connected findings. Surfaces what CONNECTS to what the query is about —
// which flat keyword/vector search alone can't. No-op when the adapter has no graph, or the brain none.
export interface GraphContext {
  text: string;
  entities: string[];
  docIds: string[];
}
export async function graphContext(
  adapter: MemoryAdapter,
  project: string,
  seedText: string,
  opts: { maxSeeds?: number; maxEdges?: number } = {},
): Promise<GraphContext> {
  if (!adapter.graph) return { text: "", entities: [], docIds: [] };
  const seeds = extractEntities(seedText).slice(0, opts.maxSeeds ?? 4);
  const lines: string[] = [];
  const lineDoc = new Map<string, string>(); // triplet line -> source finding id (first seen), so it's citable
  const entities = new Set<string>();
  const docIds = new Set<string>();
  const queried = new Set<string>();
  for (const seed of seeds) {
    const seedKey = normalizeEntity(seed);
    for (const variant of entityVariants(seed)) {
      if (queried.has(variant)) continue;
      queried.add(variant);
      const g = await adapter.graph(variant, project);
      for (const e of g.edges.slice(0, opts.maxEdges ?? 8)) {
        const line = `${e.subject} \u2014${e.predicate}\u2192 ${e.object}`;
        lines.push(line);
        if (e.docId) {
          docIds.add(e.docId);
          if (!lineDoc.has(line)) lineDoc.set(line, e.docId);
        }
      }
      for (const ent of g.entities) if (normalizeEntity(ent) !== seedKey) entities.add(ent);
    }
  }
  const uniq = [...new Set(lines)];
  return {
    // Each edge line carries the id of the finding it came from \u2014 graph-sourced knowledge is citable too.
    text: uniq.length ? `Connected in the knowledge graph:\n${uniq.map((l) => `- ${lineDoc.has(l) ? `[${lineDoc.get(l)}] ` : ""}${l}`).join("\n")}` : "",
    entities: [...entities],
    docIds: [...docIds],
  };
}
