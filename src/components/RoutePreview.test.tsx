import { fireEvent, render, screen } from "@testing-library/react";
import { encode } from "@googlemaps/polyline-codec";
import { describe, expect, it, vi } from "vitest";
import type { RoutePlan } from "../domain/types";
import {
  createGoogleRouteMapAdapter,
  createRouteShapeMapAdapter,
  RoutePreview,
  type RouteMapAdapter
} from "./RoutePreview";

const route: RoutePlan = {
  origin: { lat: 22.57, lng: 88.36 },
  destination: { lat: 22.58, lng: 88.37, name: "City Museum" },
  encodedPolyline: "encoded-route",
  distanceMeters: 1200,
  durationSeconds: 932,
  steps: []
};

const mapAdapter: RouteMapAdapter = {
  attribution: "© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors",
  mount: () => () => undefined
};

describe("RoutePreview", () => {
  it("draws and disposes the decoded walking polyline", async () => {
    const host = document.createElement("div");
    const setMap = vi.fn();
    const fitBounds = vi.fn();
    const Map = vi.fn(function FakeMap() {
      return { fitBounds };
    });
    const Polyline = vi.fn(function FakePolyline() {
      return { setMap };
    });
    const adapter = createGoogleRouteMapAdapter(
      "browser-key",
      vi.fn(async () => ({ places: {}, maps: { Map, Polyline } })) as never
    );
    const validRoute = {
      ...route,
      encodedPolyline: encode([
        [22.57, 88.36],
        [22.58, 88.37]
      ])
    };

    const dispose = await adapter.mount(host, validRoute);

    expect(Polyline).toHaveBeenCalledWith(
      expect.objectContaining({
        path: [
          { lat: 22.57, lng: 88.36 },
          { lat: 22.58, lng: 88.37 }
        ],
        strokeColor: "#20e878"
      })
    );
    expect(fitBounds).toHaveBeenCalledOnce();
    dispose();
    expect(setMap).toHaveBeenLastCalledWith(null);
  });

  it("renders a provider-neutral route shape without a map SDK", async () => {
    const host = document.createElement("div");
    const adapter = createRouteShapeMapAdapter();
    const validRoute = {
      ...route,
      encodedPolyline: encode([
        [22.57, 88.36],
        [22.575, 88.365],
        [22.58, 88.37]
      ])
    };

    const dispose = await adapter.mount(host, validRoute);

    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.querySelector("polyline")?.getAttribute("points")).toBe(
      "12,188 100,100 188,12"
    );
    expect(host.querySelectorAll("circle")).toHaveLength(2);
    dispose();
    expect(host).toBeEmptyDOMElement();
  });

  it("shows the walking summary and provider attribution", () => {
    render(
      <RoutePreview
        route={route}
        mapAdapter={mapAdapter}
        onStart={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "City Museum" })).toBeVisible();
    expect(screen.getByText("1.2 km")).toBeVisible();
    expect(screen.getByText("16 min")).toBeVisible();
    expect(screen.getByText(/openrouteservice\.org by heigit/i)).toBeVisible();
    expect(screen.getByText(/openstreetmap contributors/i)).toBeVisible();
  });

  it("offers back and AR-start actions", () => {
    const onBack = vi.fn();
    const onStart = vi.fn();
    render(
      <RoutePreview
        route={route}
        mapAdapter={mapAdapter}
        onStart={onStart}
        onBack={onBack}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    fireEvent.click(screen.getByRole("button", { name: /start ar walk/i }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
  });
});
