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

export interface CanvasConnectorCandidate<T> {
  value: T;
  isConnectorSource: boolean;
  isSelected: boolean;
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

export function chooseCanvasConnectorCandidate<T>(
  candidates: readonly CanvasConnectorCandidate<T>[]
): T | null {
  const connectorSources = candidates.filter(candidate => candidate.isConnectorSource);
  if (connectorSources.length === 1) return connectorSources[0].value;
  if (connectorSources.length > 1) {
    const selectedConnectorSources = connectorSources.filter(candidate => candidate.isSelected);
    return selectedConnectorSources.length === 1 ? selectedConnectorSources[0].value : null;
  }

  const selected = candidates.filter(candidate => candidate.isSelected);
  return selected.length === 1 ? selected[0].value : null;
}

export async function recreateCanvasNodeAsGoogleDocTabCard(
  canvas: CanvasDataSetter,
  data: RepairableCanvasData,
  nodeId: string,
  file: string,
  subpath: string
): Promise<boolean> {
  const sourceNode = data.nodes.find(node => node.id === nodeId);
  if (!sourceNode || !file || !subpath.startsWith(GOOGLE_DOC_TAB_SUBPATH_PREFIX)) return false;

  const replacement: CanvasDataNode = {
    ...sourceNode,
    type: "file",
    file,
    subpath,
    width: Math.max(300, typeof sourceNode.width === "number" ? sourceNode.width : 400),
    height: Math.max(260, typeof sourceNode.height === "number" ? sourceNode.height : 400)
  };
  delete replacement.text;
  delete replacement.url;

  const intermediate: RepairableCanvasData = {
    ...data,
    nodes: data.nodes.filter(node => node.id !== nodeId),
    edges: data.edges.filter(edge =>
      String(edge.fromNode || "") !== nodeId
      && String(edge.toNode || "") !== nodeId
    )
  };
  await Promise.resolve(canvas.setData(intermediate));
  await Promise.resolve(canvas.setData({
    ...data,
    nodes: data.nodes.map(node => node.id === nodeId ? replacement : node)
  }));
  return true;
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
