import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationSnapshot } from "../navigation/navigationEngine";
import { NavigationHud } from "./NavigationHud";

describe("NavigationHud", () => {
  it("shows maneuver, remaining distance, tracking quality, safety, and exit", () => {
    const onExit = vi.fn();
    render(
      <NavigationHud
        navigation={snapshot()}
        onExit={onExit}
        onRealign={vi.fn()}
        onRecalculate={vi.fn()}
        onKeepRoute={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: /turn left/i })).toBeVisible();
    expect(screen.getByText(/35 m/i)).toBeVisible();
    expect(screen.getByText(/82 m remaining/i)).toBeVisible();
    expect(screen.getByText(/tracking locked/i)).toBeVisible();
    expect(screen.getByText(/walking only.*stay aware/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /exit/i }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("offers explicit off-route and realign recovery actions", () => {
    const onRecalculate = vi.fn();
    const onKeepRoute = vi.fn();
    const onRealign = vi.fn();
    render(
      <NavigationHud
        navigation={{
          ...snapshot(),
          offRoute: true,
          realignRequired: true,
          trackingQuality: { ...snapshot().trackingQuality, state: "realign" }
        }}
        onExit={vi.fn()}
        onRealign={onRealign}
        onRecalculate={onRecalculate}
        onKeepRoute={onKeepRoute}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /recalculate/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep current route/i }));
    fireEvent.click(screen.getByRole("button", { name: /re-align/i }));
    expect(onRecalculate).toHaveBeenCalledOnce();
    expect(onKeepRoute).toHaveBeenCalledOnce();
    expect(onRealign).toHaveBeenCalledOnce();
  });
});

function snapshot(): NavigationSnapshot {
  return {
    routeProgressMeters: 18,
    acceptedGpsProgressMeters: 18,
    remainingDistanceMeters: 82,
    nextManeuver: {
      instruction: "Turn left",
      maneuver: "TURN_LEFT",
      distanceToManeuverMeters: 35,
      stepIndex: 1
    },
    offRoute: false,
    trackingQuality: {
      state: "locked",
      featureCount: 40,
      inlierCount: 30,
      inlierRatio: 0.75,
      medianReprojectionErrorPx: 1
    },
    arrived: false,
    realignRequired: false,
    timestampMs: 1000
  };
}
