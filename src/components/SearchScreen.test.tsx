import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Destination } from "../domain/types";
import {
  createGoogleDestinationSearchAdapter,
  SearchScreen,
  type DestinationSearchAdapter
} from "./SearchScreen";

const destination: Destination = {
  placeId: "museum-id",
  name: "City Museum",
  formattedAddress: "1 Museum Road",
  location: { lat: 22.58, lng: 88.37 }
};

describe("SearchScreen", () => {
  it("fetches only the selected place fields needed by routing", async () => {
    const host = document.createElement("div");
    const onSelect = vi.fn();
    const fetchFields = vi.fn(async () => undefined);
    class FakePlaceAutocompleteElement extends HTMLElement {
      public placeholder: string | null = null;
      public description: string | null = null;
    }
    if (!customElements.get("fake-place-autocomplete")) {
      customElements.define("fake-place-autocomplete", FakePlaceAutocompleteElement);
    }
    const adapter = createGoogleDestinationSearchAdapter(
      "browser-key",
      vi.fn(async () => ({
        places: {
          PlaceAutocompleteElement: FakePlaceAutocompleteElement
        },
        maps: {}
      })) as never
    );

    await adapter.mount(host, { onSelect, onError: vi.fn() });
    const autocomplete = host.firstElementChild;
    const event = new Event("gmp-select");
    Object.defineProperty(event, "placePrediction", {
      value: {
        placeId: destination.placeId,
        toPlace: () => ({
          fetchFields,
          displayName: destination.name,
          formattedAddress: destination.formattedAddress,
          location: {
            lat: () => destination.location.lat,
            lng: () => destination.location.lng
          }
        })
      }
    });
    autocomplete?.dispatchEvent(event);

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(destination));
    expect(fetchFields).toHaveBeenCalledWith({
      fields: ["displayName", "formattedAddress", "location"]
    });
  });

  it("reports a selected Google destination", async () => {
    const onDestination = vi.fn();
    render(
      <SearchScreen
        destinationAdapter={createDestinationAdapter(destination)}
        requestLocation={vi.fn()}
        onLocation={vi.fn()}
        onDestination={onDestination}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /city museum/i }));

    expect(onDestination).toHaveBeenCalledWith(destination);
  });

  it("shows the accuracy of a user-requested location", async () => {
    const onLocation = vi.fn();
    render(
      <SearchScreen
        destinationAdapter={createDestinationAdapter(destination)}
        requestLocation={vi.fn(async () => ({
          point: { lat: 22.57, lng: 88.36 },
          accuracyMeters: 9,
          timestampMs: 1000
        }))}
        onLocation={onLocation}
        onDestination={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /use my location/i }));

    expect(await screen.findByText(/location ready.*9 m/i)).toBeVisible();
    expect(onLocation).toHaveBeenCalledWith(
      expect.objectContaining({ accuracyMeters: 9 })
    );
  });

  it("keeps one autocomplete mount and selects with the latest callback after location becomes ready", async () => {
    let select: (() => void) | undefined;
    const dispose = vi.fn();
    const adapter: DestinationSearchAdapter = {
      mount: vi.fn((_host, callbacks) => {
        select = () => callbacks.onSelect(destination);
        return dispose;
      })
    };
    const firstSelection = vi.fn();
    const latestSelection = vi.fn();
    const requestLocation = vi.fn(async () => ({
      point: { lat: 22.57, lng: 88.36 },
      accuracyMeters: 5,
      timestampMs: 1000
    }));
    const { rerender } = render(
      <SearchScreen
        destinationAdapter={adapter}
        requestLocation={requestLocation}
        onLocation={vi.fn()}
        onDestination={firstSelection}
      />
    );

    rerender(
      <SearchScreen
        destinationAdapter={adapter}
        requestLocation={requestLocation}
        onLocation={vi.fn()}
        onDestination={latestSelection}
        origin={{ lat: 22.57, lng: 88.36 }}
      />
    );
    select?.();

    expect(adapter.mount).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(firstSelection).not.toHaveBeenCalled();
    expect(latestSelection).toHaveBeenCalledWith(destination);
  });

  it("keeps destination search available after location denial", async () => {
    render(
      <SearchScreen
        destinationAdapter={createDestinationAdapter(destination)}
        requestLocation={vi.fn(async () => {
          throw new Error("Location permission was denied.");
        })}
        onLocation={vi.fn()}
        onDestination={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /use my location/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission was denied/i);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /city museum/i })).toBeEnabled()
    );
  });
});

function createDestinationAdapter(
  selectedDestination: Destination
): DestinationSearchAdapter {
  return {
    mount(host, { onSelect }) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = selectedDestination.name;
      button.addEventListener("click", () => onSelect(selectedDestination));
      host.replaceChildren(button);
      return () => button.remove();
    }
  };
}
