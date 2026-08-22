import { describe, expect, it, vi } from "vitest";
import type { LocationFix } from "./location";
import {
  ArPermissionError,
  requestArAccess,
  requestMotionPermission,
  watchVisibility
} from "./permissions";

const location: LocationFix = {
  point: { lat: 22.57, lng: 88.36 },
  accuracyMeters: 8,
  timestampMs: 1000
};

describe("requestMotionPermission", () => {
  it("requests iOS orientation and motion permission from one gesture", async () => {
    const requestOrientation = vi.fn(() => Promise.resolve("granted" as const));
    const requestMotion = vi.fn(() => Promise.resolve("granted" as const));

    await expect(
      requestMotionPermission({
        isSecureContext: true,
        DeviceOrientationEvent: { requestPermission: requestOrientation },
        DeviceMotionEvent: { requestPermission: requestMotion }
      })
    ).resolves.toBe("prompted");
    expect(requestOrientation).toHaveBeenCalledOnce();
    expect(requestMotion).toHaveBeenCalledOnce();
  });

  it("uses Android's direct event path when no prompt method exists", async () => {
    await expect(
      requestMotionPermission({
        isSecureContext: true,
        DeviceOrientationEvent: {},
        DeviceMotionEvent: {}
      })
    ).resolves.toBe("not-required");
  });

  it("rejects denied motion access and an insecure origin", async () => {
    await expect(
      requestMotionPermission({
        isSecureContext: true,
        DeviceOrientationEvent: {
          requestPermission: () => Promise.resolve("denied")
        },
        DeviceMotionEvent: {}
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ArPermissionError",
        code: "motion-denied"
      })
    );
    await expect(
      requestMotionPermission({
        isSecureContext: false,
        DeviceOrientationEvent: {},
        DeviceMotionEvent: {}
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ArPermissionError",
        code: "insecure-context"
      })
    );
  });
});

describe("requestArAccess", () => {
  it("invokes camera and iOS motion permission before the first await", async () => {
    const order: string[] = [];
    const stream = createStream();
    let resolveCamera!: (stream: MediaStream) => void;
    const cameraPending = new Promise<MediaStream>((resolve) => {
      resolveCamera = resolve;
    });

    const access = requestArAccess(
      document.createElement("video"),
      new AbortController().signal,
      {
        startCamera: () => {
          order.push("camera");
          return cameraPending;
        },
        requestMotion: async () => {
          order.push("motion");
          return "prompted";
        },
        requestLocation: async () => {
          order.push("location");
          return location;
        }
      }
    );

    expect(order).toEqual(["camera", "motion"]);
    resolveCamera(stream);
    await expect(access).resolves.toEqual({ stream, location });
    expect(order).toEqual(["camera", "motion", "location"]);
  });

  it("stops the camera when a later permission fails", async () => {
    const stop = vi.fn();

    await expect(
      requestArAccess(
        document.createElement("video"),
        new AbortController().signal,
        {
          startCamera: async () => createStream(stop),
          requestMotion: async () => {
            throw new ArPermissionError(
              "motion-denied",
              "Motion permission was denied."
            );
          },
          requestLocation: vi.fn()
        }
      )
    ).rejects.toEqual(
      expect.objectContaining({ code: "motion-denied" })
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops a pending camera when the motion prompt throws synchronously", async () => {
    const stop = vi.fn();
    const stream = createStream(stop);

    await expect(
      requestArAccess(
        document.createElement("video"),
        new AbortController().signal,
        {
          startCamera: () => Promise.resolve(stream),
          requestMotion: () => {
            throw new ArPermissionError(
              "motion-denied",
              "Motion permission was denied."
            );
          },
          requestLocation: vi.fn()
        }
      )
    ).rejects.toEqual(expect.objectContaining({ code: "motion-denied" }));
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("watchVisibility", () => {
  it("pauses while hidden and resumes only after becoming visible", () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const events = new EventTarget();
    const source = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events)
    };
    const onPause = vi.fn();
    const onResume = vi.fn();
    const dispose = watchVisibility(source, { onPause, onResume });

    visibilityState = "hidden";
    events.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    events.dispatchEvent(new Event("visibilitychange"));
    dispose();
    events.dispatchEvent(new Event("visibilitychange"));

    expect(onPause).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledOnce();
  });
});

function createStream(stop = vi.fn()): MediaStream {
  return { getTracks: () => [{ stop }] } as unknown as MediaStream;
}
