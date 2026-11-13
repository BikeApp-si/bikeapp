import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusTable } from "./parts";

const cell = (state: "doing" | "done") =>
  renderToStaticMarkup(createElement(StatusTable, { head: "Step", rows: [{ label: "Sheets", state }] }));

describe("status table", () => {
  it("turns the Doing icon so work in progress shows", () => {
    expect(cell("doing")).toMatch(/<svg[^>]*animate-spin/);
  });

  it("keeps Done still", () => {
    expect(cell("done")).not.toMatch(/animate-spin/);
  });
});
