import { describe, expect, it } from "vitest";
import { isSafeStaticRequest } from "./cachePolicy";

describe("service-worker cache policy", () => {
  it("allows only same-origin static GET requests and navigations", () => {
    expect(isSafeStaticRequest(request("/assets/app.js", "script"), APP_ORIGIN)).toBe(true);
    expect(isSafeStaticRequest(request("/navigate/museum", "", "navigate"), APP_ORIGIN)).toBe(true);
    expect(
      isSafeStaticRequest(request("/assets/app.js", "script", "cors", "POST"), APP_ORIGIN)
    ).toBe(false);
  });

  it("excludes route APIs, Google traffic, and data-like camera or location requests", () => {
    expect(isSafeStaticRequest(request("/api/routes", ""), APP_ORIGIN)).toBe(false);
    expect(
      isSafeStaticRequest(
        request("https://maps.googleapis.com/maps/api/js", "script"),
        APP_ORIGIN
      )
    ).toBe(false);
    expect(isSafeStaticRequest(request("/camera/frame.jpg", "image"), APP_ORIGIN)).toBe(false);
    expect(isSafeStaticRequest(request("/location/map.png", "image"), APP_ORIGIN)).toBe(false);
  });
});

const APP_ORIGIN = "https://app.example";

function request(
  path: string,
  destination: RequestDestination,
  mode: RequestMode = "cors",
  method = "GET"
): Request {
  const url = path.startsWith("http") ? path : `${APP_ORIGIN}${path}`;
  return { url, destination, mode, method } as Request;
}
