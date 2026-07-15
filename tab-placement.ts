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

export interface GoogleDocTabLiftPlan {
  branchTabId: string;
  originalParentTabId: string;
  originalIndex: number;
  liftedParentTabId: string;
  liftedIndex: number;
  childPlacement: GoogleDocTabPlacement;
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

export function chooseGoogleDocTabLiftPlan(
  tabs: readonly GoogleDocTabPlacementItem[],
  sourceTab: GoogleDocTabPlacementItem
): GoogleDocTabLiftPlan | null {
  if (sourceTab.nestingLevel < MAX_GOOGLE_DOC_TAB_NESTING_LEVEL) return null;
  const branch = tabs.find(tab => tab.id === sourceTab.parentTabId);
  if (!branch?.parentTabId) return null;
  const formerParent = tabs.find(tab => tab.id === branch.parentTabId);
  if (!formerParent) return null;

  return {
    branchTabId: branch.id,
    originalParentTabId: branch.parentTabId,
    originalIndex: branch.index,
    liftedParentTabId: formerParent.parentTabId,
    liftedIndex: formerParent.index + 1,
    childPlacement: {
      parentTabId: sourceTab.id,
      index: tabs.filter(tab => tab.parentTabId === sourceTab.id).length,
      relationship: "child",
      limitedByDepth: false
    }
  };
}
