import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "../domain/types";
import type { DestinationSearchAdapter } from "../components/SearchScreen";
import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("starts with the walking safety and destination search screen", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /walk with ar/i })).toBeVisible();
    expect(screen.getByText(/never use while driving/i)).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getAllByRole("searchbox", { name: /destination/i })
      ).toHaveLength(1)
    );
  });

  it("uses the ORS search broker as the default destination provider", async () => {
    const fetchSearch = vi.fn<typeof fetch>(async () =>
      Response.json({ suggestions: [] })
    );
    vi.stubGlobal("fetch", fetchSearch);
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getAllByRole("searchbox", { name: /destination/i })
      ).toHaveLength(1)
    );
    fireEvent.input(screen.getByRole("searchbox", { name: /destination/i }), {
      target: { value: "City Museum" }
    });

    await waitFor(() => expect(fetchSearch).toHaveBeenCalledOnce());
    expect(fetchSearch.mock.calls[0]?.[0]).toBe("/api/search");
  });

  it("moves from an accurate origin and destination to route preview", async () => {
    const destination: Destination = {
      placeId: "museum-id",
      name: "City Museum",
      formattedAddress: "1 Museum Road",
      location: { lat: 22.58, lng: 88.37 }
    };
    const destinationAdapter: DestinationSearchAdapter = {
      mount(host, { onSelect }) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Choose City Museum";
        button.onclick = () => onSelect(destination);
        host.replaceChildren(button);
        return () => button.remove();
      }
    };

    render(
      <App
        destinationAdapter={destinationAdapter}
        requestLocation={vi.fn(async () => ({
          point: { lat: 22.57, lng: 88.36 },
          accuracyMeters: 8,
          timestampMs: 1000
        }))}
        requestRoute={vi.fn(async () => ({
          origin: { lat: 22.57, lng: 88.36 },
          destination: { ...destination.location, name: destination.name },
          encodedPolyline: "route",
          distanceMeters: 1200,
          durationSeconds: 932,
          steps: []
        }))}
        mapAdapter={{ mount: () => () => undefined }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /use my location/i }));
    await screen.findByText(/location ready/i);
    fireEvent.click(
      await screen.findByRole("button", { name: /choose city museum/i })
    );

    expect(
      await screen.findByRole("heading", { name: "City Museum" })
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /start ar walk/i }));
    expect(
      screen.getByRole("heading", { name: /enable ar access/i })
    ).toBeVisible();
  });
});
