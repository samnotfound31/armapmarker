import {describe,it,expect} from "vitest";
import {RenderPositionEstimator} from "./RenderPositionEstimator";
describe("bounded display position",()=>{
 it("retains lateral actual position and limits extrapolation without changing input",()=>{
  const p=new RenderPositionEstimator([10,1.4,0],0);const actual:[number,number,number]=[10,1.4,1];
  expect(p.update(actual,1000,5)).toBe(true);p.update([10,1.4,2],2000,5);
  expect(p.sample(10000)[0]).toBe(10);expect(p.sample(10000)[2]-p.sample(2000)[2]).toBeLessThanOrEqual(1);expect(actual).toEqual([10,1.4,1]);
 });
 it("large GPS correction re-registers directly instead of a long slide",()=>{
  const p=new RenderPositionEstimator([0,1.4,0],0);expect(p.update([8,1.4,0],1000,5)).toBe(false);expect(p.sample(1000)).toEqual([8,1.4,0]);
 });
 it("historical pose sampling follows the accepted image time",()=>{
  const p=new RenderPositionEstimator([0,1.4,0],0);p.update([0,1.44,1],1000);const old=p.sample(500);p.update([0,1.4,2],2000);expect(p.sample(500)).toEqual(old);
 });
});