import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the project's own tests — never the CommonJS test files the fleet writes into .auralis-build/.
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/setup/oracle-global.ts"],
    testTimeout: 60_000,
  },
});
