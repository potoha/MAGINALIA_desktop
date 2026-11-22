import { afterEach, describe, expect, it, vi } from "vitest";
import { WIZARD_INFLIGHT_CANCEL_MS, type WizardUserEvent } from "./collector-wizard-model";
import { createWizardPanel, type WizardPanel } from "./collector-wizard-panel";
import { buildWizardView } from "./collector-wizard-view";
import type { CollectorIntegrationResponse } from "../collector-integration-ipc";
import { isCollectorWizardOpen, openCollectorWizard } from "./collector-wizard-controller";
import { T0, applyResponse, atStepA, atStepB, atStepC, atStepD, atStepE, entry, respond, send, start, statusResponse } from "./collector-wizard-test-support";

// A hand-made document stub (the node test environment has no DOM). It only implements what the
// adapter uses. Real rendering, layout and focus rings are NOT VERIFIED here (checked by hand in B5).

class FakeNode {
  public parent: FakeElement | null = null;
}
class FakeText extends FakeNode {
  public constructor(public text: string) {
    super();
  }
}

interface Listener {
  readonly handler: (event: FakeEvent) => void;
  readonly capture: boolean;
}

interface FakeEvent {
  type: string;
  key?: string;
  shiftKey?: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function makeEvent(type: string, init: { key?: string; shiftKey?: boolean; cancelable?: boolean } = {}): FakeEvent {
  const event: FakeEvent = {
    type,
    cancelable: true,
    ...init,
    defaultPrevented: false,
    preventDefault() {
      if (event.cancelable) event.defaultPrevented = true;
    },
  };
  return event;
}

class FakeElement extends FakeNode {
  public id = "";
  public className = "";
  public hidden = false;
  public disabled = false;
  public type = "";
  public value = "";
  public open = false;
  public children: (FakeElement | FakeText)[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly dataset: Record<string, string> = {};
  public readonly listeners = new Map<string, Listener[]>();
  public replaceCount = 0;
  public showModalCount = 0;
  public focusCount = 0;
  private text = "";

  public constructor(public readonly tagName: string, private readonly doc: FakeDocument) {
    super();
  }

  public get textContent(): string {
    if (this.children.length === 0) return this.text;
    return this.children.map((child) => (child instanceof FakeText ? child.text : child.textContent)).join("");
  }
  public set textContent(value: string) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = value;
  }
  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  public append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.parent?.detach(child);
      child.parent = this;
      this.children.push(child);
    }
  }
  public replaceChildren(...nodes: (FakeElement | FakeText | string)[]): void {
    this.replaceCount += 1;
    for (const child of this.children) {
      child.parent = null;
      this.doc.releaseFocusIn(child);
    }
    this.children = [];
    this.text = "";
    this.append(...nodes);
  }
  public detach(child: FakeElement | FakeText): void {
    this.children = this.children.filter((candidate) => candidate !== child);
    this.doc.releaseFocusIn(child);
  }
  public get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node !== null) {
      if (node === this.doc.body) return true;
      node = node.parent;
    }
    return false;
  }
  public blur(): void {
    if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body;
  }
  public remove(): void {
    this.parent?.detach(this);
    this.parent = null;
  }
  public addEventListener(type: string, handler: (event: FakeEvent) => void, capture?: boolean | AddEventListenerOptions): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ handler, capture: capture === true });
    this.listeners.set(type, list);
  }
  public removeEventListener(type: string, handler: (event: FakeEvent) => void, capture?: boolean | EventListenerOptions): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((entry) => !(entry.handler === handler && entry.capture === (capture === true))));
  }
  public listenerCount(): number {
    let total = 0;
    for (const list of this.listeners.values()) total += list.length;
    return total;
  }
  public dispatch(event: FakeEvent): FakeEvent {
    for (const entry of this.listeners.get(event.type) ?? []) entry.handler(event);
    return event;
  }
  public focus(_options?: { preventScroll?: boolean }): void {
    this.focusCount += 1;
    this.doc.activeElement = this;
  }
  /** Chromium: a native close (a second Esc that cannot be cancelled) fires `close`. */
  public nativeClose(): void {
    this.open = false;
    this.dispatch(makeEvent("close", { cancelable: false }));
  }
  public select(): void {
    // no-op
  }
  public showModal(): void {
    if (this.open || !this.isConnected) throw new Error("InvalidStateError");
    this.open = true;
    this.showModalCount += 1;
  }
  public close(): void {
    this.open = false;
  }
  public descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        out.push(child, ...child.descendants());
      }
    }
    return out;
  }
  public find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    return this.descendants().find(predicate);
  }
  public findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
    return this.descendants().filter(predicate);
  }
}

