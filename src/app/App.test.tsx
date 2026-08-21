import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("starts with the walking safety and destination search screen", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /walk with ar/i })).toBeVisible();
    expect(screen.getByText(/never use while driving/i)).toBeVisible();
    expect(screen.getByLabelText(/destination/i)).toBeEnabled();
  });
});
