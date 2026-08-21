type CameraMediaDevices = Pick<MediaDevices, "getUserMedia">;

export async function startRearCamera(
  video: HTMLVideoElement,
  mediaDevices: CameraMediaDevices | undefined = navigator.mediaDevices
): Promise<MediaStream> {
  if (!mediaDevices?.getUserMedia) {
    throw new Error("This browser does not provide camera access.");
  }

  const stream = await mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 }
    }
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  try {
    await video.play();
    return stream;
  } catch (error) {
    stopMediaStream(stream);
    video.srcObject = null;
    throw error;
  }
}

export function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
