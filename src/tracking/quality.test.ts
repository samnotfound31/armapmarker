import { describe, expect, it } from "vitest";
import goodSequence from "../test/fixtures/tracking/good-sequence.json";
import lowTextureSequence from "../test/fixtures/tracking/low-texture-sequence.json";
import outlierSequence from "../test/fixtures/tracking/outlier-sequence.json";
import {
  DEFAULT_TRACKING_THRESHOLDS,
  TrackingQualityGate
} from "./quality";
import type { TrackingObservation } from "./types";

const good = goodSequence as TrackingObservation[];
const lowTexture = lowTextureSequence as TrackingObservation[];
const outliers = outlierSequence as TrackingObservation[];

describe("TrackingQualityGate", () => {
  it("requires thirty candidates and fifteen RANSAC inliers for initial lock", () => {
    const gate = new TrackingQualityGate(DEFAULT_TRACKING_THRESHOLDS);

    gate.update({ ...good[0]!, candidateCount: 29 });
    expect(gate.state).toBe("weak");

    gate.update({ ...good[0]!, candidateCount: 30, inlierCount: 15 });
    expect(gate.state).toBe("locked");
  });

  it("enters weak only after five consecutive poor frames", () => {
    const gate = lockedGate();

    lowTexture.slice(0, 4).forEach((observation) => gate.update(observation));
    expect(gate.state).toBe("locked");

    gate.update(lowTexture[4]!);
    expect(gate.state).toBe("weak");
  });

  it("enters realign after ten critical frames", () => {
    const gate = lockedGate();
    const critical = [...outliers, ...outliers].map((observation, index) => ({
      ...observation,
      timestampMs: 1300 + index * 33
    }));

    critical.slice(0, 9).forEach((observation) => gate.update(observation));
    expect(gate.state).toBe("weak");
    gate.update(critical[9]!);
    expect(gate.state).toBe("realign");
  });

  it("does not recover from one lucky frame", () => {
    const gate = lockedGate();
    lowTexture.forEach((observation) => gate.update(observation));
    expect(gate.state).toBe("weak");

    gate.update(good[0]!);
    expect(gate.state).toBe("weak");
    gate.update(good[1]!);
    gate.update(good[2]!);
    expect(gate.state).toBe("locked");
  });

  it("latches realign through later stable frames until a fresh gate is constructed", () => {
    const gate = lockedGate();
    const critical = [...outliers, ...outliers].slice(0, 10).map((observation, index) => ({
      ...observation,
      timestampMs: 1300 + index * 33
    }));
    critical.forEach((observation) => gate.update(observation));
    expect(gate.state).toBe("realign");

    for (let index = 0; index < 12; index += 1) {
      gate.update({ ...good[index % good.length]!, timestampMs: 2000 + index * 33 });
    }

    expect(gate.state).toBe("realign");
    expect(new TrackingQualityGate(DEFAULT_TRACKING_THRESHOLDS).state).toBe("weak");
  });

  it("rejects observations and homographies older than 250 milliseconds", () => {
    const gate = lockedGate();
    const outcome = gate.update(
      {
        ...good[0]!,
        observedHomography: [1, 0, 0, 0, 1, 0, 2, -1, 1]
      },
      good[0]!.timestampMs + 251
    );

    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe("stale");
    expect(gate.freshHomographyAt(good[0]!.timestampMs + 251)).toBeNull();
  });

  it("treats low inlier ratio or high reprojection error as weak evidence", () => {
    const gate = lockedGate();
    const ratioFailure = {
      ...good[0]!,
      candidateCount: 40,
      inlierCount: 20,
      medianReprojectionErrorPx: 1
    };
    const reprojectionFailure = {
      ...good[0]!,
      candidateCount: 40,
      inlierCount: 30,
      medianReprojectionErrorPx: 3.01
    };

    for (let index = 0; index < 4; index += 1) gate.update(ratioFailure);
    expect(gate.state).toBe("locked");
    gate.update(reprojectionFailure);
    expect(gate.state).toBe("weak");
  });
});

function lockedGate(): TrackingQualityGate {
  const gate = new TrackingQualityGate(DEFAULT_TRACKING_THRESHOLDS);
  gate.update(good[0]!);
  expect(gate.state).toBe("locked");
  return gate;
}
