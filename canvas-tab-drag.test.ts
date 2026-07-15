import { describe, expect, it } from "vitest";
import {
  parseGoogleDocTabDrag,
  serializeGoogleDocTabDrag
} from "./canvas-tab-drag";

describe("Canvas Google Doc tab drag payload", () => {
  it("round-trips the document, tab, and source card", () => {
    const payload = { documentId: "doc-1", tabId: "tab-2", sourceNodeId: "node-3" };
    expect(parseGoogleDocTabDrag(serializeGoogleDocTabDrag(payload))).toEqual(payload);
  });

  it("rejects malformed or incomplete Canvas drops", () => {
    expect(parseGoogleDocTabDrag("not-json")).toBeNull();
    expect(parseGoogleDocTabDrag(JSON.stringify({ documentId: "doc-1", tabId: "tab-2" }))).toBeNull();
    expect(parseGoogleDocTabDrag(JSON.stringify({ documentId: "", tabId: "tab-2", sourceNodeId: "node-3" }))).toBeNull();
  });
});