class FakeDocument {
  public readonly body = new FakeElement("body", this);
  public activeElement: FakeElement | null = this.body;
  public execCalls: string[] = [];
  public readonly byId = new Map<string, FakeElement>();
  public getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }
  /** A real DOM drops focus to <body> when the focused element (or an ancestor) leaves the document. */
  public releaseFocusIn(node: FakeElement | FakeText): void {
    const active = this.activeElement;
    if (active === null || !(node instanceof FakeElement)) return;
    if (active === node || node.descendants().includes(active)) this.activeElement = this.body;
  }
  public execResult = true;
  public createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  public execCommand(name: string): boolean {
    this.execCalls.push(name);
    return this.execResult;
  }
}

interface Rig {
  readonly doc: FakeDocument;
  readonly events: WizardUserEvent[];
  readonly panel: WizardPanel;
  readonly dialog: FakeElement;
}

function makePanel(): Rig {
  const doc = new FakeDocument();
  const outside = doc.createElement("button");
  doc.body.append(outside);
  outside.focus();
  const events: WizardUserEvent[] = [];
  const panel = createWizardPanel({ document: doc as unknown as Document, onEvent: (event) => events.push(event) });
  panel.show();
  const dialog = doc.body.children.find((child): child is FakeElement => child instanceof FakeElement && child.tagName === "dialog")!;
  return { doc, events, panel, dialog };
}

const byId = (rig: Rig, id: string) => rig.dialog.find((element) => element.id === id)!;
const buttonOf = (rig: Rig, action: string) => rig.dialog.find((element) => element.tagName === "button" && element.dataset.action === action)!;
const radios = (rig: Rig) => rig.dialog.findAll((element) => element.attributes.get("role") === "radio");

let rigs: Rig[] = [];
function setup(): Rig {
  const rig = makePanel();
  rigs.push(rig);
  return rig;
}
afterEach(() => {
  for (const rig of rigs) rig.panel.dispose();
  rigs = [];
  vi.unstubAllGlobals();
});

describe("wizard panel: dialog structure and live regions", () => {
  it("is a modal dialog labelled by a tabindex=-1 heading, with persistent status and alert regions", () => {
    const rig = setup();
    expect(rig.dialog.open).toBe(true);
    expect(rig.dialog.getAttribute("aria-labelledby")).toBe("collector-wizard-title");
    const heading = byId(rig, "collector-wizard-title");
    expect(heading.tagName).toBe("h2");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    const status = byId(rig, "collector-wizard-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    const alert = byId(rig, "collector-wizard-alert");
    expect(alert.getAttribute("role")).toBe("alert");
  });

  it("renders the heading, progress (as text) and describes the dialog by the progress", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    expect(byId(rig, "collector-wizard-title").textContent).toBe("ブラウザーで集めた引用を本棚へ（MAGINALIA Collector）");
    expect(byId(rig, "collector-wizard-progress").textContent).toBe("手順 1 / 5");
    expect(rig.dialog.getAttribute("aria-describedby")).toBe("collector-wizard-progress");
    expect(rig.dialog.getAttribute("aria-busy")).toBeNull();
    expect(rig.dialog.find((element) => element.className === "collector-wizard-body")?.getAttribute("aria-busy")).toBe("false");
  });

  it("puts a failure in the alert region and a success in the status region", () => {
    const rig = setup();
    const h = atStepD();
    send(h, { type: "copyAddress" });
    send(h, { type: "clipboardResult", purpose: "address", ok: false });
    rig.panel.render(buildWizardView(h.state));
    expect(byId(rig, "collector-wizard-alert").textContent.length).toBeGreaterThan(0);
    expect(byId(rig, "collector-wizard-status").textContent).toBe("");
    send(h, { type: "copyAddress" });
    send(h, { type: "clipboardResult", purpose: "address", ok: true });
    rig.panel.render(buildWizardView(h.state));
    expect(byId(rig, "collector-wizard-alert").textContent).toBe("");
    expect(byId(rig, "collector-wizard-status").textContent.length).toBeGreaterThan(0);
  });

  it("does not touch a live region or the content when a render changes nothing (polling never re-announces)", () => {
    const rig = setup();
    const h = atStepE();
    const view = buildWizardView(h.state);
    rig.panel.render(view);
    const status = byId(rig, "collector-wizard-status");
    const body = rig.dialog.find((element) => element.className === "collector-wizard-body")!;
    const before = [status.replaceCount, body.replaceCount];
    rig.panel.render(buildWizardView(h.state));
    rig.panel.render(buildWizardView(h.state));
    expect([status.replaceCount, body.replaceCount]).toEqual(before);
  });
});

