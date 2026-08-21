import { describe, expect, it } from "vitest";
import {
  initialNavigationState,
  navigationReducer
} from "./navigationMachine";

describe("navigationReducer", () => {
  it("drives preview through permissions and calibration to arrival", () => {
    let state = initialNavigationState();
    state = navigationReducer(state, { type: "ROUTE_READY" });
    expect(state.stage).toBe("preview");
    state = navigationReducer(state, { type: "START" });
    expect(state.stage).toBe("permissions");
    state = navigationReducer(state, { type: "PERMISSIONS_GRANTED" });
    expect(state.stage).toBe("calibration");
    state = navigationReducer(state, { type: "CALIBRATION_LOCKED" });
    expect(state.stage).toBe("navigating");
    state = navigationReducer(state, { type: "ARRIVED" });
    expect(state.stage).toBe("arrived");
  });

  it("gives permission failure an explicit retry and back action", () => {
    const permissions = { stage: "permissions" as const };
    const failed = navigationReducer(permissions, {
      type: "PERMISSIONS_DENIED",
      message: "Camera access was denied"
    });
    expect(failed).toMatchObject({
      stage: "permissionError",
      message: "Camera access was denied"
    });
    expect(navigationReducer(failed, { type: "RETRY_PERMISSIONS" }).stage).toBe(
      "permissions"
    );
    expect(navigationReducer(failed, { type: "BACK_TO_PREVIEW" }).stage).toBe("preview");
  });

  it("recovers weak tracking, pause, and realignment", () => {
    const navigating = { stage: "navigating" as const };
    const weak = navigationReducer(navigating, { type: "TRACKING_WEAK" });
    expect(weak.stage).toBe("trackingWeak");
    expect(navigationReducer(weak, { type: "TRACKING_RECOVERED" }).stage).toBe(
      "navigating"
    );

    const paused = navigationReducer(weak, { type: "PAUSE" });
    expect(paused).toMatchObject({ stage: "paused", resumeStage: "trackingWeak" });
    expect(navigationReducer(paused, { type: "RESUME" }).stage).toBe("trackingWeak");

    const realign = navigationReducer(navigating, { type: "REALIGN_REQUIRED" });
    expect(realign.stage).toBe("realign");
    expect(navigationReducer(realign, { type: "REALIGN_COMPLETE" }).stage).toBe(
      "navigating"
    );
  });

  it("always exposes an end transition from active recovery states", () => {
    expect(
      navigationReducer({ stage: "realign" }, { type: "END" }).stage
    ).toBe("ended");
    expect(
      navigationReducer(
        { stage: "paused", resumeStage: "navigating" },
        { type: "END" }
      ).stage
    ).toBe("ended");
  });
});
