import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this checkout's suite; agent worktrees under .claude/ carry their own copies.
    include: ["test/**/*.test.ts"],
  },
});
