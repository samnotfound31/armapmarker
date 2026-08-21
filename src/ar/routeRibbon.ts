import type { RouteGroundPoint } from "../domain/types";

export type RouteMarkerKind = "arrow" | "bar";

export type RouteMarker = {
  kind: RouteMarkerKind;
  routeDistanceMeters: number;
  widthMeters: number;
  emphasized: boolean;
  vertexOffset: number;
  vertexCount: number;
};

export type RouteRibbon = {
  positions: Float32Array;
  indices: Uint16Array;
  markers: RouteMarker[];
  drawStartRouteDistanceMeters: number;
  drawEndRouteDistanceMeters: number;
};

export type RouteRibbonOptions = {
  markerSpacingMeters: number;
  startAheadMeters: number;
  maximumDrawDistanceMeters: number;
  markerWidthMeters: number;
  barLengthMeters: number;
  arrowLengthMeters: number;
  turnEmphasisFactor: number;
  turnThresholdRad: number;
};

const DEFAULT_OPTIONS: Readonly<RouteRibbonOptions> = {
  markerSpacingMeters: 2.5,
  startAheadMeters: 1,
  maximumDrawDistanceMeters: 35,
  markerWidthMeters: 1.4,
  barLengthMeters: 0.35,
  arrowLengthMeters: 1.6,
  turnEmphasisFactor: 1.25,
  turnThresholdRad: Math.PI / 6
};

type SampledRoutePoint = {
  rightMeters: number;
  upMeters: number;
  forwardMeters: number;
  tangentRight: number;
  tangentForward: number;
};

export function buildRouteRibbon(
  route: readonly RouteGroundPoint[],
  progressMeters: number,
  options: Partial<RouteRibbonOptions> = {}
): RouteRibbon {
  validateRoute(route);
  const config = { ...DEFAULT_OPTIONS, ...options };
  validateOptions(config);
  const routeEnd = route.at(-1)!.routeDistanceMeters;
  const drawStart = Math.max(0, progressMeters) + config.startAheadMeters;
  const drawEnd = Math.min(
    routeEnd,
    Math.max(0, progressMeters) + config.maximumDrawDistanceMeters
  );
  if (drawStart > drawEnd) return emptyRibbon(drawStart, drawEnd);

  const turnDistances = findTurnDistances(route, config.turnThresholdRad);
  const positions: number[] = [];
  const indices: number[] = [];
  const markers: RouteMarker[] = [];
  let markerIndex = 0;

  for (
    let distance = drawStart;
    distance <= drawEnd + 1e-8;
    distance += config.markerSpacingMeters
  ) {
    const sample = sampleRoute(route, distance);
    const emphasized = turnDistances.some(
      (turnDistance) =>
        Math.abs(turnDistance - distance) <= config.markerSpacingMeters
    );
    const width =
      config.markerWidthMeters * (emphasized ? config.turnEmphasisFactor : 1);
    const kind: RouteMarkerKind = markerIndex % 2 === 0 ? "arrow" : "bar";
    const vertexOffset = positions.length / 3;
    if (kind === "arrow") {
      appendArrow(
        sample,
        width,
        config.arrowLengthMeters * (emphasized ? config.turnEmphasisFactor : 1),
        positions,
        indices
      );
    } else {
      appendBar(sample, width, config.barLengthMeters, positions, indices);
    }
    markers.push({
      kind,
      routeDistanceMeters: roundDistance(distance),
      widthMeters: width,
      emphasized,
      vertexOffset,
      vertexCount: positions.length / 3 - vertexOffset
    });
    markerIndex += 1;
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint16Array(indices),
    markers,
    drawStartRouteDistanceMeters: drawStart,
    drawEndRouteDistanceMeters: drawEnd
  };
}

function appendArrow(
  sample: SampledRoutePoint,
  width: number,
  length: number,
  positions: number[],
  indices: number[]
): void {
  const base = positions.length / 3;
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const stemHalfWidth = width * 0.18;
  const shoulderAlong = length * 0.05;
  const points: Array<[number, number]> = [
    [0, halfLength],
    [-halfWidth, shoulderAlong],
    [-stemHalfWidth, shoulderAlong],
    [-stemHalfWidth, -halfLength],
    [stemHalfWidth, -halfLength],
    [stemHalfWidth, shoulderAlong],
    [halfWidth, shoulderAlong]
  ];
  points.forEach(([lateral, along]) =>
    appendGroundVertex(sample, lateral, along, positions)
  );
  indices.push(
    base, base + 1, base + 6,
    base + 2, base + 3, base + 4,
    base + 2, base + 4, base + 5
  );
}

