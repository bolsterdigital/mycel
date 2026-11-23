// Query results use the same block upgrades as revision reads. An invalid stored document
// stays local to its own row so it cannot interrupt a listing or a whole search rebuild.
import { ContentDocument, upgradeBlockVersions } from '@mycel/core';

export function readableDocument(stored: unknown): ContentDocument | null {
  try {
    return ContentDocument.parse(upgradeBlockVersions(stored));
  } catch {
    return null;
  }
}
