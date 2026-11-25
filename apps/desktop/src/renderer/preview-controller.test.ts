import { openDocument, type DocumentState } from "@maginalia/writing-core";
import { describe, expect, it, vi } from "vitest";
import type { ResolveReferencesResult } from "../reference-ipc";
import { DEFAULT_EXPORT_PRESENTATION_SETTINGS } from "../export-presentation-settings";
import { PreviewController, type PreviewView, type PreviewWritingPort } from "./preview-controller";
import type { RendererPreferenceStore } from "./renderer-preferences";

class FakeWriting implements PreviewWritingPort {
  public document: (DocumentState & { readonly revision?: number }) | null;
  private readonly listeners = new Set<(document: DocumentState | null) => void>();
  public constructor(text: string | null) {
    this.document = text === null ? null : { ...openDocument({ documentId: "doc-1", displayName: "draft.md", text }), revision: 0 };
  }
  public getDocumentState(): DocumentState | null { return this.document; }
  public onDocumentChange(listener: (document: DocumentState | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public setText(text: string): void {
    if (this.document === null) return;
    this.document = { ...this.document, currentText: text, revision: (this.document.revision ?? 0) + 1 };
    for (const listener of this.listeners) listener(this.document);
  }
}

const preferences: RendererPreferenceStore = {
  load: () => ({
    version: 1,
    defaultWritingDirection: "horizontal",
    optimizeDroppedImages: true,
    exportPresentationSettings: DEFAULT_EXPORT_PRESENTATION_SETTINGS
  }),
  save: vi.fn()
};

function success(): ResolveReferencesResult {
  return { kind: "resolved", sources: [], resolved: [], unresolved: [] };
}

describe("PreviewController", () => {
  it("changes only presentation state, not the shared document text", () => {
    const writing = new FakeWriting("# 原稿");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({ writing, api: { resolveReferences: vi.fn(async () => success()) }, view, preferences });
    const before = writing.getDocumentState();
    controller.setMode("preview");
    controller.setDirection("vertical");
    expect(writing.getDocumentState()).toEqual(before);
    expect(controller.getDirection()).toBe("vertical");
  });

  it("keeps ordinary direction changes responsive when preference storage throws", () => {
    const writing = new FakeWriting("# draft");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const failingPreferences: RendererPreferenceStore = {
      ...preferences,
      save: () => { throw new Error("storage is unavailable"); }
    };
    const controller = new PreviewController({ writing, api: null, view, preferences: failingPreferences });

    expect(() => controller.setDirection("vertical")).not.toThrow();
    expect(controller.getDirection()).toBe("vertical");
    expect(vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0].direction).toBe("vertical");
  });

  it("requires persistence before Settings direction changes and retries unchanged values", () => {
    const writing = new FakeWriting("# draft");
    const view: PreviewView = { setPreviewState: vi.fn() };
    let failWrites = true;
    const save = vi.fn(() => !failWrites);
    const controlledPreferences: RendererPreferenceStore = { ...preferences, save };
    const controller = new PreviewController({ writing, api: null, view, preferences: controlledPreferences });

    const initialViewCalls = vi.mocked(view.setPreviewState).mock.calls.length;
    expect(() => controller.setDirection("vertical", true)).toThrow("could not be persisted");
    expect(save).toHaveBeenCalledOnce();
    expect(controller.getDirection()).toBe("horizontal");
    expect(vi.mocked(view.setPreviewState)).toHaveBeenCalledTimes(initialViewCalls);

    failWrites = false;
    controller.setDirection("vertical", true);
    expect(controller.getDirection()).toBe("vertical");
    expect(vi.mocked(view.setPreviewState)).toHaveBeenCalledTimes(initialViewCalls + 1);

    failWrites = true;
    expect(() => controller.setDirection("vertical", true)).toThrow("could not be persisted");
    expect(save).toHaveBeenCalledTimes(3);
    expect(controller.getDirection()).toBe("vertical");
    expect(vi.mocked(view.setPreviewState)).toHaveBeenCalledTimes(initialViewCalls + 1);
  });

  it("propagates heading edits through the existing document-change refresh path", () => {
    const writing = new FakeWriting("# 初稿");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({ writing, api: { resolveReferences: vi.fn(async () => success()) }, view, preferences });
    controller.setMode("preview");
    writing.setText("###### 改稿");
    const latest = vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0];
    expect(latest?.document?.currentText).toBe("###### 改稿");
    expect(writing.getDocumentState()?.savedText).toBe("# 初稿");
  });

  it("defers Preview replacement while an editable text island has focus, then refreshes on blur", () => {
    const writing = new FakeWriting("before");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({ writing, api: null, view, preferences });
    controller.setMode("preview");
    const before = vi.mocked(view.setPreviewState).mock.calls.length;
    controller.setInlineEditing("doc-1");
    writing.setText("during composition");
    expect(vi.mocked(view.setPreviewState).mock.calls).toHaveLength(before);
    controller.setInlineEditing(null);
    expect(vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0].document?.currentText).toBe("during composition");
  });

