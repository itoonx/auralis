# BGE-M3 full-pipeline sidecar (Python/FlagEmbedding) — the pieces Node/transformers.js cannot serve:
# sparse lexical weights, and the real bge-reranker-v2-m3 (no ONNX build exists). Speaks the SAME HTTP
# contract as the Node sidecars, so oracle-lite needs no changes to use it as its embedder:
#   GET  /health -> {ok, dim, model}                                (embed-sidecar compatible)
#   POST /embed  {texts} -> {embeddings, dim, sparse}               (dense compatible + sparse extra:
#                                                                    one {token: weight} map per text)
#   POST /rerank {query, docs:[{id,text}]} -> {scores:[{id,score}]} (rerank-sidecar compatible, v2-m3)
# stdlib http.server only — FlagEmbedding/torch are the sole real deps (pip install FlagEmbedding).
#   run: .auralis-out/venv-bge/bin/python src/bge-sidecar.py   (BGE_PORT, default 47783)
import json
import os
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

os.environ.setdefault("HF_HOME", os.environ.get("BGE_CACHE", ".auralis-out/models-py"))
PORT = int(os.environ.get("BGE_PORT", "47783"))
# 127.0.0.1 on a host install; the Docker service sets BGE_HOST=0.0.0.0 (unpublished — compose-network only).
HOST = os.environ.get("BGE_HOST", "127.0.0.1")
EMBED_MODEL = os.environ.get("BGE_EMBED_MODEL", "BAAI/bge-m3")
RERANK_MODEL = os.environ.get("BGE_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")

_m3 = None
_rr = None
# Threaded server so overlapping requests (live hook ingest + a query embed + a rerank) aren't refused —
# a refused embed silently degrades the caller to its trigram fallback (seen live: 11/404 on backfill).
# One lock serializes MODEL calls (torch inference isn't thread-safe); accepting sockets stays parallel.
_gpu = threading.Lock()


def m3():
    global _m3
    if _m3 is None:
        from FlagEmbedding import BGEM3FlagModel
        _m3 = BGEM3FlagModel(EMBED_MODEL, use_fp16=True)
    return _m3


def rr():
    # Direct transformers, not FlagEmbedding.FlagReranker: its batching calls tokenizer.prepare_for_model,
    # removed in current transformers ("XLMRobertaTokenizer has no attribute prepare_for_model"). A plain
    # tokenizer(pairs) + forward pass is all a cross-encoder needs, and it tracks transformers, not a pin.
    global _rr
    if _rr is None:
        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        tok = AutoTokenizer.from_pretrained(RERANK_MODEL)
        model = AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, torch_dtype=torch.float16).to(device).eval()

        def score(pairs):
            import torch as t
            out = []
            with t.no_grad():
                for i in range(0, len(pairs), 16):  # small batches keep peak memory flat
                    batch = pairs[i : i + 16]
                    enc = tok([p[0] for p in batch], [p[1] for p in batch], padding=True, truncation=True, max_length=1024, return_tensors="pt").to(device)
                    out.extend(model(**enc).logits.view(-1).float().cpu().tolist())
            return out

        _rr = score
    return _rr


class H(BaseHTTPRequestHandler):
    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("content-length", 0)) or 0) or b"{}")

    def do_GET(self):
        if self.path == "/health":
            try:
                with _gpu:
                    out = m3().encode(["probe"], return_dense=True, return_sparse=True)
                dim = len(out["dense_vecs"][0])
                self._json(200, {"ok": True, "dim": dim, "model": EMBED_MODEL, "sparse": True})
            except Exception as e:  # noqa: BLE001 — health must report, not crash
                self._json(500, {"ok": False, "error": str(e)[:200]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            if self.path == "/embed":
                texts = [str(t)[:2000] for t in (self._body().get("texts") or [])]
                with _gpu:
                    out = m3().encode(texts, return_dense=True, return_sparse=True)
                dense = [[float(x) for x in v] for v in out["dense_vecs"]]
                # lexical_weights: one {token_id: weight} per text (defaultdict w/ numpy floats → plain json)
                sparse = [{str(k): float(v) for k, v in w.items()} for w in out["lexical_weights"]]
                self._json(200, {"embeddings": dense, "dim": len(dense[0]) if dense else 0, "sparse": sparse})
            elif self.path == "/rerank":
                b = self._body()
                query, docs = str(b.get("query", "")), b.get("docs") or []
                with _gpu:
                    scores = rr()([[query, str(d.get("text", ""))[:4000]] for d in docs])
                ranked = sorted(
                    ({"id": d.get("id"), "score": float(s)} for d, s in zip(docs, scores)),
                    key=lambda x: -x["score"],
                )
                self._json(200, {"scores": ranked})
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 — a bad request must not kill the daemon
            self._json(500, {"error": str(e)[:200]})

    def log_message(self, *a):  # quiet — health polls would spam stderr
        pass


if __name__ == "__main__":
    print(f"bge-sidecar ({EMBED_MODEL} + {RERANK_MODEL}) on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
