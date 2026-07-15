import { describe, expect, it, vi } from "vitest";
import {
  CanvasRepairAttemptRegistry,
  canvasPositionClientPoint,
  chooseCanvasConnectorCandidate,
  parseGoogleDocTabDrag,
  recreateCanvasNodeAsGoogleDocTabCard,
  repairMalformedGoogleDocTabCards,
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

  it("prefers the active connector source over a stale selected card", () => {
    expect(chooseCanvasConnectorCandidate([
      { value: "wrong-global-card", isConnectorSource: false, isSelected: true },
      { value: "actual-connector-card", isConnectorSource: true, isSelected: false }
    ])).toBe("actual-connector-card");
  });

  it("does not guess when several global cards are selected", () => {
    expect(chooseCanvasConnectorCandidate([
      { value: "first", isConnectorSource: false, isSelected: true },
      { value: "second", isConnectorSource: false, isSelected: true }
    ])).toBeNull();
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
    const unsyncedDraft = {
      id: "node-3",
      type: "text",
      text: "Classes:",
      file: "Google Docs/example.gdoc",
      subpath: "#google-ai-hub-tab=tab-3"
    };
    expect(repairMalformedGoogleDocTabNode(unsyncedDraft)).toBe(unsyncedDraft);
  });

  it("allows only one automatic repair attempt per loaded Canvas", () => {
    const registry = new CanvasRepairAttemptRegistry();
    const firstCanvas = {};
    const secondCanvas = {};
    expect(registry.claim(firstCanvas)).toBe(true);
    expect(registry.claim(firstCanvas)).toBe(false);
    expect(registry.claim(secondCanvas)).toBe(true);
  });

  it("recreates malformed nodes so Obsidian changes their runtime type", async () => {
    const setData = vi.fn();
    const data = {
      nodes: [{
        id: "broken",
        type: "text",
        text: "",
        file: "Google Docs/example.gdoc",
        subpath: "#google-ai-hub-tab=tab-2",
        width: 250,
        height: 60
      }, { id: "source", type: "file" }],
      edges: [{ id: "edge-1", fromNode: "source", toNode: "broken" }]
    };

    await expect(repairMalformedGoogleDocTabCards({ setData }, data)).resolves.toBe(1);
    expect(setData).toHaveBeenCalledTimes(2);
    expect(setData.mock.calls[0][0]).toEqual({
      nodes: [{ id: "source", type: "file" }],
      edges: []
    });
    expect(setData.mock.calls[1][0]).toEqual({
      nodes: [expect.objectContaining({ id: "broken", type: "file", width: 300, height: 260 }), { id: "source", type: "file" }],
      edges: [{ id: "edge-1", fromNode: "source", toNode: "broken" }]
    });
  });

  it("recreates a connector placeholder as a real file card and restores its edge", async () => {
    const setData = vi.fn();
    const data = {
      nodes: [
        { id: "source", type: "file", file: "Google Docs/source.gdoc" },
        { id: "placeholder", type: "text", text: "", x: 20, y: 30, width: 250, height: 60 }
      ],
      edges: [{ id: "edge-1", fromNode: "source", toNode: "placeholder" }]
    };

    await expect(recreateCanvasNodeAsGoogleDocTabCard(
      { setData },
      data,
      "placeholder",
      "Google Docs/source.gdoc",
      "#google-ai-hub-tab=child-1"
    )).resolves.toBe(true);
    expect(setData).toHaveBeenCalledTimes(2);
    expect(setData.mock.calls[0][0]).toEqual({
      nodes: [{ id: "source", type: "file", file: "Google Docs/source.gdoc" }],
      edges: []
    });
    expect(setData.mock.calls[1][0]).toEqual({
      nodes: [
        { id: "source", type: "file", file: "Google Docs/source.gdoc" },
        {
          id: "placeholder",
          type: "file",
          file: "Google Docs/source.gdoc",
          subpath: "#google-ai-hub-tab=child-1",
          x: 20,
          y: 30,
          width: 300,
          height: 260
        }
      ],
      edges: [{ id: "edge-1", fromNode: "source", toNode: "placeholder" }]
    });
  });
});
