import { describe, expect, it } from "vitest";
import { ALLOWED } from "@/server/files/limits";
import { MESSAGE_FILES } from "./accept";

describe("files a message can carry (#8)", () => {
  it("takes a document pack's kinds: PDF, Word, Excel, CSV and zip", () => {
    expect(MESSAGE_FILES.split(",")).toEqual(expect.arrayContaining([".pdf", ".docx", ".xlsx", ".csv", ".zip"]));
  });

  it("takes a Markdown write-up (#10)", () => {
    expect(MESSAGE_FILES.split(",")).toContain(".md");
  });

  it("offers only kinds the server takes", () => {
    for (const ext of MESSAGE_FILES.split(",")) expect(ALLOWED[ext.slice(1)], ext).toBeDefined();
  });
});