describe("wizard panel: radiogroup", () => {
  it("uses role=radiogroup with labelled radios, aria-checked and a roving tabindex", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    const group = rig.dialog.find((element) => element.attributes.get("role") === "radiogroup")!;
    expect(group.getAttribute("aria-label")).toBe("Collector を使うブラウザー");
    const list = radios(rig);
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter((radio) => radio.getAttribute("tabindex") === "0")).toHaveLength(1);
    const chrome = list.find((radio) => radio.dataset.browser === "chrome")!;
    expect(chrome.getAttribute("aria-checked")).toBe("true");
    expect(chrome.getAttribute("tabindex")).toBe("0");
    const labelId = chrome.getAttribute("aria-labelledby")!;
    expect(byId(rig, labelId).textContent).toBe("Chrome で登録（おすすめ）");
  });

  it("with a Vivaldi default the radios read 通常のブラウザーで登録（Vivaldi）, Chrome, Edge, and only the recommended one is checked and tabbable", () => {
    const rig = setup();
    const verified = { verification: "verified" } as const;
    const h = atStepA({ browsers: { defaultBrowser: "vivaldi", recommended: "vivaldi", recommendationReason: "default-supported", entries: [entry("edge", verified), entry("chrome", verified), entry("vivaldi", verified)] } });
    rig.panel.render(buildWizardView(h.state));
    const list = radios(rig);
    expect(list.map((radio) => radio.dataset.browser)).toEqual(["vivaldi", "chrome", "edge"]);
    expect(list.map((radio) => byId(rig, radio.getAttribute("aria-labelledby")!).textContent)).toEqual(["通常のブラウザーで登録（Vivaldi）（おすすめ）", "Chrome で登録", "Edge で登録"]);
    expect(list.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(list.map((radio) => radio.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("a policy-blocked option is aria-disabled and not tabbable; its note is the description", () => {
    const rig = setup();
    const h = atStepA({ browsers: { entries: [entry("chrome", { policyBlocked: true }), entry("edge")], recommended: null, recommendationReason: "none-installed" } });
    rig.panel.render(buildWizardView(h.state));
    const blocked = radios(rig).find((radio) => radio.dataset.browser === "chrome");
    if (blocked !== undefined) {
      expect(blocked.getAttribute("aria-disabled")).toBe("true");
      expect(blocked.getAttribute("tabindex")).toBe("-1");
      expect(byId(rig, blocked.getAttribute("aria-describedby")!).textContent).toBe("組織の管理設定により使えません");
      blocked.dispatch(makeEvent("click"));
      expect(rig.events).toEqual([]);
    }
  });

  it("arrow keys, Home and End dispatch radioKey; Space and Enter and a click select", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    const chrome = radios(rig).find((radio) => radio.dataset.browser === "chrome")!;
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      const event = chrome.dispatch(makeEvent("keydown", { key }));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(rig.events).toEqual([
      { type: "radioKey", key: "ArrowDown" },
      { type: "radioKey", key: "ArrowUp" },
      { type: "radioKey", key: "ArrowLeft" },
      { type: "radioKey", key: "ArrowRight" },
      { type: "radioKey", key: "Home" },
      { type: "radioKey", key: "End" },
    ]);
    rig.events.length = 0;
    chrome.dispatch(makeEvent("keydown", { key: " " }));
    chrome.dispatch(makeEvent("keydown", { key: "Enter" }));
    chrome.dispatch(makeEvent("click"));
    expect(rig.events).toEqual(Array(3).fill({ type: "selectBrowser", browser: "chrome" }));
    const other = chrome.dispatch(makeEvent("keydown", { key: "a" }));
    expect(other.defaultPrevented).toBe(false);
  });

  it("focusRadio focuses the radio of that browser", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    rig.panel.focusRadio("chrome");
    expect(rig.doc.activeElement).toBe(radios(rig).find((radio) => radio.dataset.browser === "chrome"));
  });
});

describe("wizard panel: buttons", () => {
  it("every action is a real <button type=button> with its label; a click dispatches the model event", () => {
    const rig = setup();
    const h = atStepA();
    const view = buildWizardView(h.state);
    rig.panel.render(view);
    const buttons = rig.dialog.findAll((element) => element.tagName === "button");
    expect(buttons.map((button) => button.textContent)).toEqual(expect.arrayContaining(view.buttons.map((button) => button.label)));
    expect(buttons.every((button) => button.type === "button")).toBe(true);
    buttonOf(rig, "next").dispatch(makeEvent("click"));
    expect(rig.events).toEqual([{ type: "next" }]);
  });

  it("a busy button is aria-disabled (still focusable), ignores clicks, and points at the busy status", () => {
    const rig = setup();
    const h = start();
    send(h, { type: "opened" });
    rig.panel.render(buildWizardView(h.state));
    const recheck = buttonOf(rig, "recheckBrowsers");
    expect(recheck.disabled).toBe(false);
    expect(recheck.getAttribute("aria-disabled")).toBe("true");
    expect(recheck.getAttribute("aria-describedby")).toBe("collector-wizard-status");
    recheck.dispatch(makeEvent("click"));
    expect(rig.events).toEqual([]);
    expect(rig.dialog.getAttribute("aria-busy")).toBeNull();
    expect(rig.dialog.find((element) => element.className === "collector-wizard-body")?.getAttribute("aria-busy")).toBe("true");
    expect(byId(rig, "collector-wizard-status").textContent).toContain("確認しています");
  });

  it("a disabled 次へ with no selection points at the visible reason text", () => {
    const rig = setup();
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "default-unsupported", entries: [entry("chrome")] } });
    rig.panel.render(buildWizardView(h.state));
    const next = buttonOf(rig, "next");
    expect(next.disabled).toBe(true);
    expect(byId(rig, next.getAttribute("aria-describedby")!).textContent).toBe("ブラウザーを選ぶと、次へ進めます。");
  });

  it("step D: copy-address sits inside the first instruction, the other tools in the action area", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepD().state));
    const copy = buttonOf(rig, "copyAddress");
    expect(copy.parent?.tagName).toBe("li");
    expect(buttonOf(rig, "copyPath").parent?.className).toBe("collector-wizard-actions-nav");
    expect(buttonOf(rig, "loaded").parent?.className).toBe("collector-wizard-actions-nav");
    copy.dispatch(makeEvent("click"));
    expect(rig.events).toEqual([{ type: "copyAddress" }]);
  });

  it("step D: Tab order (DOM order) is 戻る, あとで, the tools, then the primary 読み込みました", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepD().state));
    const nav = rig.dialog.findAll((element) => element.tagName === "button" && element.parent?.className === "collector-wizard-actions-nav").map((button) => button.dataset.action);
    expect(nav.slice(0, 2)).toEqual(["back", "later"]);
    expect(nav[nav.length - 1]).toBe("loaded");
  });

  it("the disclosure summary is focusable and the checklist renders as a list", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepE().state));
    expect(rig.dialog.find((element) => element.tagName === "details")).toBeDefined();
    const h = atStepE();
    send(h, { type: "tick" }, 1_000_000 + 10_000 + 180_000);
    rig.panel.render(buildWizardView(h.state));
    expect(rig.dialog.findAll((element) => element.tagName === "li").length).toBeGreaterThan(0);
  });
});

