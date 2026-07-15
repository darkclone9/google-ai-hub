import { describe, expect, it } from "vitest";
import {
  canvasPositionClientPoint,
  parseGoogleDocTabDrag,
  repairMalformedGoogleDocTabNode,
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

  it("converts DOM client coordinates to the Canvas API's x/y shape", () => {
    expect(canvasPositionClientPoint({ clientX: 640, clientY: 480 })).toEqual({ x: 640, y: 480 });
  });

  it("repairs empty text nodes that were intended to be Google Doc tab cards", () => {
    expect(repairMalformedGoogleDocTabNode({
      id: "node-1",
      type: "text",
      text: "",
      file: "Google Docs/example.gdoc",
      subpath: "#google-ai-hub-tab=tab-2",
      x: 10,
      y: 20,
      width: 250,
      height: 60
    })).toEqual({
      id: "node-1",
      type: "file",
      file: "Google Docs/example.gdoc",
      subpath: "#google-ai-hub-tab=tab-2",
      x: 10,
      y: 20,
      width: 300,
      height: 260
    });
    const ordinary = { id: "node-2", type: "text", text: "Keep me" };
    expect(repairMalformedGoogleDocTabNode(ordinary)).toBe(ordinary);
  });
});