  it("allows an explicit revision-owned refresh after an Enter source edit", () => {
    const writing = new FakeWriting("before after");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({ writing, api: null, view, preferences });
    controller.setMode("preview");
    controller.setInlineEditing("doc-1");
    const beforeEdit = vi.mocked(view.setPreviewState).mock.calls.length;
    writing.setText("before\nafter");
    expect(vi.mocked(view.setPreviewState)).toHaveBeenCalledTimes(beforeEdit);
    expect(controller.refreshAfterInlineEdit("doc-1", 1)).toBe(true);
    expect(vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0].document?.currentText).toBe("before\nafter");
    expect(controller.isInlineEditing()).toBe(false);
    expect(controller.refreshAfterInlineEdit("doc-1", 0)).toBe(false);
  });

  it("does not let a delayed QuoteRef result replace a focused island and resolves again on blur", async () => {
    const marker = '<!-- maginalia:quote-ref v1 {"quoteId":"a","mode":"normal"} -->';
    const writing = new FakeWriting(marker);
    const view: PreviewView = { setPreviewState: vi.fn() };
    const pending: ((result: ResolveReferencesResult) => void)[] = [];
    const api = {
      resolveReferences: vi.fn(() => new Promise<ResolveReferencesResult>((resolve) => pending.push(resolve)))
    };
    const controller = new PreviewController({ writing, api, view, preferences });
    controller.setMode("preview");
    controller.setInlineEditing("doc-1");
    const whileFocused = vi.mocked(view.setPreviewState).mock.calls.length;
    const resolved = (quote: string): ResolveReferencesResult => ({
      kind: "resolved",
      sources: [],
      unresolved: [],
      resolved: [{
        occurrence: { offset: 0, marker, quoteRef: null },
        quoteRef: null,
        quotation: { quote, authors: [], title: "Title", pageLabel: "1" },
        source: {}
      }]
    } as unknown as ResolveReferencesResult);

    pending[0]?.(resolved("stale result"));
    await Promise.resolve();
    expect(vi.mocked(view.setPreviewState)).toHaveBeenCalledTimes(whileFocused);
    expect(controller.isInlineEditing()).toBe(true);

    controller.setInlineEditing(null);
    expect(api.resolveReferences).toHaveBeenCalledTimes(2);
    pending[1]?.(resolved("fresh result"));
    await Promise.resolve();
    expect(vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0].quoteMap.get(marker))
      .toMatchObject({ state: "resolved", text: "fresh result" });
  });

  it("leaves a failed Reviewer lookup as an unresolved preview item", async () => {
    const marker = '<!-- maginalia:quote-ref v1 {"quoteId":"a","mode":"normal"} -->';
    const writing = new FakeWriting(marker);
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({
      writing,
      api: {
        resolveReferences: vi.fn(async (): Promise<ResolveReferencesResult> => ({
          kind: "error",
          code: "reviewer-unavailable",
          message: "offline"
        }))
      },
      view,
      preferences
    });
    controller.setMode("preview");
    await Promise.resolve();
    const latest = vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0];
    expect(latest?.quoteMap.get(marker)).toMatchObject({ state: "unresolved" });
    expect(writing.getDocumentState()?.currentText).toBe(marker);
  });
});
