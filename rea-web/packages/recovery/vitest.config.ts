import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "recovery",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
