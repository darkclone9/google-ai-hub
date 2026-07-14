import { describe, expect, it, vi } from "vitest";
import { GoogleDocTabSyncRegistry } from "./tab-sync";

describe("GoogleDocTabSyncRegistry", () => {
  it("notifies only cards for the changed document", async () => {
    const registry = new GoogleDocTabSyncRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register("doc-a", first);
    registry.register("doc-b", second);
    await registry.notify({ documentId: "doc-a", kind: "created", tabId: "tab-2" });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("unregisters closed cards", async () => {
    const registry = new GoogleDocTabSyncRegistry();
    const listener = vi.fn();
    const unregister = registry.register("doc-a", listener);
    unregister();
    await registry.notify({ documentId: "doc-a", kind: "updated" });
    expect(listener).not.toHaveBeenCalled();
    expect(registry.count("doc-a")).toBe(0);
  });
});
