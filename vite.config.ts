import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

type VercelConfig = {
  headers: Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;
};

const vercel = JSON.parse(
  readFileSync(resolve("vercel.json"), "utf8")
) as VercelConfig;
const deploymentHeaders = Object.fromEntries(
  vercel.headers
    .find(({ source }) => source === "/(.*)")!
    .headers.map(({ key, value }) => [key, value])
);

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === "e2e"
      ? [basicSsl({ name: "ar-navigation-e2e", domains: ["127.0.0.1", "localhost"] })]
      : [])
  ],
  preview: { headers: deploymentHeaders },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        app: resolve("index.html"),
        e2e: resolve("e2e.html"),
        runtimeSmoke: resolve("runtime-smoke.html")
      }
    }
  },
  worker: {
    format: "es"
  },
  test: {
    environment: "jsdom",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    setupFiles: "./vitest.setup.ts",
    restoreMocks: true
  }
}));
