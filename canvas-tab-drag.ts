export const GOOGLE_DOC_TAB_DRAG_MIME = "application/x-google-ai-hub-tab";

export interface GoogleDocTabDragPayload {
  documentId: string;
  tabId: string;
  sourceNodeId: string;
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
