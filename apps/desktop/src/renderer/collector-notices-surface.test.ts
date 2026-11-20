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
  public constructor(public readonly tag: string) {}
  public append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  public replaceChildren(): void { this.children.length = 0; }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
}

function fakeDocument(): { doc: Document; body: FakeElement } {
  const body = new FakeElement("body");
  const doc = { body, createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
  return { doc, body };
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
    expect(card.children[1]!.textContent).toContain("自動更新は止まっています");
    const buttons = card.children[2]!.children;
    expect(buttons.map((button) => button.textContent)).toEqual(["解除をやり直す…", "確認・修復…", "閉じる"]);
    buttons[0]!.listeners.get("click")!();
    expect(clicked).toEqual(["maginalia.collector.removeIntegration"]);
    present([]);
    expect(region.hidden).toBe(true);
    expect(region.children).toHaveLength(0);
  });
});
