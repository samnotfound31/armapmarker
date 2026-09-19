import { defineConfig } from "@playwright/test";
import local from "../playwright.config";

if (!process.env.AR_PREVIEW_URL) throw new Error("Set AR_PREVIEW_URL to the exact Ready Preview URL.");

export default defineConfig({
  ...local,
  testDir: ".",
  testMatch: ["release-flow.spec.ts", "opencv-runtime.spec.ts", "search.spec.ts"],
  webServer: undefined,
  use: {
    ...local.use,
    baseURL: process.env.AR_PREVIEW_URL,
    ignoreHTTPSErrors: false,
    trace: "off"
  }
});
