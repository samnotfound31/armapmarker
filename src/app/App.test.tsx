import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Destination } from "../domain/types";
import type { DestinationSearchAdapter } from "../components/SearchScreen";
import { App } from "./App";

describe("App", () => {
  it("starts with the walking safety and destination search screen", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /walk with ar/i })).toBeVisible();
    expect(screen.getByText(/never use while driving/i)).toBeVisible();
    expect(screen.getByLabelText(/destination/i)).toBeEnabled();
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
