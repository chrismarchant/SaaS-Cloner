import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["**/*.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