function appendBar(
  sample: SampledRoutePoint,
  width: number,
  length: number,
  positions: number[],
  indices: number[]
): void {
  const base = positions.length / 3;
  const halfWidth = width / 2;
  const halfLength = length / 2;
  appendGroundVertex(sample, -halfWidth, -halfLength, positions);
  appendGroundVertex(sample, halfWidth, -halfLength, positions);
  appendGroundVertex(sample, halfWidth, halfLength, positions);
  appendGroundVertex(sample, -halfWidth, halfLength, positions);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function appendGroundVertex(
  sample: SampledRoutePoint,
  lateralMeters: number,
  alongMeters: number,
  positions: number[]
): void {
  const perpendicularRight = sample.tangentForward;
  const perpendicularForward = -sample.tangentRight;
  positions.push(
    sample.rightMeters +
      perpendicularRight * lateralMeters +
      sample.tangentRight * alongMeters,
    sample.upMeters + 0.025,
    sample.forwardMeters +
      perpendicularForward * lateralMeters +
      sample.tangentForward * alongMeters
  );
}

function sampleRoute(
  route: readonly RouteGroundPoint[],
  distanceMeters: number
): SampledRoutePoint {
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]!;
    const end = route[index + 1]!;
    if (distanceMeters > end.routeDistanceMeters && index < route.length - 2) {
      continue;
    }
    const routeDelta = end.routeDistanceMeters - start.routeDistanceMeters;
    const fraction = routeDelta <= 0
      ? 0
      : clamp((distanceMeters - start.routeDistanceMeters) / routeDelta, 0, 1);
    const rightDelta = end.rightMeters - start.rightMeters;
    const forwardDelta = end.forwardMeters - start.forwardMeters;
    const tangentLength = Math.hypot(rightDelta, forwardDelta);
    if (tangentLength <= 1e-9) continue;
    return {
      rightMeters: start.rightMeters + rightDelta * fraction,
      upMeters: start.upMeters + (end.upMeters - start.upMeters) * fraction,
      forwardMeters: start.forwardMeters + forwardDelta * fraction,
      tangentRight: rightDelta / tangentLength,
      tangentForward: forwardDelta / tangentLength
    };
  }
  throw new RangeError("Route has no non-zero segment at this distance.");
}

function findTurnDistances(
  route: readonly RouteGroundPoint[],
  thresholdRad: number
): number[] {
  const distances: number[] = [];
  for (let index = 1; index < route.length - 1; index += 1) {
    const previous = route[index - 1]!;
    const current = route[index]!;
    const next = route[index + 1]!;
    const incoming = normalize2(
      current.rightMeters - previous.rightMeters,
      current.forwardMeters - previous.forwardMeters
    );
    const outgoing = normalize2(
      next.rightMeters - current.rightMeters,
      next.forwardMeters - current.forwardMeters
    );
    if (!incoming || !outgoing) continue;
    const cosine = clamp(incoming[0] * outgoing[0] + incoming[1] * outgoing[1], -1, 1);
    if (Math.acos(cosine) >= thresholdRad) distances.push(current.routeDistanceMeters);
  }
  return distances;
}

function validateRoute(route: readonly RouteGroundPoint[]): void {
  if (route.length < 2) throw new RangeError("Route ribbon requires two route points.");
  for (let index = 1; index < route.length; index += 1) {
    if (route[index]!.routeDistanceMeters <= route[index - 1]!.routeDistanceMeters) {
      throw new RangeError("Route distances must increase.");
    }
  }
}

function validateOptions(options: RouteRibbonOptions): void {
  const values = [
    options.markerSpacingMeters,
    options.startAheadMeters,
    options.maximumDrawDistanceMeters,
    options.markerWidthMeters,
    options.barLengthMeters,
    options.arrowLengthMeters,
    options.turnEmphasisFactor,
    options.turnThresholdRad
  ];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("Route ribbon dimensions must be positive.");
  }
}

function emptyRibbon(drawStart: number, drawEnd: number): RouteRibbon {
  return {
    positions: new Float32Array(),
    indices: new Uint16Array(),
    markers: [],
    drawStartRouteDistanceMeters: drawStart,
    drawEndRouteDistanceMeters: drawEnd
  };
}

function normalize2(x: number, y: number): [number, number] | null {
  const length = Math.hypot(x, y);
  return length <= 1e-9 ? null : [x / length, y / length];
}

function roundDistance(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
