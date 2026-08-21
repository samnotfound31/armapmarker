import { describe, expect, it, vi } from "vitest";
import { startRearCamera, stopMediaStream } from "./camera";

describe("startRearCamera", () => {
  it("starts a capped rear-camera stream and attaches it to the video", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn(async () => stream);
    const video = document.createElement("video");
    const play = vi.fn(async () => undefined);
    video.play = play;

    await expect(
      startRearCamera(video, { getUserMedia } as Pick<MediaDevices, "getUserMedia">)
    ).resolves.toBe(stream);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 }
      }
    });
    expect(video.srcObject).toBe(stream);
    expect(play).toHaveBeenCalledOnce();
  });

  it("stops the acquired stream if video playback fails", async () => {
    const stop = vi.fn();
    const stream = createStream(stop);
    const video = document.createElement("video");
    video.play = vi.fn(async () => {
      throw new Error("playback failed");
    });

    await expect(
      startRearCamera(video, {
        getUserMedia: vi.fn(async () => stream)
      } as Pick<MediaDevices, "getUserMedia">)
    ).rejects.toThrow("playback failed");
    expect(stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });
});

it("stops every camera track", () => {
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ stop }, { stop }]
  } as unknown as MediaStream;

  stopMediaStream(stream);

  expect(stop).toHaveBeenCalledTimes(2);
});

function createStream(stop = vi.fn()): MediaStream {
  return { getTracks: () => [{ stop }] } as unknown as MediaStream;
}
