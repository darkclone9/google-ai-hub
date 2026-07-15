export interface NoteMirrorRecord {
  id: string;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isPathInside(path: string, folder: string): boolean {
  const normalized = normalizedPath(path).toLocaleLowerCase();
  const root = normalizedPath(folder).toLocaleLowerCase();
  return Boolean(root) && (normalized === root || normalized.startsWith(`${root}/`));
}

export function shouldAutoPublishNewNote(
  path: string,
  extension: string,
  googleDocsFolder: string
): boolean {
  if (extension.toLocaleLowerCase() !== "md") return false;
  const normalized = normalizedPath(path);
  const managedSegment = normalized.split("/").some(segment =>
    segment.startsWith("_") || segment.startsWith(".")
  );
  if (!normalized || managedSegment) return false;
  return !isPathInside(normalized, googleDocsFolder);
}

export function migrateNoteMirrorPath<T extends NoteMirrorRecord>(
  mirrors: Record<string, T>,
  oldPath: string,
  newPath: string
): boolean {
  if (oldPath === newPath || !mirrors[oldPath]) return false;
  if (!mirrors[newPath]) mirrors[newPath] = mirrors[oldPath];
  delete mirrors[oldPath];
  return true;
}
