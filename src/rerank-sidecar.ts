// Node reranker sidecar — a cross-encoder (bge-reranker-v2-m3) that scores (query, doc) RELEVANCE directly,
// far more precisely than a bi-encoder cosine. oracle-lite retrieves a wide candidate set (top-N) then POSTs
// it here to re-rank down to the final top-k (the "…→ Top100 → reranker → Top10" stage). Node, not Bun: the
// onnxruntime native stack won't load under Bun (same reason embed-sidecar is Node).
//   POST /rerank {query, docs:[{id,text}]} -> {scores:[{id,score}]}  (sorted, best first)
//   GET  /health -> {ok, model} and a sanity pair (relevant must outscore irrelevant)
//   run: RERANK_PORT=47782 pnpm exec tsx src/rerank-sidecar.ts
import { createServer, type ServerResponse } from "node:http";
import { env, AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";

env.cacheDir = process.env.EMBED_CACHE ?? ".auralis-out/models";
const MODEL = process.env.RERANK_MODEL ?? "Xenova/bge-reranker-v2-m3";
const PORT = Number(process.env.RERANK_PORT ?? 47782);

let tok: any = null, model: any = null;
async function load() {
  if (!model) { tok = await AutoTokenizer.from_pretrained(MODEL); model = await AutoModelForSequenceClassification.from_pretrained(MODEL); }
}
// One batched forward pass over all (query, doc) pairs. bge-reranker emits a single relevance logit per pair.
async function score(query: string, docs: { id: string; text: string }[]): Promise<{ id: string; score: number }[]> {
  await load();
  if (!docs.length) return [];
  const inputs = await tok(new Array(docs.length).fill(query), { text_pair: docs.map((d) => String(d.text).slice(0, 2000)), padding: true, truncation: true });
  const out: any = await model(inputs);
  const raw = Array.from(out.logits.data as Float32Array) as number[]; // length = docs.length (shape [N,1])
  return docs.map((d, i) => ({ id: d.id, score: raw[i] })).sort((a, b) => b.score - a.score);
}
function json(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    // self-check: a relevant pair must outscore an irrelevant one.
    score("which seafood makes me ill", [
      { id: "rel", text: "I'm allergic to shellfish like shrimp and crab." },
      { id: "irr", text: "I like to repair vintage clocks on Tuesday evenings." },
    ]).then((s) => json(res, 200, { ok: s[0]?.id === "rel", model: MODEL, probe: s })).catch((e) => json(res, 500, { ok: false, error: String(e).slice(0, 160) }));
    return;
  }
  if (req.method === "POST" && req.url === "/rerank") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let query = "", docs: { id: string; text: string }[] = [];
      try { const b = JSON.parse(body || "{}"); query = String(b.query ?? ""); docs = b.docs ?? []; } catch { return json(res, 400, { error: "bad json" }); }
      score(query, docs).then((scores) => json(res, 200, { scores })).catch((e) => json(res, 500, { error: String(e).slice(0, 160) }));
    });
    return;
  }
  json(res, 404, { error: "not found" });
});
server.listen(PORT, () => console.log(`rerank-sidecar (${MODEL}) on http://localhost:${PORT}`));
