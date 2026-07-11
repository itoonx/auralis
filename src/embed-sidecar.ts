// Node embedding sidecar. oracle-lite runs on Bun, which can't load the transformers native stack, so
// real SEMANTIC embeddings live here (transformers runs fine under Node). Lazy-loads a small
// sentence-transformer and serves POST /embed {texts} -> {embeddings, dim}. Started on demand for
// AURALIS_SEMANTIC runs; if it isn't up, oracle-lite falls back to its built-in embedder.
import { createServer, type ServerResponse } from "node:http";
import { pipeline, env } from "@huggingface/transformers";

env.cacheDir = process.env.EMBED_CACHE ?? ".auralis-out/models";
const MODEL = process.env.EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const PORT = Number(process.env.EMBED_PORT ?? 47779);
// Pooling differs by model family: MiniLM/e5 want mean, BGE wants the CLS token. Default mean (unchanged).
const POOLING = (process.env.EMBED_POOLING ?? "mean") as "mean" | "cls";

let extractor: any = null;
let dim = 384;
async function getExtractor() {
  if (!extractor) extractor = await pipeline("feature-extraction", MODEL);
  return extractor;
}
async function embed(texts: string[]): Promise<number[][]> {
  const ex = await getExtractor();
  const out: number[][] = [];
  for (const t of texts) {
    const r: any = await ex(String(t).slice(0, 2000), { pooling: POOLING, normalize: true });
    const arr = Array.from(r.data as Float32Array) as number[];
    dim = arr.length;
    out.push(arr);
  }
  return out;
}
function json(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    embed(["probe"]).then(() => json(res, 200, { ok: true, dim, model: MODEL })).catch((e) => json(res, 500, { ok: false, error: String(e).slice(0, 120) }));
    return;
  }
  if (req.method === "POST" && req.url === "/embed") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let texts: string[] = [];
      try { texts = JSON.parse(body || "{}").texts ?? []; } catch { return json(res, 400, { error: "bad json" }); }
      embed(Array.isArray(texts) ? texts : []).then((embeddings) => json(res, 200, { embeddings, dim })).catch((e) => json(res, 500, { error: String(e).slice(0, 120) }));
    });
    return;
  }
  json(res, 404, { error: "not found" });
});
server.listen(PORT, () => console.log(`embed-sidecar (${MODEL}) on http://localhost:${PORT}`));
