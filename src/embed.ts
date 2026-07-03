// Node-side embedding helper for the distiller: real semantic vectors via the embed-sidecar
// (ORACLE_EMBED_URL, read at call time) when available, else the same built-in char-trigram fallback
// oracle-lite uses. Vectors are L2-normalized, so cosine == dot product.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function builtinEmbed(text: string, dim = 256): number[] {
  const v = new Float32Array(dim);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1);
  for (const w of words) {
    v[hashStr(w) % dim] += 1;
    const p = `#${w}#`;
    for (let i = 0; i + 3 <= p.length; i++) v[hashStr(p.slice(i, i + 3)) % dim] += 1;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}
export async function embedText(text: string): Promise<number[]> {
  const url = process.env.ORACLE_EMBED_URL;
  if (url) {
    try {
      const res = await fetch(`${url}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: [text.slice(0, 2000)] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const b = (await res.json()) as { embeddings?: number[][] };
        if (b.embeddings?.[0]) return b.embeddings[0];
      }
    } catch {
      /* fall back */
    }
  }
  return builtinEmbed(text);
}
export function cosine(a: number[], b: number[]): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}
