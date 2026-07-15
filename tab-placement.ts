export interface GoogleDocTabPlacementItem {
  id: string;
  parentTabId: string;
  index: number;
  nestingLevel: number;
}

export interface GoogleDocTabPlacement {
  parentTabId: string;
  index: number;
  relationship: "child" | "sibling";
  limitedByDepth: boolean;
}

export const MAX_GOOGLE_DOC_TAB_NESTING_LEVEL = 2;

export function chooseGoogleDocTabPlacement(
  tabs: readonly GoogleDocTabPlacementItem[],
  sourceTab: GoogleDocTabPlacementItem
): GoogleDocTabPlacement {
  if (sourceTab.nestingLevel < MAX_GOOGLE_DOC_TAB_NESTING_LEVEL) {
    return {
      parentTabId: sourceTab.id,
      index: tabs.filter(tab => tab.parentTabId === sourceTab.id).length,
      relationship: "child",
      limitedByDepth: false
    };
  }

  return {
    parentTabId: sourceTab.parentTabId,
    index: sourceTab.index + 1,
    relationship: "sibling",
    limitedByDepth: true
  };
}
