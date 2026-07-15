import { describe, expect, it } from "vitest";
import { chooseGoogleDocTabLiftPlan, chooseGoogleDocTabPlacement } from "./tab-placement";

describe("Google Doc tab placement", () => {
  it("creates a child beneath a source tab when another level is available", () => {
    const source = { id: "parent", parentTabId: "root", index: 0, nestingLevel: 1 };
    expect(chooseGoogleDocTabPlacement([
      source,
      { id: "child-1", parentTabId: "parent", index: 0, nestingLevel: 2 },
      { id: "child-2", parentTabId: "parent", index: 1, nestingLevel: 2 }
    ], source)).toEqual({
      parentTabId: "parent",
      index: 2,
      relationship: "child",
      limitedByDepth: false
    });
  });

  it("creates a sibling after a source already at the deepest nesting level", () => {
    const source = { id: "futurists", parentTabId: "archetypes", index: 0, nestingLevel: 2 };
    expect(chooseGoogleDocTabPlacement([source], source)).toEqual({
      parentTabId: "archetypes",
      index: 1,
      relationship: "sibling",
      limitedByDepth: true
    });
  });

  it("lifts the containing branch so a deepest-level source can accept a child", () => {
    const category = { id: "categories", parentTabId: "", index: 2, nestingLevel: 0 };
    const branch = { id: "archetypes", parentTabId: "categories", index: 0, nestingLevel: 1 };
    const source = { id: "futurists", parentTabId: "archetypes", index: 0, nestingLevel: 2 };
    expect(chooseGoogleDocTabLiftPlan([category, branch, source], source)).toEqual({
      branchTabId: "archetypes",
      originalParentTabId: "categories",
      originalIndex: 0,
      liftedParentTabId: "",
      liftedIndex: 3,
      childPlacement: {
        parentTabId: "futurists",
        index: 0,
        relationship: "child",
        limitedByDepth: false
      }
    });
  });

  it("does not propose a branch lift without a complete ancestor chain", () => {
    const source = { id: "futurists", parentTabId: "missing", index: 0, nestingLevel: 2 };
    expect(chooseGoogleDocTabLiftPlan([source], source)).toBeNull();
  });
});
