import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import { CalibrationScreen, type CalibrationFeed } from "./CalibrationScreen";

const feed: CalibrationFeed = {
  captureOrientation: async () => ({
    samples: Array.from({ length: 5 }, () => ({
      headingRad: 0,
      pitchRad: 0.4,
      rollRad: 0
    })),
    cameraFromGroundAtLock: IDENTITY_MAT4
  }),
  scanFeatures: async () =>
    Array.from({ length: 20 }, () => ({
      featureCount: 35,
      inlierCount: 20,
      angularMotionRad: 0.04
    }))
};

describe("CalibrationScreen", () => {
  it("guides height, orientation, near/far taps, scan, and route lock", async () => {
    const onLock = vi.fn();
    render(
      <CalibrationScreen
        feed={feed}
        screenPointToGround={({ yPx }) => (yPx < 200 ? [0, 0, 3] : [0, 0, 6])}
        routeNearPoint={{
          rightMeters: 0,
          upMeters: 0,
          forwardMeters: 3,
          routeDistanceMeters: 10
        }}
        intrinsics={buildApproximateIntrinsics(1920, 1080)}
        imageToScreen={IDENTITY_MAT3}
        onLock={onLock}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /chest.*1\.4 m/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /chest.*1\.4 m/i }));
    fireEvent.click(screen.getByRole("button", { name: /capture standing pose/i }));
    expect(await screen.findByText(/tap a near point/i)).toBeVisible();

    const roadView = screen.getByRole("button", { name: /road calibration view/i });
    fireEvent.pointerDown(roadView, { clientX: 100, clientY: 100 });
    expect(await screen.findByText(/tap a far point/i)).toBeVisible();
    fireEvent.pointerDown(roadView, { clientX: 100, clientY: 300 });
    fireEvent.click(await screen.findByRole("button", { name: /scan road features/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /lock route.*start ar/i })
    );

    expect(onLock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "locked", cameraHeightMeters: 1.4 })
    );
  });

  it("keeps the tap stage and explains an invalid road ray", async () => {
    render(
      <CalibrationScreen
        feed={feed}
        screenPointToGround={() => null}
        routeNearPoint={{
          rightMeters: 0,
          upMeters: 0,
          forwardMeters: 3,
          routeDistanceMeters: 10
        }}
        intrinsics={buildApproximateIntrinsics(1920, 1080)}
        imageToScreen={IDENTITY_MAT3}
        onLock={vi.fn()}
        onBack={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /chest.*1\.4 m/i }));
    fireEvent.click(screen.getByRole("button", { name: /capture standing pose/i }));
    const roadView = await screen.findByRole("button", {
      name: /road calibration view/i
    });
    fireEvent.pointerDown(roadView, { clientX: 100, clientY: 100 });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /aim lower at the road/i
    );
    expect(screen.getByText(/tap a near point/i)).toBeVisible();
  });
});
