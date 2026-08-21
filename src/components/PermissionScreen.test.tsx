import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArAccessGrant } from "../device/permissions";
import { ArPermissionError } from "../device/permissions";
import { PermissionScreen } from "./PermissionScreen";

const grant: ArAccessGrant = {
  stream: { getTracks: () => [] } as unknown as MediaStream,
  location: {
    point: { lat: 22.57, lng: 88.36 },
    accuracyMeters: 8,
    timestampMs: 1000
  }
};

describe("PermissionScreen", () => {
  it("requests camera and sensors only after the user gesture", async () => {
    const requestAccess = vi.fn(async () => grant);
    const onReady = vi.fn();
    render(
      <PermissionScreen
        requestAccess={requestAccess}
        onReady={onReady}
        onBack={vi.fn()}
      />
    );

    expect(requestAccess).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /enable camera and sensors/i })
    );

    expect(await screen.findByText(/camera and sensors are ready/i)).toBeVisible();
    expect(onReady).toHaveBeenCalledWith(grant);
  });

  it("shows camera-specific recovery and permits another gesture", async () => {
    const requestAccess = vi.fn(async () => {
      throw new ArPermissionError(
        "camera-denied",
        "Camera permission was denied."
      );
    });
    render(
      <PermissionScreen
        requestAccess={requestAccess}
        onReady={vi.fn()}
        onBack={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: /enable camera and sensors/i })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /allow camera access in your browser settings/i
    );
    fireEvent.click(screen.getByRole("button", { name: /try permissions again/i }));
    expect(requestAccess).toHaveBeenCalledTimes(2);
  });

  it("aborts a pending permission flow when leaving the screen", () => {
    let requestSignal: AbortSignal | undefined;
    const { unmount } = render(
      <PermissionScreen
        requestAccess={vi.fn((_video, signal) => {
          requestSignal = signal;
          return new Promise<ArAccessGrant>(() => undefined);
        })}
        onReady={vi.fn()}
        onBack={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /enable camera and sensors/i })
    );

    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});
