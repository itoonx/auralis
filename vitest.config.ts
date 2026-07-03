import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/setup/oracle-global.ts"],
    testTimeout: 60_000,
  },
});
