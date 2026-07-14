export interface GoogleDocTabChange {
  documentId: string;
  kind: "created" | "updated" | "moved" | "deleted";
  tabId?: string;
}

export type GoogleDocTabRefresh = (change: GoogleDocTabChange) => void | Promise<void>;

export class GoogleDocTabSyncRegistry {
  private readonly listeners = new Map<string, Set<GoogleDocTabRefresh>>();

  register(documentId: string, listener: GoogleDocTabRefresh): () => void {
    const listeners = this.listeners.get(documentId) || new Set<GoogleDocTabRefresh>();
    listeners.add(listener);
    this.listeners.set(documentId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(documentId);
    };
  }

  async notify(change: GoogleDocTabChange): Promise<void> {
    const listeners = Array.from(this.listeners.get(change.documentId) || []);
    await Promise.allSettled(listeners.map(listener => Promise.resolve(listener(change))));
  }

  count(documentId: string): number {
    return this.listeners.get(documentId)?.size || 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
