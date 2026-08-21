export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
];

export type Mat4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
];

export type GeoPoint = {
  lat: number;
  lng: number;
  altitudeMeters?: number;
};

export type Destination = {
  placeId: string;
  name: string;
  formattedAddress: string;
  location: GeoPoint;
};

export type RouteStep = {
  instruction: string;
  maneuver: string;
  distanceMeters: number;
  polyline: string;
};

export type RoutePlan = {
  origin: GeoPoint;
  destination: GeoPoint & { name: string };
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
  steps: RouteStep[];
};

export type LocalRoutePoint = {
  eastMeters: number;
  northMeters: number;
  upMeters: number;
  routeDistanceMeters: number;
};

export type RouteGroundPoint = {
  rightMeters: number;
  upMeters: number;
  forwardMeters: number;
  routeDistanceMeters: number;
};

export type CameraIntrinsics = {
  imageWidthPx: number;
  imageHeightPx: number;
  fxPx: number;
  fyPx: number;
  cxPx: number;
  cyPx: number;
  effectiveHorizontalFovDeg: number;
  source: "assumed-fov";
};

export type CalibrationStage =
  | "select-height"
  | "capture-orientation"
  | "tap-near"
  | "tap-far"
  | "scan-features"
  | "ready"
  | "locked"
  | "failed";

export type GroundCalibration = {
  stage: CalibrationStage;
  cameraHeightMeters: 1.2 | 1.4 | 1.6;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  groundFromRoute: Mat4;
  cameraFromGroundAtLock: Mat4;
  calibrationRouteDistanceMeters: number;
  lockedAtMs?: number;
};

export type TrackingState = "locked" | "weak" | "realign";

export type DeviceOrientationSample = {
  timestampMs: number;
  headingRad?: number;
  pitchRad: number;
  rollRad: number;
  headingAccuracyDeg?: number;
  headingSource: "webkit-compass" | "absolute-alpha" | "unavailable";
};

export type TrackingQuality = {
  state: TrackingState;
  featureCount: number;
  inlierCount: number;
  inlierRatio: number;
  medianReprojectionErrorPx: number;
};

export type VisualCorrection = {
  imageHomography: Mat3;
  keyframeId: number;
  timestampMs: number;
};

export type PoseEstimate = {
  cameraPositionGroundMeters: [number, number, number];
  orientationQuaternion: [number, number, number, number];
  cameraFromGround: Mat4;
  visualCorrection: VisualCorrection;
  routeProgressMeters: number;
  quality: TrackingQuality;
  timestampMs: number;
};

export type NavigationStage =
  | "search"
  | "preview"
  | "permissions"
  | "calibration"
  | "navigating"
  | "paused"
  | "permissionError"
  | "trackingWeak"
  | "realign"
  | "arrived"
  | "ended";