describe("wizard panel: failure screens and the in-flight watchdog", () => {
  const actionIds = (rig: Rig) => rig.dialog.findAll((element) => element.tagName === "button").map((button) => button.dataset.action);

  function destinationError(kind: "error" | "busy") {
    const h = atStepC();
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind } as never });
    return h;
  }

  it("destination-error and destination-busy render exactly three buttons, each dispatching its event; no 閉じる or 次へ", () => {
    for (const kind of ["error", "busy"] as const) {
      const rig = setup();
      rig.panel.render(buildWizardView(destinationError(kind).state));
      expect(actionIds(rig)).toEqual(["chooseDestinationAgain", "cancelSetup", "confirmDestination"]);
      expect(buttonOf(rig, "confirmDestination").textContent).toBe("もう一度試す");
      expect(buttonOf(rig, "chooseDestinationAgain").textContent).toBe("保存先を選び直す");
      expect(buttonOf(rig, "cancelSetup").textContent).toBe("Collector のセットアップをキャンセル");
      for (const id of ["chooseDestinationAgain", "cancelSetup", "confirmDestination"]) buttonOf(rig, id).dispatch(makeEvent("click"));
      expect(rig.events).toEqual([{ type: "chooseDestinationAgain" }, { type: "later" }, { type: "confirmDestination" }]);
      expect(rig.dialog.find((element) => element.tagName === "button" && ["閉じる", "次へ"].includes(element.textContent))).toBeUndefined();
    }
  });

  it("Esc on the destination-error screen goes to the model as `escape` (which the model treats like cancelSetup)", () => {
    const rig = setup();
    const h = destinationError("error");
    rig.panel.render(buildWizardView(h.state));
    rig.dialog.dispatch(makeEvent("keydown", { key: "Escape" }));
    expect(rig.events).toEqual([{ type: "escape" }]);
    expect(send(h, { type: "escape" }).some((effect) => effect.type === "close")).toBe(true);
    expect(h.state.closed).toBe("later");
  });

  it("the slow-response alert is announced once, the cancel button is a focusable enabled button, and later ticks re-render nothing", () => {
    const rig = setup();
    const h = atStepB();
    send(h, { type: "register" });
    rig.panel.render(buildWizardView(h.state));
    const alert = byId(rig, "collector-wizard-alert");
    expect(alert.textContent).toBe("");
    expect(actionIds(rig)).not.toContain("cancelInFlight");
    buttonOf(rig, "register").focus();
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS);
    rig.panel.render(buildWizardView(h.state));
    expect(alert.textContent).toContain("応答に時間がかかっています");
    const cancel = buttonOf(rig, "cancelInFlight");
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBeNull();
    expect(rig.doc.activeElement).toBe(buttonOf(rig, "register"));
    const tabStops = rig.dialog.findAll((element) => element.tagName === "button" && !element.disabled);
    expect(tabStops).toContain(cancel);
    const announced = alert.replaceCount;
    const body = rig.dialog.find((element) => element.className === "collector-wizard-body")!;
    const bodyBefore = body.replaceCount;
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS + 1_000);
    rig.panel.render(buildWizardView(h.state));
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS + 2_000);
    rig.panel.render(buildWizardView(h.state));
    expect(alert.replaceCount).toBe(announced);
    expect(body.replaceCount).toBe(bodyBefore);
    cancel.dispatch(makeEvent("click"));
    expect(rig.events).toEqual([{ type: "cancelInFlight" }]);
  });

  it("focus on the cancel button survives the re-render that follows and the alert region clears once the request is forgotten", () => {
    const rig = setup();
    const h = atStepB();
    send(h, { type: "register" });
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS);
    rig.panel.render(buildWizardView(h.state));
    buttonOf(rig, "cancelInFlight").focus();
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS + 1_000);
    rig.panel.render(buildWizardView(h.state));
    expect(rig.doc.activeElement).toBe(buttonOf(rig, "cancelInFlight"));
    send(h, { type: "cancelInFlight" });
    rig.panel.render(buildWizardView(h.state));
    expect(byId(rig, "collector-wizard-alert").textContent).toBe("");
    expect(actionIds(rig)).not.toContain("cancelInFlight");
  });
});

