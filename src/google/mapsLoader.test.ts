import { describe, expect, it, vi } from "vitest";
import { createGoogleLibrariesLoader } from "./mapsLoader";

describe("createGoogleLibrariesLoader", () => {
  it("configures the key once and loads only Places and Maps", async () => {
    const places = { name: "places" };
    const maps = { name: "maps" };
    const setOptions = vi.fn();
    const importLibrary = vi.fn(async (name: "places" | "maps") =>
      name === "places" ? places : maps
    );
    const load = createGoogleLibrariesLoader({ setOptions, importLibrary });

    await expect(load("browser-key")).resolves.toEqual({ places, maps });
    await load("browser-key");

    expect(setOptions).toHaveBeenCalledOnce();
    expect(setOptions).toHaveBeenCalledWith({ key: "browser-key", v: "weekly" });
    expect(importLibrary.mock.calls.map(([name]) => name)).toEqual([
      "places",
      "maps"
    ]);
  });

  it("rejects a missing key before loading Google", async () => {
    const importLibrary = vi.fn();
    const load = createGoogleLibrariesLoader({
      setOptions: vi.fn(),
      importLibrary
    });

    await expect(load(" ")).rejects.toThrow(/browser key/i);
    expect(importLibrary).not.toHaveBeenCalled();
  });
});
