import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" -> "src/*".
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each test file runs in its own isolated worker so per-file ANSWERABLE_DB_PATH temp
    // databases never collide across suites (src/db is a module-level singleton).
    isolate: true,
  },
});
