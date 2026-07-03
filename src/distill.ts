// Distillation — keep the growing brain SIGNAL-rich, not just bigger. Cluster similar raw findings by
// semantic similarity, synthesize one vetted finding per cluster, and SUPERSEDE the raws (never delete,
// reusing the values layer). Search demotes superseded docs, so the vetted one surfaces. Without this,
// a persistent brain rots by accumulation as runs pile up near-duplicate and contradictory notes.
import type { MemoryAdapter } from "./memory";
import { embedText, cosine } from "./embed";

// Greedy single-pass clustering by cosine to a running (renormalized) centroid.
export function clusterFindings(items: { id: string; vector: number[] }[], threshold: number): string[][] {
  const clusters: { ids: string[]; centroid: number[]; n: number }[] = [];
  for (const it of items) {
    let best = -1;
    let bestSim = threshold;
    for (let c = 0; c < clusters.length; c++) {
      const sim = cosine(it.vector, clusters[c].centroid);
      if (sim >= bestSim) { bestSim = sim; best = c; }
    }
    if (best >= 0) {
      const cl = clusters[best];
      const n = cl.n + 1;
      const cen = cl.centroid.map((x, i) => (x * cl.n + it.vector[i]) / n);
      let nn = 0;
      for (const x of cen) nn += x * x;
      nn = Math.sqrt(nn) || 1;
      cl.centroid = cen.map((x) => x / nn);
      cl.n = n;
      cl.ids.push(it.id);
    } else {
      clusters.push({ ids: [it.id], centroid: it.vector.slice(), n: 1 });
    }
  }
  return clusters.map((c) => c.ids);
}

export interface DistillResult {
  rawDocs: number;
  clusters: number;
  distilled: number;
  superseded: number;
}

export async function distill(
  adapter: MemoryAdapter,
  project: string,
  opts: {
    threshold?: number;
    minCluster?: number;
    synthesize: (contents: string[]) => Promise<string>;
    embed?: (t: string) => Promise<number[]>;
  },
): Promise<DistillResult> {
  const embed = opts.embed ?? embedText;
  const threshold = opts.threshold ?? 0.6;
  const minCluster = opts.minCluster ?? 2;

  const docs = (await adapter.listDocs?.({ tier: "raw", project, max: 500 })) ?? [];
  if (docs.length < minCluster) return { rawDocs: docs.length, clusters: 0, distilled: 0, superseded: 0 };

  const byId = new Map(docs.map((d) => [d.id, d]));
  const vectors = await Promise.all(docs.map((d) => embed(d.content)));
  const items = docs.map((d, i) => ({ id: d.id, vector: vectors[i] }));
  const groups = clusterFindings(items, threshold).filter((g) => g.length >= minCluster);

  let distilled = 0;
  let superseded = 0;
  for (const ids of groups) {
    const contents = ids.map((id) => byId.get(id)!.content);
    const consolidated = await opts.synthesize(contents);
    const { id: newId } = await adapter.learn(consolidated, { project, concepts: ["distilled", "vetted"], source: "auralis:distilled", tier: "distilled" });
    for (const id of ids) {
      await adapter.supersede?.(id, newId, "distilled into a consolidated finding");
      superseded++;
    }
    distilled++;
  }
  return { rawDocs: docs.length, clusters: groups.length, distilled, superseded };
}
