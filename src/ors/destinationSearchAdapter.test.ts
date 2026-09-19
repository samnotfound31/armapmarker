import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "../domain/types";
import {
  createOrsDestinationSearchAdapter,
  requestOrsDestinationSuggestions
} from "./destinationSearchAdapter";

const destination: Destination = {
  placeId: "openstreetmap:venue:node:123",
  name: "City Museum",
  formattedAddress: "City Museum, Kolkata, West Bengal, India",
  location: { lat: 22.5826, lng: 88.3739 }
};

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("requestOrsDestinationSuggestions", () => {
  it("uses the same-origin search broker and validates its result", async () => {
    const signal = new AbortController().signal;
    const fetchSearch = vi.fn<typeof fetch>(async () =>
      Response.json({ suggestions: [destination] })
    );

    const suggestions = await requestOrsDestinationSuggestions(
      "City Museum",
      { lat: 22.5726, lng: 88.3639 },
      signal,
      fetchSearch
    );

    expect(suggestions).toEqual([destination]);
    expect(fetchSearch).toHaveBeenCalledWith("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "City Museum",
        origin: { lat: 22.5726, lng: 88.3639 }
      }),
      signal
    });
  });

  it("surfaces safe server errors and rejects malformed results", async () => {
    const errorFetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        { code: "SEARCH_RATE_LIMITED", message: "Try again shortly." },
        { status: 429 }
      )
    );
    const malformedFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ suggestions: [{ name: "Missing coordinates" }] })
    );

    await expect(
      requestOrsDestinationSuggestions(
        "Museum",
        undefined,
        new AbortController().signal,
        errorFetch
      )
    ).rejects.toThrow("Try again shortly.");
    await expect(
      requestOrsDestinationSuggestions(
        "Museum",
        undefined,
        new AbortController().signal,
        malformedFetch
      )
    ).rejects.toThrow("Destination search returned invalid results.");
  });
});

describe("createOrsDestinationSearchAdapter", () => {
  it("debounces autocomplete, uses the latest origin, and selects a result", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    let origin = { lat: 22.5726, lng: 88.3639 };
    const search = vi.fn(async () => [destination]);
    const onSelect = vi.fn();
    const dispose = await createOrsDestinationSearchAdapter(search).mount(host, {
      getOrigin: () => origin,
      onSelect,
      onError: vi.fn()
    });
    const input = screen.getByRole("searchbox", { name: /destination/i });

    fireEvent.input(input, { target: { value: "City" } });
    origin = { lat: 22.57, lng: 88.36 };
    fireEvent.input(input, { target: { value: "City Museum" } });
    await vi.advanceTimersByTimeAsync(300);

    expect(screen.getByRole("button", { name: /city museum/i })).toBeVisible();
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.slice(0, 2)).toEqual([
      "City Museum",
      { lat: 22.57, lng: 88.36 }
    ]);
    fireEvent.click(screen.getByRole("button", { name: /city museum/i }));
    expect(onSelect).toHaveBeenCalledWith(destination);

    dispose();
    expect(host).toBeEmptyDOMElement();
  });

  it("suppresses empty and one-character input, then debounces a valid two-character query", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const search = vi.fn(async () => [destination]);
    const onError = vi.fn();
    const dispose = await createOrsDestinationSearchAdapter(search).mount(host, {
      onSelect: vi.fn(), onError
    });
    const input = screen.getByRole("searchbox");
    for (const value of ["", "C", " C "]) {
      fireEvent.input(input, { target: { value } });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(search).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    fireEvent.input(input, { target: { value: "Ci" } });
    await vi.advanceTimersByTimeAsync(299);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /city museum/i })).toBeVisible();
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores an older response even when its request ignores abort", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    let resolveOld!: (suggestions: Destination[]) => void;
    const older = new Promise<Destination[]>((resolve) => { resolveOld = resolve; });
    const newer = { ...destination, name: "New Museum", formattedAddress: "New Museum, Kolkata" };
    const search = vi.fn().mockReturnValueOnce(older).mockResolvedValueOnce([newer]);
    const onError = vi.fn();
    const dispose = await createOrsDestinationSearchAdapter(search).mount(host, {
      onSelect: vi.fn(), onError
    });
    const input = screen.getByRole("searchbox");
    fireEvent.input(input, { target: { value: "City" } });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.input(input, { target: { value: "New Museum" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByRole("button", { name: /new museum/i })).toBeVisible();
    resolveOld([destination]);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByRole("button", { name: /city museum/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new museum/i })).toBeVisible();
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("shows an empty state without selecting fake data", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const onSelect = vi.fn();
    await createOrsDestinationSearchAdapter(async () => []).mount(host, {
      onSelect,
      onError: vi.fn()
    });

    fireEvent.input(screen.getByRole("searchbox"), {
      target: { value: "Unknown destination" }
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(screen.getByText("No destinations found.")).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
