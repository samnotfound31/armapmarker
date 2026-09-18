// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHeiGitHeaders,
  HEIGIT_ENDPOINTS
} from "./heigitConfig";

describe("HeiGIT provider configuration", () => {
  it("builds current production endpoints and server authentication", () => {
    expect(HEIGIT_ENDPOINTS).toEqual({
      autocomplete: "https://api.heigit.org/pelias/v1/autocomplete",
      walkingDirections:
        "https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson"
    });
    expect(createHeiGitHeaders("server-key")).toEqual({
      Accept: "application/json",
      Authorization: "server-key"
    });
  });

  it("keeps the deprecated hostname out of source and active configuration", async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    const forbiddenHostname = ["api", "openrouteservice", "org"].join(".");
    const files = await collectFiles(repositoryRoot, [
      "api",
      "src",
      ".env.example",
      "README.md",
      "vercel.json"
    ]);
    const violations: string[] = [];

    for (const file of files) {
      if ((await readFile(file, "utf8")).includes(forbiddenHostname)) {
        violations.push(path.relative(repositoryRoot, file));
      }
    }

    expect(violations).toEqual([]);
  });
});

async function collectFiles(
  root: string,
  entries: readonly string[]
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry);
    const statEntries = await readdir(target, { withFileTypes: true }).catch(
      () => null
    );
    if (!statEntries) {
      files.push(target);
      continue;
    }
    for (const statEntry of statEntries) {
      const child = path.join(target, statEntry.name);
      if (statEntry.isDirectory()) {
        files.push(...(await collectFiles(child, ["."])));
      } else if (/\.(?:ts|tsx|js|json|md|example)$/i.test(statEntry.name)) {
        files.push(child);
      }
    }
  }
  return files;
}
