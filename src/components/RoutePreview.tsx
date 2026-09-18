import { decode } from "@googlemaps/polyline-codec";
import { useEffect, useRef, useState } from "react";
import type { RoutePlan } from "../domain/types";
import {
  loadGoogleLibraries,
  type GoogleLibraries
} from "../google/mapsLoader";

export type RouteMapAdapter = {
  attribution?: string;
  mount(
    host: HTMLElement,
    route: RoutePlan
  ): (() => void) | Promise<() => void>;
};

type RoutePreviewProps = {
  route: RoutePlan;
  mapAdapter: RouteMapAdapter;
  onStart: () => void;
  onBack: () => void;
};

type GoogleLibrariesLoader = (apiKey: string) => Promise<GoogleLibraries>;

export function createGoogleRouteMapAdapter(
  apiKey: string,
  loadLibraries: GoogleLibrariesLoader = loadGoogleLibraries
): RouteMapAdapter {
  return {
    attribution: `Powered by Google, ©${new Date().getFullYear()} Google`,
    async mount(host, route) {
      const { maps } = await loadLibraries(apiKey);
      const path = decode(route.encodedPolyline).map(([lat, lng]) => ({
        lat,
        lng
      }));
      if (path.length < 2) {
        throw new Error("The route preview has too few points.");
      }

      const map = new maps.Map(host, {
        disableDefaultUI: true,
        clickableIcons: false,
        gestureHandling: "none",
        backgroundColor: "#0b1e14"
      });
      const polyline = new maps.Polyline({
        map,
        path,
        clickable: false,
        geodesic: true,
        strokeColor: "#20e878",
        strokeOpacity: 1,
        strokeWeight: 6
      });
      const latitudes = path.map((point) => point.lat);
      const longitudes = path.map((point) => point.lng);
      map.fitBounds(
        {
          north: Math.max(...latitudes),
          south: Math.min(...latitudes),
          east: Math.max(...longitudes),
          west: Math.min(...longitudes)
        },
        24
      );

      return () => {
        polyline.setMap(null);
        host.replaceChildren();
      };
    }
  };
}

export function createRouteShapeMapAdapter(): RouteMapAdapter {
  return {
    attribution:
      "© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors",
    mount(host, route) {
      const path = decode(route.encodedPolyline);
      if (path.length < 2) {
        throw new Error("The route preview has too few points.");
      }
      const points = fitRouteShape(path);
      const namespace = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(namespace, "svg");
      svg.setAttribute("viewBox", "0 0 200 200");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Route shape from current location to destination");
      const line = document.createElementNS(namespace, "polyline");
      line.setAttribute(
        "points",
        points.map(([x, y]) => `${x},${y}`).join(" ")
      );
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "#20e878");
      line.setAttribute("stroke-width", "7");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-linejoin", "round");
      const start = createEndpoint(namespace, points[0]!, "#f5fff8");
      const destination = createEndpoint(
        namespace,
        points.at(-1)!,
        "#20e878"
      );
      svg.append(line, start, destination);
      host.replaceChildren(svg);
      return () => host.replaceChildren();
    }
  };
}

export function RoutePreview({
  route,
  mapAdapter,
  onStart,
  onBack
}: RoutePreviewProps) {
  const mapHost = useRef<HTMLDivElement>(null);
  const [mapError, setMapError] = useState<string>();

  useEffect(() => {
    const host = mapHost.current;
    if (!host) return;

    let active = true;
    let dispose: (() => void) | undefined;
    Promise.resolve(mapAdapter.mount(host, route))
      .then((mountedDispose) => {
        if (active) dispose = mountedDispose;
        else mountedDispose();
      })
      .catch(() => {
        if (active) setMapError("The route map could not be displayed.");
      });

    return () => {
      active = false;
      dispose?.();
    };
  }, [mapAdapter, route]);

  return (
    <section className="preview-card" aria-labelledby="preview-title">
      <div className="preview-heading">
        <div>
          <p className="step-label">Walking route</p>
          <h2 id="preview-title">{route.destination.name}</h2>
        </div>
        <button type="button" className="text-button" onClick={onBack}>
          Back
        </button>
      </div>

      <div ref={mapHost} className="route-map" aria-label="Walking route map" />
      {mapError && <p role="alert">{mapError}</p>}
      {mapAdapter.attribution && (
        <p className="provider-attribution">{mapAdapter.attribution}</p>
      )}

      <dl className="route-summary">
        <div>
          <dt>Distance</dt>
          <dd>{formatDistance(route.distanceMeters)}</dd>
        </div>
        <div>
          <dt>Walking time</dt>
          <dd>{Math.max(1, Math.ceil(route.durationSeconds / 60))} min</dd>
        </div>
      </dl>

      <button type="button" className="primary-button" onClick={onStart}>
        Start AR walk
      </button>
    </section>
  );
}

function fitRouteShape(
  path: readonly (readonly [number, number])[]
): [number, number][] {
  const latitudes = path.map(([lat]) => lat);
  const longitudes = path.map(([, lng]) => lng);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;
  const spanLat = Math.max(maxLat - minLat, 1e-9);
  const spanLng = Math.max(maxLng - minLng, 1e-9);
  const scale = Math.min(176 / spanLng, 176 / spanLat);
  return path.map(([lat, lng]) => [
    roundShapeCoordinate(100 + (lng - midLng) * scale),
    roundShapeCoordinate(100 - (lat - midLat) * scale)
  ]);
}

function createEndpoint(
  namespace: string,
  [cx, cy]: readonly [number, number],
  fill: string
): Element {
  const circle = document.createElementNS(namespace, "circle");
  circle.setAttribute("cx", String(cx));
  circle.setAttribute("cy", String(cy));
  circle.setAttribute("r", "7");
  circle.setAttribute("fill", fill);
  circle.setAttribute("stroke", "#07140d");
  circle.setAttribute("stroke-width", "3");
  return circle;
}

function roundShapeCoordinate(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function formatDistance(distanceMeters: number): string {
  if (distanceMeters < 1_000) {
    return `${Math.round(distanceMeters)} m`;
  }
  return `${(distanceMeters / 1_000).toFixed(1)} km`;
}
