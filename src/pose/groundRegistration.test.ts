import {describe,it,expect} from "vitest";
import {buildApproximateIntrinsics} from "../geometry/intrinsics";
import {buildCameraFromGroundWithEarthFrame,GEOGRAPHIC_EARTH_FROM_GROUND} from "../geometry/groundCalibration";
import {invertHomography,multiplyHomographies} from "../tracking/residualHomography";
import {nominalGroundProjection,residualFromGroundMotion,transportCorrection,warp} from "./groundRegistration";
const I=[1,0,0,0,1,0,0,0,1] as const;
const k=buildApproximateIntrinsics(480,640);
function n(t:number,bob=0){return nominalGroundProjection(buildCameraFromGroundWithEarthFrame({alphaRad:0,betaRad:1,gammaRad:0},GEOGRAPHIC_EARTH_FROM_GROUND,[0,1.4+bob,t]),k);}
describe("full nominal ground-motion boundary",()=>{
 it("returns identity for modeled forward translation and body bob",()=>{const a=n(0),b=n(1,.04);const observed=multiplyHomographies(b,invertHomography(a));const c=residualFromGroundMotion(observed,I,a,b);c.forEach((v,i)=>expect(v).toBeCloseTo(I[i]!,7));});
 it("transports a correction without applying nominal translation twice",()=>{const a=n(0),b=n(1);const c=transportCorrection(I,a,b);c.forEach((v,i)=>expect(v).toBeCloseTo(I[i]!,7));});
 it("preserves a fixed ground registration across delayed poses",()=>{const a=n(0),b=n(2);const c=[1,0,0,0,1,0,2,-1,1] as const;const actual=transportCorrection(c,a,b);const left=multiplyHomographies(actual,b);const right=multiplyHomographies(b,multiplyHomographies(invertHomography(a),multiplyHomographies(c,a)));for(const [x,y] of [[0,3],[1,5]]){const p=warp(left,x!,y!),q=warp(right,x!,y!);expect(p[0]).toBeCloseTo(q[0],5);expect(p[1]).toBeCloseTo(q[1],5);}});
});
