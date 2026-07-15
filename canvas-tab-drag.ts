export const GOOGLE_DOC_TAB_DRAG_MIME = "application/x-google-ai-hub-tab";

export interface GoogleDocTabDragPayload {
  documentId: string;
  tabId: string;
  sourceNodeId: string;
}

export interface CanvasClientPoint {
  clientX: number;
  clientY: number;
}

export interface CanvasPosition {
  x: number;
  y: number;
}

export type CanvasDataNode = Record<string, unknown> & {
  id: string;
  type: string;
};

const GOOGLE_DOC_TAB_SUBPATH_PREFIX = "#google-ai-hub-tab=";

export function canvasPositionClientPoint(point: CanvasClientPoint): CanvasPosition {
  return { x: point.clientX, y: point.clientY };
}

export function repairMalformedGoogleDocTabNode(node: CanvasDataNode): CanvasDataNode {
  if (
    node.type !== "text"
    || typeof node.file !== "string"
    || typeof node.subpath !== "string"
    || !node.subpath.startsWith(GOOGLE_DOC_TAB_SUBPATH_PREFIX)
  ) return node;

  const repaired: CanvasDataNode = { ...node, type: "file" };
  delete repaired.text;
  delete repaired.url;
  return repaired;
}

export function serializeGoogleDocTabDrag(payload: GoogleDocTabDragPayload): string {
  return JSON.stringify(payload);
}

export function parseGoogleDocTabDrag(value: string): GoogleDocTabDragPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<GoogleDocTabDragPayload>;
    return typeof parsed.documentId === "string" && parsed.documentId
      && typeof parsed.tabId === "string" && parsed.tabId
      && typeof parsed.sourceNodeId === "string" && parsed.sourceNodeId
      ? {
        documentId: parsed.documentId,
        tabId: parsed.tabId,
        sourceNodeId: parsed.sourceNodeId
      }
      : null;
  } catch {
    return null;
  }
}
