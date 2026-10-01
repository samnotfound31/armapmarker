import {describe,it,expect} from "vitest";
import {CameraFrameTimeline} from "./CameraFrameTimeline";
describe("camera frame provenance",()=>{
 it("uses source capture time and freezes identity before bitmap delay",()=>{const t=new CameraFrameTimeline();const a=t.stamp({nowMs:120,captureTime:100,expectedDisplayTime:130,width:480,height:640,orientation:0});t.stamp({nowMs:200,width:480,height:640,orientation:0});expect(a.imageTimeMs).toBe(100);expect(a.frameId).toBe(1);expect(Object.isFrozen(a)).toBe(true);});
 it("changes generation when dimensions or orientation change",()=>{const t=new CameraFrameTimeline();const a=t.stamp({nowMs:0,width:480,height:640,orientation:0});const b=t.stamp({nowMs:100,width:640,height:480,orientation:90});expect(b.cameraGeneration).toBeGreaterThan(a.cameraGeneration);});
 it("provides monotonic timestamps for callback fallback",()=>{const t=new CameraFrameTimeline();const a=t.stamp({nowMs:100,width:480,height:640,orientation:0});const b=t.stamp({nowMs:120,width:480,height:640,orientation:0});expect(b.imageTimeMs).toBeGreaterThan(a.imageTimeMs);expect(a.timestampSource).toBe("presentation");});
});
