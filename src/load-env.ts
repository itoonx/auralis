// Load the repo .env into process.env for HOST-side production entry points that talk to the LIVE oracle
// (MCP server, `pnpm recall`, `pnpm sleep`), so ORACLE_TOKEN / ORACLE_JWT_SECRET / ORACLE_API_URL all come
// from one file — the same one compose feeds the daemon. Import this FIRST, before ./memory, because
// memory.ts computes its AUTH header once at import time; the token must be in env before that runs.
//
// Deliberately NOT imported by ./memory (the shared adapter) or by bench entries: their scratch oracles must
// stay auth-free, and some bench code fetches without a token — leaking the prod token into those processes
// would make the scratch oracle demand auth and 401 them. Skipped under vitest for the same reason.
import { fileURLToPath } from "node:url";

if (!process.env.VITEST) {
  try { process.loadEnvFile(fileURLToPath(new URL("../.env.oracle", import.meta.url))); } catch { /* no .env.oracle — fine */ }
}
