import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "https://127.0.0.1:4173",
    ignoreHTTPSErrors: true,
    geolocation: { latitude: 22.57, longitude: 88.36 },
    permissions: ["geolocation"],
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "android-chromium",
      use: { ...devices["Pixel 7"], browserName: "chromium" }
    },
    {
      name: "iphone-webkit",
      use: { ...devices["iPhone 15"], browserName: "webkit" }
    }
  ],
  webServer: {
    command: "npm run preview:e2e",
    url: "https://127.0.0.1:4173",
    ignoreHTTPSErrors: true,
    reuseExistingServer: true,
    timeout: 120_000
  }
});
