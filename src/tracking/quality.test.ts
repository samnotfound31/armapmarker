import { describe, expect, it } from "vitest";
import { TrackingQualityGate } from "./quality";
import type { TrackingObservation } from "./types";
const good = (timestampMs: number): TrackingObservation => ({timestampMs,candidateCount:60,inlierCount:50,medianReprojectionErrorPx:1,motionValid:true});
const bad = (timestampMs: number): TrackingObservation => ({...good(timestampMs),inlierCount:0,motionValid:false});
function lockedGate() { const gate=new TrackingQualityGate(); for(let t=0;t<=400;t+=100) gate.update(good(t)); return gate; }
describe("time-aware tracking confidence",()=>{
 it("requires five strong observations spanning at least 300 ms",()=>{const g=new TrackingQualityGate();for(let t=0;t<300;t+=50)g.update(good(t));expect(g.state).not.toBe("locked");g.update(good(350));expect(g.state).toBe("locked");});
 it("keeps a locked projection through one rejected frame",()=>{const g=lockedGate();g.update(bad(500));expect(g.state).toBe("locked");});
 it("detects silent workers using elapsed time",()=>{const g=lockedGate();expect(g.tick(651).state).toBe("weak");expect(g.tick(2201).state).toBe("realign");});
 it("recovers only through anchor-consistent sustained observations",()=>{const g=lockedGate();g.tick(2300);g.update(good(2400));expect(g.state).toBe("realign");g.update(good(2500));expect(g.state).toBe("recovering");for(let t=2600;t<=2800;t+=100)g.update(good(t));expect(g.state).toBe("locked");});
 it("stale and out-of-order results cannot advance recovery",()=>{const g=new TrackingQualityGate();g.update(good(100),400);for(let i=0;i<10;i++)g.update(good(100));expect(g.state).not.toBe("locked");});
 it("low-feature evidence cannot acquire a strong lock",()=>{const g=new TrackingQualityGate();for(let t=0;t<2000;t+=100)g.update({...good(t),candidateCount:10,inlierCount:10});expect(g.state).not.toBe("locked");});
});
