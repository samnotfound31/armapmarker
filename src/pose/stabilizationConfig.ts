/** Initial field-test values; all limits concern presentation, never geographic navigation. */
export const STABILIZATION_CONFIG = {
    historyMs: 2000, yawCorrectionMs: 2000, tiltCorrectionMs: 200,
    predictionMs: 30, maxPredictionRad: .05, compassJumpRad: 15 * Math.PI / 180,
    positionPredictionMs: 1000, maxPositionPredictionMeters: 1,
    positionResetMeters: 3, maxWalkingSpeedMetersPerSecond: 2.5,
    maxResidualPixelsAt480: 40, maxInnovationPixelsAt480: 18,
    maxRegistrationMeters: 2, weakOpacity: .55, opacityTimeMs: 280,
    maxLateralMeters: 1, maxYawRad: 5 * Math.PI / 180,
    captureIntervalMs: 80, keyframeMinimumAgeMs: 800, keyframeMaximumAgeMs: 2000
} as const;
