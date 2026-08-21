import type { NavigationStage } from "../domain/types";

type ResumeStage = "navigating" | "trackingWeak" | "realign";

export type NavigationState = {
  stage: NavigationStage;
  message?: string;
  resumeStage?: ResumeStage;
};

export type NavigationEvent =
  | { type: "ROUTE_READY" }
  | { type: "START" }
  | { type: "PERMISSIONS_GRANTED" }
  | { type: "PERMISSIONS_DENIED"; message: string }
  | { type: "RETRY_PERMISSIONS" }
  | { type: "BACK_TO_PREVIEW" }
  | { type: "CALIBRATION_LOCKED" }
  | { type: "TRACKING_WEAK" }
  | { type: "TRACKING_RECOVERED" }
  | { type: "REALIGN_REQUIRED" }
  | { type: "REALIGN_COMPLETE" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "ARRIVED" }
  | { type: "END" };

export function initialNavigationState(): NavigationState {
  return { stage: "search" };
}

export function navigationReducer(
  state: NavigationState,
  event: NavigationEvent
): NavigationState {
  if (event.type === "END" && state.stage !== "ended") return { stage: "ended" };

  switch (event.type) {
    case "ROUTE_READY":
      return state.stage === "search" ? { stage: "preview" } : state;
    case "START":
      return state.stage === "preview" ? { stage: "permissions" } : state;
    case "PERMISSIONS_GRANTED":
      return state.stage === "permissions" ? { stage: "calibration" } : state;
    case "PERMISSIONS_DENIED":
      return state.stage === "permissions"
        ? { stage: "permissionError", message: event.message }
        : state;
    case "RETRY_PERMISSIONS":
      return state.stage === "permissionError" ? { stage: "permissions" } : state;
    case "BACK_TO_PREVIEW":
      return state.stage === "permissionError" ? { stage: "preview" } : state;
    case "CALIBRATION_LOCKED":
      return state.stage === "calibration" ? { stage: "navigating" } : state;
    case "TRACKING_WEAK":
      return state.stage === "navigating" ? { stage: "trackingWeak" } : state;
    case "TRACKING_RECOVERED":
      return state.stage === "trackingWeak" ? { stage: "navigating" } : state;
    case "REALIGN_REQUIRED":
      return state.stage === "navigating" || state.stage === "trackingWeak"
        ? { stage: "realign" }
        : state;
    case "REALIGN_COMPLETE":
      return state.stage === "realign" ? { stage: "navigating" } : state;
    case "PAUSE":
      return isPausable(state.stage)
        ? { stage: "paused", resumeStage: state.stage }
        : state;
    case "RESUME":
      return state.stage === "paused" && state.resumeStage
        ? { stage: state.resumeStage }
        : state;
    case "ARRIVED":
      return isActive(state.stage) ? { stage: "arrived" } : state;
    case "END":
      return state;
  }
}

function isPausable(stage: NavigationStage): stage is ResumeStage {
  return stage === "navigating" || stage === "trackingWeak" || stage === "realign";
}

function isActive(stage: NavigationStage): boolean {
  return isPausable(stage) || stage === "paused";
}