describe("wizard panel: keyboard and focus", () => {
  it("Escape is prevented and dispatched once as `escape`; the native cancel adds nothing after it", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    const keydown = rig.dialog.dispatch(makeEvent("keydown", { key: "Escape" }));
    expect(keydown.defaultPrevented).toBe(true);
    const cancel = rig.dialog.dispatch(makeEvent("cancel"));
    expect(cancel.defaultPrevented).toBe(true);
    expect(rig.events).toEqual([{ type: "escape" }]);
  });

  it("a cancel without a key (for example a close request) is prevented and still goes to the model", () => {
    const rig = setup();
    const cancel = rig.dialog.dispatch(makeEvent("cancel"));
    expect(cancel.defaultPrevented).toBe(true);
    expect(rig.events).toEqual([{ type: "escape" }]);
    expect(rig.dialog.open).toBe(true);
  });

  it("Tab on the last stop wraps to the first; Shift+Tab on the first wraps to the last", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    const stops = [
      ...radios(rig).filter((radio) => radio.getAttribute("tabindex") === "0"),
      ...rig.dialog.findAll((element) => element.tagName === "button" && !element.disabled),
    ];
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    last.focus();
    const forward = rig.dialog.dispatch(makeEvent("keydown", { key: "Tab" }));
    expect(forward.defaultPrevented).toBe(true);
    expect(rig.doc.activeElement).toBe(first);
    const backward = rig.dialog.dispatch(makeEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(backward.defaultPrevented).toBe(true);
    expect(rig.doc.activeElement).toBe(last);
    // A Tab in the middle is left to the browser.
    if (stops.length > 2) {
      stops[1]!.focus();
      expect(rig.dialog.dispatch(makeEvent("keydown", { key: "Tab" })).defaultPrevented).toBe(false);
    }
  });

  it("Shift+Tab from the heading goes to the last stop", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    rig.panel.focusHeading();
    const event = rig.dialog.dispatch(makeEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(rig.doc.activeElement?.tagName).toBe("button");
  });

  it("focusHeading focuses the heading; focusPanel only moves focus when it is not already inside", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    const heading = byId(rig, "collector-wizard-title");
    rig.panel.focusHeading();
    expect(rig.doc.activeElement).toBe(heading);
    const button = buttonOf(rig, "next");
    button.focus();
    rig.panel.focusPanel();
    expect(rig.doc.activeElement).toBe(button);
    rig.doc.body.children.find((child): child is FakeElement => child instanceof FakeElement && child.tagName === "button")!.focus();
    rig.panel.focusPanel();
    expect(rig.doc.activeElement).toBe(heading);
  });

  it("a content change keeps focus on the same button, and a polling render keeps it too", () => {
    const rig = setup();
    const h = atStepE();
    rig.panel.render(buildWizardView(h.state));
    buttonOf(rig, "back").focus();
    send(h, { type: "tick" }, 1_000_000 + 12_000);
    rig.panel.render(buildWizardView(h.state));
    expect(rig.doc.activeElement).toBe(buttonOf(rig, "back"));
  });
});

