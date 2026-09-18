const HEIGIT_API_ORIGIN = "https://api.heigit.org";

export const HEIGIT_ENDPOINTS = Object.freeze({
  autocomplete: `${HEIGIT_API_ORIGIN}/pelias/v1/autocomplete`,
  walkingDirections:
    `${HEIGIT_API_ORIGIN}/openrouteservice/v2/directions/foot-walking/geojson`
});

export function createHeiGitHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: apiKey
  };
}
