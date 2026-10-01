import {describe,it,expect} from "vitest";
import {RenderPoseController} from "./RenderPoseController";
import {buildApproximateIntrinsics} from "../geometry/intrinsics";
import type {GroundCalibration,Mat4} from "../domain/types";
import {transportCorrection,warp} from "./groundRegistration";
import {CameraFrameTimeline} from "../session/CameraFrameTimeline";
const I=[1,0,0,0,1,0,0,0,1] as const;
const M=[1,0,0,0,0,1,0,0,0,0,1,0,0,-1.4,0,1] as Mat4;
const calibration:GroundCalibration={stage:"locked",cameraHeightMeters:1.4,intrinsics:buildApproximateIntrinsics(480,640),imageToScreen:I,groundFromRoute:M.map((v,i)=>i===13?0:v) as unknown as Mat4,cameraFromGroundAtLock:M,calibrationRouteDistanceMeters:0,lockedAtMs:0};
function setup(){const c=new RenderPoseController(calibration);const timeline=new CameraFrameTimeline();const frame=(time:number)=>c.captureFrame(timeline.stamp({nowMs:time,width:480,height:640,orientation:0}));const initial=frame(0);c.acceptTracking({status:"initializing",timestampMs:0,context:initial,keyframeId:1,visualHomography:null,quality:{state:"weak",featureCount:60,inlierCount:0,inlierRatio:0,medianReprojectionErrorPx:0}},0);return {c,frame};}
function result(context:ReturnType<RenderPoseController["captureFrame"]>,referenceTimestampMs:number,translation=0){return {status:"tracked" as const,timestampMs:context.imageTimeMs,context,referenceTimestampMs,keyframeId:1,visualHomography:[1,0,0,0,1,0,translation,0,1] as typeof I,quality:{state:"locked" as const,featureCount:60,inlierCount:50,inlierRatio:.83,medianReprojectionErrorPx:1}};}
describe("RenderPose trusted registration",()=>{
 it("rejects one plausible 50-pixel visual outlier without moving registration",()=>{const {c,frame}=setup();frame(0);const f=frame(100);expect(c.acceptTracking(result(f,0,50),100)).toBe(false);expect(c.sample(100).visualCorrection.imageHomography).toEqual(I);});
 it("stale and mismatched camera generations cannot commit",()=>{const {c,frame}=setup();frame(0);const f=frame(100);expect(c.acceptTracking(result(f,0,2),400)).toBe(false);expect(c.acceptTracking({...result(f,0,2),context:{...f,cameraGeneration:999}},100)).toBe(false);});
 it("holds last accepted registration during visual silence and fades opacity only",()=>{const {c,frame}=setup();frame(0);for(let t=100;t<=500;t+=100){const f=frame(t);c.acceptTracking(result(f,0,2),t);}const a=c.sample(500);const b=c.sample(800);expect(b.visualCorrection.imageHomography).toEqual(a.visualCorrection.imageHomography);expect(b.quality.state).toBe("weak");expect(c.sample(1200).overlayOpacity).toBeLessThan(a.overlayOpacity);});
 it("manual registration is bounded and cannot mutate geographic inputs",()=>{const {c}=setup();const original=JSON.stringify(calibration);c.setManualAlignment({lateralMeters:.5,yawRad:.02});expect(JSON.stringify(calibration)).toBe(original);expect(()=>c.setManualAlignment({lateralMeters:5,yawRad:0})).toThrow();expect(c.sample(0).groundFromRoute).not.toEqual(calibration.groundFromRoute);});
 it("samples the camera-frame pose even after later sensor observations",()=>{const {c,frame}=setup();const captured=frame(100);const before=c.sampleDisplayFrame(100).cameraFromGround;c.updateSensor({timestampMs:200,cameraFromGround:[0,0,-1,0,0,1,0,0,1,0,0,0,0,-1.4,0,1],orientationQuaternion:[0,Math.SQRT1_2,0,Math.SQRT1_2]});expect(c.sampleDisplayFrame(200).cameraFromGround).toEqual(before);expect(captured.imageTimeMs).toBe(100);});
 it("geographic invalidity overrides visual lock",()=>{const {c,frame}=setup();frame(0);for(let t=100;t<=500;t+=100)c.acceptTracking(result(frame(t),0),t);c.setNavigation(20,"OFF_ROUTE");expect(c.sample(500).overlayOpacity).toBe(0);expect(c.sample(500).routeProgressMeters).toBe(20);});
 it("rejects mismatched retained-reference ownership without promoting",()=>{
  const {c,frame}=setup();const f=frame(100);
  expect(c.acceptTracking({...result(f,999,2),promoteCandidate:true},100)).toBe(false);
  expect(c.sample(100).visualCorrection.imageHomography).toEqual(I);
 });
 it("promotion preserves the accepted projection and manual prior",()=>{
  const {c,frame}=setup();c.setManualAlignment({lateralMeters:.4,yawRad:.01});
  const f=frame(900);expect(c.acceptTracking({...result(f,0,4),promoteCandidate:true},900)).toBe(true);
  const before=c.sample(900);const next=frame(1000);
  expect(c.acceptTracking({...result(next,900,0),keyframeId:2},1000)).toBe(true);
  expect(c.sample(1000).visualCorrection.imageHomography[6]).toBeCloseTo(before.visualCorrection.imageHomography[6]);
  expect(c.getManualAlignment()).toEqual({lateralMeters:.4,yawRad:.01});
 });
 it("one rejection preserves visible geometry; repeated rejection fades, then good frames recover",()=>{
  const {c,frame}=setup();for(let t=100;t<=500;t+=100)c.acceptTracking(result(frame(t),0,2),t);
  const good=c.sample(500);c.acceptTracking(result(frame(600),0,50),600);
  expect(c.sample(600).quality.state).toBe("locked");expect(c.sample(600).overlayOpacity).toBeGreaterThan(.5);
  c.acceptTracking(result(frame(800),0,50),800);expect(c.sample(800).quality.state).toBe("weak");
  expect(c.sample(2400).quality.state).toBe("realign");
  for(let t=2500;t<=2900;t+=100)c.acceptTracking(result(frame(t),0,2),t);
  expect(c.sample(2900).quality.state).toBe("locked");expect(c.sample(2900).visualCorrection.imageHomography).toEqual(good.visualCorrection.imageHomography);
 });
 it("unusable heading preserves internal attitude but geographic gate hides tracers",()=>{
  const {c}=setup();const before=c.sample(100).cameraFromGround;
  c.updateSensor({timestampMs:200,cameraFromGround:M,orientationQuaternion:[0,0,0,1],absoluteHeading:{headingRad:null,source:"unavailable",usable:false,reason:"lost",timestampMs:200}});
  c.setNavigation(0,"HEADING_UNCERTAIN");expect(c.sample(200).cameraFromGround).toEqual(before);expect(c.sample(200).overlayOpacity).toBe(0);
 });
 it("combined manual/visual registration budget suppresses guidance without erasing alignment",()=>{
  const {c}=setup();c.setManualAlignment({lateralMeters:1,yawRad:3*Math.PI/180});
  c.setNavigation(40,"VALID");expect(c.sample(100).overlayOpacity).toBe(0);
  expect(c.telemetry(100).registrationBudget).toBe("exceeded");expect(c.getManualAlignment().lateralMeters).toBe(1);
 });

 it("transports a late correction from its recorded GPS revision to the displayed image",()=>{
  const {c,frame}=setup();const old=frame(100);
  c.updateGps({timestampMs:120,cameraPositionGroundMeters:[0,1.4,.1],routeProgressMeters:.1});
  const displayed=frame(140);expect(c.acceptTracking(result(old,0,2),150)).toBe(true);
  const rendered=c.sampleDisplayFrame(150);const expected=transportCorrection([1,0,0,0,1,0,2,0,1],old.nominalPlane,displayed.nominalPlane);
  for(const [x,y] of [[100,400],[300,500]]){const p=warp(rendered.visualCorrection.imageHomography,x!,y!),q=warp(expected,x!,y!);expect(p[0]).toBeCloseTo(q[0],6);expect(p[1]).toBeCloseTo(q[1],6);}
  expect(rendered.nominalPoseRevision).toBe(displayed.nominalPoseRevision);
 });
 it("a format change creates a new projection and rejects old references",()=>{
  const {c,frame}=setup();const old=frame(100);const next=c.captureFrame({frameId:5,cameraGeneration:2,imageTimeMs:200,displayTimeMs:210,timestampSource:"presentation",width:640,height:480,orientation:90});
  expect(c.acceptTracking(result(old,0,2),220)).toBe(false);expect(next.cameraGeneration).toBe(2);expect(c.sampleDisplayFrame(220).renderIntrinsics?.imageWidthPx).toBe(640);
 });

});