describe("wizard panel: dispose and clipboard", () => {
  it("dispose closes and removes the dialog, drops listeners, restores focus, and is idempotent", () => {
    const rig = setup();
    const before = rig.doc.body.children[0] as FakeElement;
    rig.panel.render(buildWizardView(atStepA().state));
    buttonOf(rig, "next").focus();
    rig.panel.dispose();
    expect(rig.dialog.open).toBe(false);
    expect(rig.doc.body.children.includes(rig.dialog)).toBe(false);
    expect(rig.dialog.listenerCount()).toBe(0);
    expect(rig.doc.activeElement).toBe(before);
    rig.panel.render(buildWizardView(atStepA().state));
    rig.panel.dispose();
    expect(rig.events).toEqual([]);
  });

  it("copyText uses the Clipboard API when it works", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const rig = setup();
    await expect(rig.panel.copyText("chrome://extensions")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("chrome://extensions");
    expect(rig.doc.execCalls).toEqual([]);
  });

  it("copyText falls back to a selection copy inside the dialog when the API is missing or denied", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("denied")) } });
    const rig = setup();
    await expect(rig.panel.copyText("chrome://extensions")).resolves.toBe(true);
    expect(rig.doc.execCalls).toEqual(["copy"]);
    expect(rig.dialog.find((element) => element.tagName === "textarea")).toBeUndefined();

    vi.stubGlobal("navigator", {});
    rig.doc.execResult = false;
    await expect(rig.panel.copyText("chrome://extensions")).resolves.toBe(false);
  });
});

