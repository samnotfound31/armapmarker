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
  it("requires enough candidates, inliers and inlier ratio for initial lock", () => {
    const gate = new TrackingQualityGate(DEFAULT_TRACKING_THRESHOLDS);

    gate.update({ ...good[0]!, candidateCount: 29 });
    expect(gate.state).toBe("weak");

    gate.update({ ...good[0]!, candidateCount: 30, inlierCount: 17 });
    expect(gate.state).toBe("locked");
  });

  it("marks the first rejected frame weak and allows a brief recovery window", () => {
    const gate = lockedGate();
    gate.update(lowTexture[0]!);
    expect(gate.state).toBe("weak");
  });

  it("enters realign only after sustained critical frames", () => {
    const gate = lockedGate();
    for (let index = 0; index < 29; index++) gate.update({...outliers[0]!,timestampMs:1300+index*80});
    expect(gate.state).toBe("weak");
    gate.update({...outliers[0]!,timestampMs:1300+29*80});
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

  it("can recover automatically from realign after sustained valid evidence", () => {
    const gate = lockedGate();
    for (let index = 0; index < 30; index++) gate.update({...outliers[0]!,timestampMs:1300+index*80});
    expect(gate.state).toBe("realign");
    gate.update({...good[0]!,timestampMs:4000});
    expect(gate.state).toBe("realign");
    gate.update({...good[1]!,timestampMs:4100});
    gate.update({...good[2]!,timestampMs:4200});
    expect(gate.state).toBe("locked");
  });

  it("times out prolonged poor evidence even before any initial lock", () => {
    const gate = new TrackingQualityGate();
    gate.update({...outliers[0]!,timestampMs:0});
    gate.update({...outliers[0]!,timestampMs:3100});
    expect(gate.state).toBe("realign");
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
    expect(gate.state).toBe("weak");
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
