import { describe,it,expect } from "vitest";
import { quat,mat4 } from "gl-matrix";
import { AttitudeEstimator } from "./AttitudeEstimator";
import {projectGroundPoint} from "../geometry/groundCalibration";
import {buildApproximateIntrinsics} from "../geometry/intrinsics";
import type { Mat4 } from "../domain/types";
const matrix=(angle:number)=>Array.from(mat4.fromQuat(mat4.create(),quat.setAxisAngle(quat.create(),[0,1,0],angle))) as unknown as Mat4;
const yaw=(m:Mat4)=>Math.atan2(m[8],m[0]);
describe("attitude prediction and observation",()=>{
 it.each([5,10,20])("keeps orientation correction bandwidth independent of %d ms gyro event ordering",gyroInterval=>{
  const gyroFirst=new AttitudeEstimator(matrix(0),0),orientationFirst=new AttitudeEstimator(matrix(0),0);
  const observation=.08;
  gyroFirst.updateRate([0,0,0],0);orientationFirst.updateRate([0,0,0],0);
  for(let time=5;time<=2000;time+=5){
   if(time%gyroInterval===0)gyroFirst.updateRate([0,0,0],time);
   if(time%20===0){gyroFirst.observe(matrix(observation),time);orientationFirst.observe(matrix(observation),time);}
   if(time%gyroInterval===0)orientationFirst.updateRate([0,0,0],time);
  }
  const expected=observation*(1-Math.exp(-1));
  expect(yaw(gyroFirst.sample(2000).cameraRotation)).toBeCloseTo(expected,4);
  expect(yaw(orientationFirst.sample(2000).cameraRotation)).toBeCloseTo(expected,4);
 });
 it("attenuates stationary yaw noise without accumulating bias",()=>{const e=new AttitudeEstimator(matrix(0),0);let observed=0,filtered=0,rawPixels=0,filteredPixels=0;const k=buildApproximateIntrinsics(480,640),project=(m:Mat4)=>{const p=projectGroundPoint([0,0,10],m,k);return p.visible?p.imagePixel.xPx-k.cxPx:0;};for(let t=10;t<=2000;t+=10){const a=.005*Math.sin(t*.05);e.observe(matrix(a),t);observed+=a*a;filtered+=yaw(e.sample(t).cameraRotation)**2;rawPixels+=project(matrix(a))**2;filteredPixels+=project(e.sample(t).cameraRotation)**2;}expect(filtered).toBeLessThan(observed*.5);expect(filteredPixels).toBeLessThan(rawPixels*.5);expect(Math.abs(yaw(e.sample(2000).cameraRotation))).toBeLessThan(.005);});
 it("follows genuine gyro-supported 90 degree turns without lag",()=>{const e=new AttitudeEstimator(matrix(0),0);const rate=Math.PI/2;e.updateRate([0,rate,0],0);for(let t=10;t<=1000;t+=10){e.updateRate([0,rate,0],t);e.observe(matrix(rate*t/1000),t);}expect(yaw(e.sample(1000).cameraRotation)).toBeCloseTo(Math.PI/2,2);});
 it("handles north wrap and sign-equivalent quaternions continuously",()=>{const e=new AttitudeEstimator(matrix(359*Math.PI/180),0);e.observe(matrix(Math.PI/180),100);expect(Math.abs(yaw(e.sample(100).cameraRotation))).toBeLessThan(.1);});
 it("quarantines an isolated compass jump when rates say stationary",()=>{const e=new AttitudeEstimator(matrix(0),0);e.updateRate([0,0,0],100);expect(e.observe(matrix(Math.PI/2),100)).toBe(false);expect(Math.abs(yaw(e.sample(100).cameraRotation))).toBeLessThan(.01);});
 it("rejects an unsupported single compass jump even without gyro",()=>{const e=new AttitudeEstimator(matrix(0),0);expect(e.observe(matrix(Math.PI/2),100)).toBe(false);expect(yaw(e.sample(100).cameraRotation)).toBeCloseTo(0);});
 it("interpolates historical attitude instead of using bitmap completion time",()=>{const e=new AttitudeEstimator(matrix(0),0);e.updateRate([0,1,0],100);e.observe(matrix(.1),100);e.updateRate([0,1,0],200);e.observe(matrix(.2),200);const a=yaw(e.sample(100).cameraRotation);e.observe(matrix(.3),300);expect(yaw(e.sample(100).cameraRotation)).toBe(a);});
 it("preserves handedness of geographic camera matrices",()=>{const reflected=matrix(.4).map((v,i)=>i>=8&&i<11?-v:v) as unknown as Mat4;const e=new AttitudeEstimator(reflected,0);expect(e.sample(0).cameraRotation).toEqual(reflected);});
 it.each([30,90])("passes a %d degree intentional fallback turn without excessive added lag",degrees=>{
  const e=new AttitudeEstimator(matrix(0),0),r=degrees*Math.PI/180;
  for(let t=10;t<=600;t+=10)e.observe(matrix(r*t/600),t);
  expect(Math.abs(yaw(e.sample(600).cameraRotation)-r)).toBeLessThan(.04);
 });
 it("follows oscillatory multi-axis wrist motion supported by angular rate",()=>{
  const e=new AttitudeEstimator(matrix(0),0);let maximum=0;
  const dt=.01;let q=quat.create();
  for(let t=0;t<=2000;t+=10){const rate:[number,number,number]=[.2*Math.cos(t*.009),.1*Math.sin(t*.006),.15*Math.cos(t*.009)];
   if(t){const speed=Math.hypot(...rate),delta=quat.setAxisAngle(quat.create(),rate.map(v=>v/speed),speed*dt);q=quat.multiply(q,delta,q);}
   e.updateRate(rate,t);e.observe(Array.from(mat4.fromQuat(mat4.create(),q)) as unknown as Mat4,t);
   maximum=Math.max(maximum,2*Math.acos(Math.min(1,Math.abs(quat.dot(e.sample(t).quaternion,q)))));
  }
  expect(maximum).toBeLessThan(.015);
 });

});
