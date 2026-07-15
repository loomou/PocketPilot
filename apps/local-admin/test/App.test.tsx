import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../src/App";

describe("App", () => {
  it("renders the local-only configuration scaffold", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Configuration page scaffold" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Agent unavailable" }),
    ).toBeDisabled();
  });
});
