import { describe, expect, it } from "vitest";
import { migrateNoteMirrorPath, shouldAutoPublishNewNote } from "./auto-publish";

describe("automatic Google Doc publishing", () => {
  it("publishes ordinary new Markdown notes", () => {
    expect(shouldAutoPublishNewNote("Projects/New idea.md", "md", "Google Docs")).toBe(true);
    expect(shouldAutoPublishNewNote("New note.md", "MD", "Google Docs")).toBe(true);
  });

  it("excludes generated, hidden, memory, and non-Markdown files", () => {
    expect(shouldAutoPublishNewNote("Google Docs/Generated.gdoc", "gdoc", "Google Docs")).toBe(false);
    expect(shouldAutoPublishNewNote("Google Docs/Draft.md", "md", "Google Docs")).toBe(false);
    expect(shouldAutoPublishNewNote("_Codex Memory/projects/context.md", "md", "Google Docs")).toBe(false);
    expect(shouldAutoPublishNewNote("Projects/_generated/context.md", "md", "Google Docs")).toBe(false);
    expect(shouldAutoPublishNewNote(".trash/Deleted.md", "md", "Google Docs")).toBe(false);
    expect(shouldAutoPublishNewNote("Board.canvas", "canvas", "Google Docs")).toBe(false);
  });

  it("moves an existing mirror mapping when a note is renamed", () => {
    const mirrors = { "Untitled.md": { id: "doc-1" } };
    expect(migrateNoteMirrorPath(mirrors, "Untitled.md", "Projects/Named note.md")).toBe(true);
    expect(mirrors).toEqual({ "Projects/Named note.md": { id: "doc-1" } });
    expect(migrateNoteMirrorPath(mirrors, "Missing.md", "Other.md")).toBe(false);
  });
});
