import { useEffect, useRef, useState } from "react";
import {
  ArPermissionError,
  requestArAccess,
  type ArAccessGrant
} from "../device/permissions";
import { stopMediaStream } from "../device/camera";

type PermissionScreenProps = {
  requestAccess?: (
    video: HTMLVideoElement,
    signal: AbortSignal
  ) => Promise<ArAccessGrant>;
  onReady: (grant: ArAccessGrant) => void;
  onBack: () => void;
};

type PermissionStatus = "idle" | "requesting" | "ready" | "error";

export function PermissionScreen({
  requestAccess = requestArAccess,
  onReady,
  onBack
}: PermissionScreenProps) {
  const video = useRef<HTMLVideoElement>(null);
  const requestController = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<PermissionStatus>("idle");
  const [error, setError] = useState<string>();

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    []
  );

  const enableAccess = async () => {
    if (!video.current) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setStatus("requesting");
    setError(undefined);
    try {
      const grant = await requestAccess(video.current, controller.signal);
      if (controller.signal.aborted) {
        stopMediaStream(grant.stream);
        return;
      }
      setStatus("ready");
      onReady(grant);
    } catch (permissionError) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setError(recoveryMessage(permissionError));
    }
  };

  return (
    <section className="permission-card" aria-labelledby="permission-title">
      <div className="preview-heading">
        <div>
          <p className="step-label">Step 2</p>
          <h2 id="permission-title">Enable AR access</h2>
        </div>
        <button type="button" className="text-button" onClick={onBack}>
          Back
        </button>
      </div>

      <p className="permission-intro">
        AR walking needs three signals. Your camera frames stay on this phone.
      </p>
      <ul className="permission-list">
        <li><strong>Rear camera</strong> to show the road.</li>
        <li><strong>Motion sensors</strong> to follow how the phone turns.</li>
        <li><strong>Fresh location</strong> to place you on the walking route.</li>
      </ul>

      <video
        ref={video}
        className={status === "ready" ? "permission-video is-ready" : "permission-video"}
        muted
        playsInline
        aria-label="Rear camera preview"
      />

      {error && <p role="alert">{error}</p>}
      {status === "ready" ? (
        <p className="permission-ready" role="status">
          Camera and sensors are ready. Keep the phone at a steady height.
        </p>
      ) : (
        <button
          type="button"
          className="primary-button"
          disabled={status === "requesting"}
          onClick={() => void enableAccess()}
        >
          {status === "requesting"
            ? "Waiting for permissions…"
            : status === "error"
              ? "Try permissions again"
              : "Enable camera and sensors"}
        </button>
      )}
    </section>
  );
}

function recoveryMessage(error: unknown): string {
  if (!(error instanceof ArPermissionError)) {
    return "AR access could not be completed. Try again.";
  }
  switch (error.code) {
    case "camera-denied":
      return "Allow camera access in your browser settings, then try again.";
    case "motion-denied":
      return "Allow motion and orientation access, then tap try again.";
    case "location-denied":
      return "Allow precise location access in your browser settings, then try again.";
    case "location-inaccurate":
      return "Improving location accuracy. Move outdoors and try again.";
    case "insecure-context":
      return "Open this app over HTTPS before enabling AR.";
    case "motion-unavailable":
      return "This browser does not expose the motion sensors AR needs.";
    case "camera-unavailable":
      return "The rear camera is unavailable. Close other camera apps and try again.";
    case "location-unavailable":
      return "A fresh location is unavailable. Move outdoors and try again.";
  }
}
