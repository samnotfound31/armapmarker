import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "coverage", "node_modules", ".worktrees", "test-results", "playwright-report"]
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  }
);