describe("wizard panel: focus survives re-renders (busy transitions)", () => {
  const insideDialog = (rig: Rig): boolean => {
    const active = rig.doc.activeElement;
    return active !== null && active !== rig.doc.body && (active === rig.dialog || rig.dialog.descendants().includes(active));
  };

  it("focus stays inside the dialog across every busy transition of a full walk-through", () => {
    const rig = setup();
    const h = atStepD();
    // Walk the model through busy transitions, focusing the button that was "pressed" each time.
    const press = (id: string, then: () => void) => {
      rig.panel.render(buildWizardView(h.state));
      const button = buttonOf(rig, id);
      button.focus();
      send(h, { type: id } as WizardUserEvent);
      rig.panel.render(buildWizardView(h.state));
      expect(h.state.inFlight, id).not.toBeNull();
      expect(insideDialog(rig), `${id} while busy`).toBe(true);
      expect(rig.doc.activeElement, `${id} keeps its key`).toBe(buttonOf(rig, id));
      then();
      rig.panel.render(buildWizardView(h.state));
      expect(insideDialog(rig), `${id} after the answer`).toBe(true);
    };
    press("openBrowserExtensions", () => respond(h, { kind: "browser-extensions", browser: "chrome", result: "opened" }));
    press("copyPath", () => respond(h, { kind: "extension-folder", intent: "copyExtensionPath", result: "done" }));
    press("revealFolder", () => respond(h, { kind: "extension-folder", intent: "revealExtensionFolder", result: "done" }));
  });

  it("step B and C buttons keep focus while the register / destination operation runs", () => {
    const rig = setup();
    const b = atStepB();
    rig.panel.render(buildWizardView(b.state));
    buttonOf(rig, "register").focus();
    send(b, { type: "register" });
    rig.panel.render(buildWizardView(b.state));
    expect(rig.doc.activeElement).toBe(buttonOf(rig, "register"));
    expect(buttonOf(rig, "register").getAttribute("aria-disabled")).toBe("true");
    respond(b, applyResponse());
    rig.panel.render(buildWizardView(b.state));
    expect(rig.doc.activeElement).not.toBe(rig.doc.body);

    const c = atStepC();
    rig.panel.render(buildWizardView(c.state));
    buttonOf(rig, "confirmDestination").focus();
    send(c, { type: "confirmDestination" });
    rig.panel.render(buildWizardView(c.state));
    expect(rig.doc.activeElement).toBe(buttonOf(rig, "confirmDestination"));
  });

  it("when the focused element really disappears focus goes to the heading, never <body>, and comes back to the key", () => {
    const rig = setup();
    const h = atStepD();
    rig.panel.render(buildWizardView(h.state));
    buttonOf(rig, "copyPath").focus();
    // A step whose view has no copyPath button (step E).
    const e = atStepE();
    rig.panel.render(buildWizardView(e.state));
    expect(rig.doc.activeElement).toBe(byId(rig, "collector-wizard-title"));
    expect(rig.doc.activeElement).not.toBe(rig.doc.body);
    // The old key exists again (back on step D): focus returns to it.
    rig.panel.render(buildWizardView(h.state));
    expect(rig.doc.activeElement).toBe(buttonOf(rig, "copyPath"));
  });

  it("an open <details> stays open across re-renders", () => {
    const rig = setup();
    const h = atStepE();
    rig.panel.render(buildWizardView(h.state));
    const details = rig.dialog.find((element) => element.tagName === "details")!;
    expect(details.open).toBe(false);
    details.open = true;
    send(h, { type: "tick" }, 1_000_000 + 12_000);
    send(h, { type: "tick" }, 1_000_000 + 12_500);
    // Force a rebuild with changed buttons: a busy poll answer.
    send(h, { type: "back" });
    send(h, { type: "loaded" }, 1_000_000 + 20_000);
    rig.panel.render(buildWizardView(h.state));
    expect(rig.dialog.find((element) => element.tagName === "details")?.open).toBe(true);
  });
});

