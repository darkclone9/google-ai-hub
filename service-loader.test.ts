import { describe, expect, it } from "vitest";
import { buildNotebookLmLoaderScript } from "./service-loader";

describe("NotebookLM source loader", () => {
  it("embeds the complete source as safely escaped copied text", () => {
    const script = buildNotebookLmLoaderScript('A "quoted" title', "First line\nSecond line");

    expect(script).toContain(JSON.stringify('A "quoted" title'));
    expect(script).toContain(JSON.stringify('# A "quoted" title\n\nFirst line\nSecond line'));
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it("verifies the editor before clicking Insert", () => {
    const script = buildNotebookLmLoaderScript("Source", "Body");
    const readback = script.indexOf("const actual = normalized(readValue(editor))");
    const insert = script.indexOf("insertButton.click()");

    expect(readback).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(readback);
    expect(script).toContain('mode: "notebooklm-clipboard"');
  });

  it("does not report success until NotebookLM confirms submission", () => {
    const script = buildNotebookLmLoaderScript("Source", "Body");
    const insert = script.indexOf("insertButton.click()");
    const confirmation = script.indexOf("let submitted = false");
    const success = script.lastIndexOf("ok: true");

    expect(confirmation).toBeGreaterThan(insert);
    expect(success).toBeGreaterThan(confirmation);
    expect(script).toContain("!editor.isConnected");
    expect(script).toContain('ok: false,\n      mode: "notebooklm-dialog"');
  });
});
