import {
  importLibrary as importGoogleLibrary,
  setOptions as setGoogleOptions,
  type APIOptions
} from "@googlemaps/js-api-loader";

export type GoogleLibraries = {
  places: google.maps.PlacesLibrary;
  maps: google.maps.MapsLibrary;
};

type GoogleLoaderDependencies = {
  setOptions: (options: APIOptions) => void;
  importLibrary: (name: "places" | "maps") => Promise<unknown>;
};

export function createGoogleLibrariesLoader(
  dependencies: GoogleLoaderDependencies
): (apiKey: string) => Promise<GoogleLibraries> {
  let configuredKey: string | undefined;
  let loading: Promise<GoogleLibraries> | undefined;

  return async (apiKey: string) => {
    const key = apiKey.trim();
    if (!key) {
      throw new Error("A Google Maps browser key is required.");
    }
    if (configuredKey && configuredKey !== key) {
      throw new Error("Google Maps was already configured with another key.");
    }
    if (!loading) {
      configuredKey = key;
      dependencies.setOptions({ key, v: "weekly" });
      loading = Promise.all([
        dependencies.importLibrary("places"),
        dependencies.importLibrary("maps")
      ]).then(([places, maps]) => ({
        places: places as google.maps.PlacesLibrary,
        maps: maps as google.maps.MapsLibrary
      }));
    }
    return loading;
  };
}

const loadConfiguredGoogleLibraries = createGoogleLibrariesLoader({
  setOptions: setGoogleOptions,
  importLibrary: (name) => importGoogleLibrary(name)
});

export function loadGoogleLibraries(apiKey: string): Promise<GoogleLibraries> {
  return loadConfiguredGoogleLibraries(apiKey);
}
