import { describe, expect, it } from "vitest";
import { buildAlpha1MigrationNotice, buildRemoveFailedNotice, type CollectorNotice } from "../collector-integration-notices";
import { createCollectorNoticePresenter, startCollectorNotices } from "./collector-notices-surface";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startCollectorNotices", () => {
  it("asks for the notices exactly once and presents the answer", async () => {
    const notice = buildAlpha1MigrationNotice();
    let pulls = 0;
    const shown: Array<readonly CollectorNotice[]> = [];
    startCollectorNotices({
      api: { getCollectorNotices: async () => { pulls += 1; return [notice]; }, onCollectorNotices: () => () => {} },
      present: (notices) => { shown.push(notices); },
    });
    await flush();
    expect(pulls).toBe(1);
    expect(shown).toEqual([[notice]]);
  });

  it("follows pushed lists (for example the remove-failed notice) without pulling again", async () => {
    let pulls = 0;
    let push: (notices: readonly CollectorNotice[]) => void = () => {};
    const shown: Array<readonly CollectorNotice[]> = [];
    startCollectorNotices({
      api: { getCollectorNotices: async () => { pulls += 1; return []; }, onCollectorNotices: (callback) => { push = callback; return () => {}; } },
      present: (notices) => { shown.push(notices); },
    });
    await flush();
    push([buildRemoveFailedNotice()]);
    push([]);
    expect(pulls).toBe(1);
    expect(shown.map((list) => list.map((notice) => notice.kind))).toEqual([[], ["remove-failed"], []]);
  });

  it("a push that arrives before the pull answers wins over the older pulled list", async () => {
    let answer: (notices: readonly CollectorNotice[]) => void = () => {};
    let push: (notices: readonly CollectorNotice[]) => void = () => {};
    const shown: Array<readonly CollectorNotice[]> = [];
    startCollectorNotices({
      api: { getCollectorNotices: () => new Promise((resolve) => { answer = resolve; }), onCollectorNotices: (callback) => { push = callback; return () => {}; } },
      present: (notices) => { shown.push(notices); },
    });
    push([buildRemoveFailedNotice()]);
    answer([buildAlpha1MigrationNotice()]);
    await flush();
    expect(shown.map((list) => list.map((notice) => notice.kind))).toEqual([["remove-failed"]]);
  });

  it("does nothing, without throwing, when the preload has no notice API", async () => {
    const shown: unknown[] = [];
    expect(() => startCollectorNotices({ api: {}, present: (notices) => { shown.push(notices); } })).not.toThrow();
    await flush();
    expect(shown).toEqual([]);
  });

  it("a synchronous throw from getCollectorNotices is reported, not thrown", () => {
    const errors: unknown[] = [];
    expect(() => startCollectorNotices({
      api: { getCollectorNotices: () => { throw new Error("sync"); } },
      present: () => {},
      onError: (error) => { errors.push(error); },
    })).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("reports a failed pull and keeps running; stop() unsubscribes and drops later lists", async () => {
    const errors: unknown[] = [];
    let unsubscribed = 0;
    let push: (notices: readonly CollectorNotice[]) => void = () => {};
    const shown: unknown[] = [];
    const handle = startCollectorNotices({
      api: { getCollectorNotices: async () => { throw new Error("x"); }, onCollectorNotices: (callback) => { push = callback; return () => { unsubscribed += 1; }; } },
      present: (notices) => { shown.push(notices); },
      onError: (error) => { errors.push(error); },
    });
    await flush();
    expect(errors).toHaveLength(1);
    handle.stop();
    push([buildRemoveFailedNotice()]);
    expect(unsubscribed).toBe(1);
    expect(shown).toEqual([]);
  });
});

// A minimal element tree: the renderer tests have no DOM environment.
class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly dataset: Record<string, string> = {};
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, () => void>();
  public textContent = "";
  public hidden = false;
  public id = "";
  public className = "";
  public type = "";
  public constructor(public readonly tag: string, private readonly owner?: { activeElement: FakeElement | null }) {}
  public focus(): void { if (this.owner !== undefined) this.owner.activeElement = this; }
  public append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  public replaceChildren(): void { this.children.length = 0; }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
}

function fakeDocument(): { doc: Document; body: FakeElement; state: { activeElement: FakeElement | null } } {
  const state: { activeElement: FakeElement | null } = { activeElement: null };
  const body = new FakeElement("body", state);
  const doc = {
    body,
    get activeElement() { return state.activeElement; },
    createElement: (tag: string) => new FakeElement(tag, state),
  } as unknown as Document;
  return { doc, body, state };
}

describe("createCollectorNoticePresenter", () => {
  it("renders title, detail and one button per action; each button hands its action to the dispatcher", () => {
    const { doc, body } = fakeDocument();
    const clicked: string[] = [];
    const present = createCollectorNoticePresenter(doc, (action) => { clicked.push(action.commandId); });
    const region = body.children[0]!;
    expect(region.hidden).toBe(true);
    present([buildRemoveFailedNotice()]);
    expect(region.hidden).toBe(false);
    const card = region.children[0]!;
    expect(card.children[0]!.textContent).toBe("Collector 連携の解除に失敗しました");
    expect(card.children[1]!.textContent).toContain("自動更新は止まったまま");
    const buttons = card.children[2]!.children;
    expect(buttons.map((button) => button.textContent)).toEqual(["解除をやり直す…", "解除を取りやめる", "閉じる"]);
    expect(region.attributes.get("aria-live")).toBe("polite");
    expect(card.attributes.get("role")).toBe("alert");
    buttons[0]!.listeners.get("click")!();
    expect(clicked).toEqual(["maginalia.collector.removeIntegration"]);
    present([]);
    expect(region.hidden).toBe(true);
    expect(region.children).toHaveLength(0);
  });

  it("other notices are plain groups, not alerts", () => {
    const { doc, body } = fakeDocument();
    createCollectorNoticePresenter(doc, () => {})([buildAlpha1MigrationNotice()]);
    expect(body.children[0]!.children[0]!.attributes.get("role")).toBe("group");
  });

  it("keeps focus on the same button across a re-render, and moves it to the first remaining button or the body after a dismissal", () => {
    const { doc, body, state } = fakeDocument();
    const present = createCollectorNoticePresenter(doc, () => {});
    const region = body.children[0]!;
    present([buildRemoveFailedNotice(), buildAlpha1MigrationNotice()]);
    const secondRetry = region.children[1]!.children[1]!.children[0]!;
    secondRetry.focus();
    present([buildRemoveFailedNotice(), buildAlpha1MigrationNotice()]);
    const again = region.children[1]!.children[1]!.children[0]!;
    expect(again).not.toBe(secondRetry);
    expect(state.activeElement).toBe(again);
    // the focused notice goes away: focus moves to the first remaining button
    present([buildRemoveFailedNotice()]);
    expect(state.activeElement).toBe(region.children[0]!.children[2]!.children[0]);
    // nothing left: body (documented fallback)
    present([]);
    expect(state.activeElement).toBe(body);
    // focus elsewhere is left alone
    present([buildRemoveFailedNotice()]);
    state.activeElement = null;
    present([buildRemoveFailedNotice()]);
    expect(state.activeElement).toBeNull();
  });
});
