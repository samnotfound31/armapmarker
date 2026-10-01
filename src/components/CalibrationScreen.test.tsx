import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { buildCameraFromGroundAtLock, buildCameraFromGroundWithEarthFrame, GEOGRAPHIC_EARTH_FROM_GROUND } from "../geometry/groundCalibration";
import type { NavigationSessionAdapters, SensorPoseUpdate, FrameSample } from "../session/NavigationSession";
import { CameraFrameTimeline } from "../session/CameraFrameTimeline";
import { RenderPoseController } from "../pose/RenderPoseController";
import { IDENTITY_MAT3 } from "../test/geometryFixtures";
import { CalibrationScreen, type CalibrationFeed } from "./CalibrationScreen";

const feed: CalibrationFeed = {
  captureOrientation: async () => ({ samples: [], cameraFromGroundAtLock:
    buildCameraFromGroundAtLock({alphaRad: 0, betaRad: 1.2, gammaRad: 0}, 1.4) }),
  scanFeatures: vi.fn(async () => [])
};
const props = {
  feed, groundRoute: [
    {rightMeters:0,upMeters:0,forwardMeters:0,routeDistanceMeters:0},
    {rightMeters:0,upMeters:0,forwardMeters:30,routeDistanceMeters:30}],
  calibrationProgressMeters: 0, intrinsics: buildApproximateIntrinsics(720,1280),
  imageToScreen: IDENTITY_MAT3, onBack: vi.fn()
};
describe("CalibrationScreen demo flow", () => {
  it("updates the ghost from live displayed-frame pose and locks that same pose with manual trim",async()=>{
    let now=100;vi.spyOn(performance,"now").mockImplementation(()=>now);
    const camera=(yaw:number)=>buildCameraFromGroundWithEarthFrame({alphaRad:-yaw,betaRad:80*Math.PI/180,gammaRad:0},GEOGRAPHIC_EARTH_FROM_GROUND,[0,1.4,0]);
    const heading=(yaw:number)=>({headingRad:yaw,source:"webkit-compass" as const,usable:true,reason:"validated",timestampMs:now,accuracyDeg:5});
    let sensor:((update:SensorPoseUpdate)=>void)|undefined,frames:((frame:FrameSample)=>void)|undefined;
    const capture={samples:[],cameraFromGroundAtLock:camera(0),earthFromGroundAtLock:GEOGRAPHIC_EARTH_FROM_GROUND,absoluteHeading:heading(0)};
    const liveFeed={...feed,captureOrientation:vi.fn(async()=>capture),createPresentationAdapters:()=>({
      sensor:{subscribe:(listener:typeof sensor)=>{sensor=listener;return ()=>{sensor=undefined;};}},
      frames:{subscribe:(listener:typeof frames)=>{frames=listener;return ()=>{frames=undefined;};}}
    } as Pick<NavigationSessionAdapters,"sensor"|"frames"|"motion"|"bindVideo">)};
    const onLock=vi.fn();const {container}=render(<CalibrationScreen {...props} feed={liveFeed} routeBearingRad={0} screenPointToGround={()=>null} onLock={onLock}/>);
    expect(await screen.findByRole("button",{name:"Lock alignment"})).toBeDisabled();
    const timeline=new CameraFrameTimeline();
    const present=()=>frames?.({frame:null,timestampMs:now,sensorHomography:IDENTITY_MAT3,stamp:timeline.stamp({nowMs:now,width:720,height:1280,orientation:0})});
    act(()=>present());
    await waitFor(()=>expect(container.querySelector("polygon")).not.toBeNull());
    const first=container.querySelector("polygon")!.getAttribute("points");
    now=200;
    act(()=>{sensor?.({timestampMs:now,cameraFromGround:camera(.1),orientationQuaternion:[0,0,0,1],absoluteHeading:heading(.1)});present();});
    await waitFor(()=>expect(container.querySelector("polygon")!.getAttribute("points")).not.toBe(first));
    fireEvent.change(screen.getByRole("slider",{name:"Lateral alignment"}),{target:{value:"0.5"}});
    fireEvent.click(screen.getByRole("button",{name:"Lock alignment"}));
    await waitFor(()=>expect(onLock).toHaveBeenCalledOnce());
    const locked=onLock.mock.calls[0]![0];
    expect(locked.lockedAtMs).toBe(200);
    expect(locked.cameraFromGroundAtLock).not.toEqual(capture.cameraFromGroundAtLock);
    expect(locked.manualAlignment.lateralMeters).toBe(.5);
    expect(locked.geographicYawValidated).toBe(true);
    expect(new RenderPoseController(locked).sample(200).cameraFromGround).toEqual(locked.cameraFromGroundAtLock);
    expect(liveFeed.captureOrientation).toHaveBeenCalledOnce();
  });
  it("refreshes Lock when a legacy feed has no live presentation source",async()=>{
    const fresh=buildCameraFromGroundAtLock({alphaRad:0,betaRad:1.3,gammaRad:0},1.4);
    const captureOrientation=vi.fn().mockResolvedValueOnce(await feed.captureOrientation()).mockResolvedValue({samples:[],cameraFromGroundAtLock:fresh});
    const onLock=vi.fn();render(<CalibrationScreen {...props} feed={{...feed,captureOrientation}} screenPointToGround={()=>null} onLock={onLock}/>);
    fireEvent.click(await screen.findByRole("button",{name:"Lock alignment"}));
    await waitFor(()=>expect(onLock).toHaveBeenCalledOnce());
    expect(onLock.mock.calls[0]![0].cameraFromGroundAtLock).toEqual(fresh);
  });
  it("locks bounded ghost alignment without changing route geometry", async()=>{
    const onLock=vi.fn();const before=JSON.stringify(props.groundRoute);
    render(<CalibrationScreen {...props} screenPointToGround={()=>null} onLock={onLock}/>);
    const lateral=await screen.findByRole("slider",{name:"Lateral alignment"});
    fireEvent.change(lateral,{target:{value:"0.5"}});
    fireEvent.change(screen.getByRole("slider",{name:"Yaw alignment"}),{target:{value:"2"}});
    fireEvent.click(screen.getByRole("button",{name:"Lock alignment"}));
    await waitFor(()=>expect(onLock).toHaveBeenCalledWith(expect.objectContaining({manualAlignment:{lateralMeters:.5,yawRad:2*Math.PI/180}})));
    expect(JSON.stringify(props.groundRoute)).toBe(before);
  });
  it("shows a provisional route and starts with one tap, no height or feature-scan gate", async () => {
    const onLock = vi.fn();
    render(<CalibrationScreen {...props} screenPointToGround={() => [0,0,4]} onLock={onLock} />);
    expect(screen.queryByRole("group", {name:/height/i})).not.toBeInTheDocument();
    const road = await screen.findByRole("button", {name:/road calibration view/i});
    await waitFor(() => expect(road).not.toBeDisabled());
    expect(await screen.findByRole("img", {name:"Approximate ground route"})).toBeVisible();
    fireEvent.pointerDown(road, {clientX:200,clientY:400});
    await waitFor(() => expect(onLock).toHaveBeenCalledOnce());
    expect(onLock).toHaveBeenCalledWith(expect.objectContaining({stage:"locked", cameraHeightMeters:1.4}));
    expect(feed.scanFeatures).not.toHaveBeenCalled();
  });
  it("keeps the simple tap flow when a ray cannot meet the ground", async () => {
    const onLock=vi.fn();
    render(<CalibrationScreen {...props} screenPointToGround={() => null} onLock={onLock} />);
    const road=await screen.findByRole("button",{name:/road calibration view/i});
    await waitFor(() => expect(road).not.toBeDisabled());
    fireEvent.pointerDown(road,{clientX:200,clientY:400});
    expect(await screen.findByRole("alert")).toHaveTextContent(/aim lower/i);
    expect(onLock).not.toHaveBeenCalled();
  });
});
