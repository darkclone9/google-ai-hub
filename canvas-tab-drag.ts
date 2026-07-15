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

export type CanvasDataEdge = Record<string, unknown>;

export interface RepairableCanvasData {
  nodes: CanvasDataNode[];
  edges: CanvasDataEdge[];
}

export interface CanvasDataSetter {
  setData(data: RepairableCanvasData): void | Promise<void>;
}

const GOOGLE_DOC_TAB_SUBPATH_PREFIX = "#google-ai-hub-tab=";

export class CanvasRepairAttemptRegistry {
  private readonly attempted = new WeakSet<object>();

  claim(canvas: object): boolean {
    if (this.attempted.has(canvas)) return false;
    this.attempted.add(canvas);
    return true;
  }
}

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

  const repaired: CanvasDataNode = {
    ...node,
    type: "file",
    width: Math.max(300, typeof node.width === "number" ? node.width : 400),
    height: Math.max(260, typeof node.height === "number" ? node.height : 400)
  };
  delete repaired.text;
  delete repaired.url;
  return repaired;
}

export async function repairMalformedGoogleDocTabCards(
  canvas: CanvasDataSetter,
  data: RepairableCanvasData
): Promise<number> {
  const repairedIds = new Set<string>();
  const repairedNodes = data.nodes.map(node => {
    const repaired = repairMalformedGoogleDocTabNode(node);
    if (repaired !== node) repairedIds.add(node.id);
    return repaired;
  });
  if (!repairedIds.size) return 0;

  const intermediate: RepairableCanvasData = {
    ...data,
    nodes: data.nodes.filter(node => !repairedIds.has(node.id)),
    edges: data.edges.filter(edge =>
      !repairedIds.has(String(edge.fromNode || ""))
      && !repairedIds.has(String(edge.toNode || ""))
    )
  };
  await Promise.resolve(canvas.setData(intermediate));
  await Promise.resolve(canvas.setData({ ...data, nodes: repairedNodes }));
  return repairedIds.size;
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
