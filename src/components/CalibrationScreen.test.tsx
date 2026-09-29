import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { buildCameraFromGroundAtLock } from "../geometry/groundCalibration";
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
