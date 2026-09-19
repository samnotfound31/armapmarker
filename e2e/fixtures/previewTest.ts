import { execFileSync } from "node:child_process";
import { test as base } from "@playwright/test";

let previewAccess: string | undefined;

export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    if (process.env.AR_PREVIEW_URL) {
      const url = new URL(baseURL!);
      if (url.protocol !== "https:" ||
          !url.hostname.startsWith("armapmarker-") ||
          !url.hostname.endsWith("-samnotfound31s-projects.vercel.app")) {
        throw new Error("Preview verification requires this project's HTTPS deployment URL.");
      }
      if (!previewAccess) {
        const project = JSON.parse(execFileSync("npx", [
          "vercel", "api", "/v9/projects/armapmarker", "--method", "GET", "--raw"
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as {
          protectionBypass?: Record<string, { scope: string }>;
        };
        previewAccess = Object.keys(project.protectionBypass ?? {}).find(
          (key) => project.protectionBypass![key]?.scope === "automation-bypass"
        );
        if (!previewAccess) throw new Error("Existing authenticated Preview access is unavailable.");
      }
      // Reuse existing access, only on this deployment. Never print it, add it
      // to browser URLs, save a trace, or change project protection settings.
      await context.route(`${url.origin}/**`, (route) => route.continue({
        headers: { ...route.request().headers(), "x-vercel-protection-bypass": previewAccess! }
      }));
    }
    await use(context);
  }
});