describe("wizard panel: native close and cancel", () => {
  it("a non-cancelable cancel followed by a native close re-opens the dialog and asks the model once", () => {
    const rig = setup();
    rig.panel.render(buildWizardView(atStepA().state));
    const keydown = rig.dialog.dispatch(makeEvent("keydown", { key: "Escape" }));
    expect(keydown.defaultPrevented).toBe(true);
    const cancel = rig.dialog.dispatch(makeEvent("cancel", { cancelable: false }));
    expect(cancel.defaultPrevented).toBe(false);
    rig.dialog.nativeClose();
    expect(rig.dialog.open).toBe(true);
    expect(rig.dialog.showModalCount).toBe(2);
    expect(rig.events).toEqual([{ type: "escape" }]);
  });

  it("a close with no key before it is re-opened and goes to the model as escape", () => {
    const rig = setup();
    rig.dialog.nativeClose();
    expect(rig.dialog.open).toBe(true);
    expect(rig.events).toEqual([{ type: "escape" }]);
  });

  it("when the dialog cannot be re-opened the panel reports it as broken", () => {
    const doc = new FakeDocument();
    const onBroken = vi.fn();
    const panel = createWizardPanel({ document: doc as unknown as Document, onEvent: () => undefined, onBroken });
    rigs.push({ doc, events: [], panel, dialog: undefined as unknown as FakeElement });
    panel.show();
    const dialog = doc.body.children.find((child): child is FakeElement => child instanceof FakeElement && child.tagName === "dialog")!;
    dialog.remove();
    dialog.nativeClose();
    expect(onBroken).toHaveBeenCalledTimes(1);
  });

  it("dispose does not react to its own close", () => {
    const rig = setup();
    rig.panel.dispose();
    rig.dialog.nativeClose();
    expect(rig.events).toEqual([]);
  });

  function openWithRealPanel() {
    const doc = new FakeDocument();
    const closed: string[] = [];
    const intervals: { cleared: boolean }[] = [];
    const runs: ((value: CollectorIntegrationResponse) => void)[] = [];
    let panelRef: WizardPanel | undefined;
    const handle = openCollectorWizard({
      runCollectorIntegration: () => new Promise((resolve) => runs.push(resolve)),
      configureCollectorSaveDestination: () => new Promise(() => undefined),
      setInterval: () => {
        const entry = { cleared: false };
        intervals.push(entry);
        return entry;
      },
      clearInterval: (entry) => {
        (entry as { cleared: boolean }).cleared = true;
      },
      requestAnimationFrame: (callback) => callback(),
      createPanel: (options) => {
        panelRef = createWizardPanel({ ...options, document: doc as unknown as Document });
        return panelRef;
      },
      onClosed: (outcome) => closed.push(outcome),
      onError: (error) => {
        throw error;
      },
    });
    const dialog = doc.body.children.find((child): child is FakeElement => child instanceof FakeElement && child.tagName === "dialog")!;
    return { doc, dialog, handle, closed, intervals, runs, panel: panelRef! };
  }

  it("integration: an idle native close ends the wizard cleanly (active cleared, outcome later)", async () => {
    const r = openWithRealPanel();
    r.runs[0]!(statusResponse());
    await Promise.resolve();
    await Promise.resolve();
    r.dialog.dispatch(makeEvent("keydown", { key: "Escape" }));
    r.dialog.dispatch(makeEvent("cancel", { cancelable: false }));
    r.dialog.nativeClose();
    expect(r.closed).toEqual(["later"]);
    expect(isCollectorWizardOpen()).toBe(false);
    expect(r.doc.body.children.includes(r.dialog)).toBe(false);
  });

  it("integration: while setup runs a native close re-opens the dialog, the wizard stays consistent, and a ticker would not leak", async () => {
    const r = openWithRealPanel();
    r.runs[0]!(statusResponse());
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    r.panel.render(buildWizardView(atStepA().state));
    const next = buttonOf({ dialog: r.dialog } as Rig, "next");
    next.dispatch(makeEvent("click"));
    buttonOf({ dialog: r.dialog } as Rig, "register").dispatch(makeEvent("click"));
    // Setup is in flight: Esc is ignored by the model, the second cancel closes natively.
    r.dialog.dispatch(makeEvent("keydown", { key: "Escape" }));
    r.dialog.dispatch(makeEvent("cancel", { cancelable: false }));
    r.dialog.nativeClose();
    expect(r.dialog.open).toBe(true);
    expect(r.closed).toEqual([]);
    expect(isCollectorWizardOpen()).toBe(true);
    r.handle.close();
    expect(isCollectorWizardOpen()).toBe(false);
    expect(r.intervals.every((entry) => entry.cleared)).toBe(true);
  });
});

describe("wizard panel: dispose focus return", () => {
  it("falls back to an existing app control when the opener is gone, else leaves focus on the document", () => {
    const doc = new FakeDocument();
    const opener = doc.createElement("button");
    doc.body.append(opener);
    opener.focus();
    const panel = createWizardPanel({ document: doc as unknown as Document, onEvent: () => undefined });
    rigs.push({ doc, events: [], panel, dialog: undefined as unknown as FakeElement });
    panel.show();
    const fallback = doc.createElement("button");
    fallback.id = "toggle-primary-sidebar";
    doc.body.append(fallback);
    doc.byId.set("toggle-primary-sidebar", fallback);
    opener.remove();
    panel.dispose();
    expect(doc.activeElement).toBe(fallback);

    const doc2 = new FakeDocument();
    const opener2 = doc2.createElement("button");
    doc2.body.append(opener2);
    opener2.focus();
    const panel2 = createWizardPanel({ document: doc2 as unknown as Document, onEvent: () => undefined });
    rigs.push({ doc: doc2, events: [], panel: panel2, dialog: undefined as unknown as FakeElement });
    panel2.show();
    opener2.remove();
    panel2.dispose();
    expect(doc2.activeElement).toBe(doc2.body);
  });
});
