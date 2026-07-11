// HS256 JWT for the oracle API — verify an `Authorization: Bearer <jwt>` header with zero dependencies.
// Symmetric (shared-secret) by design: same single-operator trust model as ORACLE_TOKEN — one secret in
// .env both signs and verifies. HS256-only allowlist (rejects alg:none / RS / ES, so no alg-confusion),
// constant-time signature compare, and `exp`/`nbf` enforced.
//   mint:   ORACLE_JWT_SECRET=… bun oracle-lite/jwt.ts sign --sub me --days 30
//   verify: ORACLE_JWT_SECRET=… bun oracle-lite/jwt.ts verify <token>
//   test:   bun oracle-lite/jwt.ts            (runs the self-check asserts)
import { createHmac, timingSafeEqual } from "node:crypto";

const b64uJson = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function signJwt(payload: Record<string, unknown>, secret: string, expiresInSec = 30 * 86_400): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const body = b64uJson({ iat: now, exp: now + expiresInSec, ...payload });
  const data = `${head}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

// Returns the claims on success; throws on any failure (caller maps the throw to 401).
export function verifyJwt(token: string, secret: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const [head, body, sig] = parts;
  const header = JSON.parse(Buffer.from(head, "base64url").toString());
  if (header.alg !== "HS256") throw new Error(`alg ${header.alg} rejected`); // block none / RS256 / ES256
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && now >= claims.exp) throw new Error("expired");
  if (typeof claims.nbf === "number" && now < claims.nbf) throw new Error("not yet valid");
  return claims;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const argOf = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  const secret = process.env.ORACLE_JWT_SECRET;

  if (cmd === "sign") {
    if (!secret) { console.error("set ORACLE_JWT_SECRET"); process.exit(1); }
    console.log(signJwt({ sub: argOf("--sub") ?? "client" }, secret, Number(argOf("--days") ?? 30) * 86_400));
  } else if (cmd === "verify") {
    if (!secret) { console.error("set ORACLE_JWT_SECRET"); process.exit(1); }
    try { console.log(JSON.stringify(verifyJwt(rest[0] ?? "", secret))); }
    catch (e) { console.error("INVALID:", (e as Error).message); process.exit(1); }
  } else {
    // ponytail: one runnable check — the smallest thing that fails if the security logic breaks.
    const assert = (c: unknown, m: string) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };
    const rejects = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
    const s = "test-secret-123";
    const t = signJwt({ sub: "me" }, s, 60);
    assert((verifyJwt(t, s) as any).sub === "me", "roundtrip");
    const tampered = (() => { const p = t.split("."); p[2] = Buffer.alloc(32).toString("base64url"); return p.join("."); })();
    assert(rejects(() => verifyJwt(tampered, s)), "tampered signature must fail");
    assert(rejects(() => verifyJwt(t, "wrong-secret")), "wrong secret must fail");
    assert(rejects(() => verifyJwt(signJwt({ sub: "x" }, s, -1), s)), "expired must fail");
    const none = `${b64uJson({ alg: "none", typ: "JWT" })}.${b64uJson({ sub: "x" })}.`;
    assert(rejects(() => verifyJwt(none, s)), "alg:none must fail");
    console.log("jwt self-check: all assertions passed");
  }
}
