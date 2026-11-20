import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardUserEvent } from "./collector-wizard-model";
import { createWizardPanel, type WizardPanel } from "./collector-wizard-panel";
import { buildWizardView } from "./collector-wizard-view";
import { atStepA, atStepD, atStepE, entry, send, start } from "./collector-wizard-test-support";

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
  defaultPrevented: boolean;
  preventDefault(): void;
}

function makeEvent(type: string, init: { key?: string; shiftKey?: boolean } = {}): FakeEvent {
  const event: FakeEvent = {
    type,
    ...init,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
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
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = "";
    this.append(...nodes);
  }
  public detach(child: FakeElement | FakeText): void {
    this.children = this.children.filter((candidate) => candidate !== child);
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
  public focus(): void {
    this.focusCount += 1;
    this.doc.activeElement = this;
  }
  public select(): void {
    // no-op
  }
  public showModal(): void {
    this.open = true;
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
  public activeElement: FakeElement | null = null;
  public readonly body = new FakeElement("body", this);
  public execCalls: string[] = [];
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
    expect(rig.dialog.getAttribute("aria-busy")).toBe("false");
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
    expect(byId(rig, labelId).textContent).toContain("Google Chrome");
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

  it("a disabled button is disabled, has no click path, and points at the busy status", () => {
    const rig = setup();
    const h = start();
    send(h, { type: "opened" });
    rig.panel.render(buildWizardView(h.state));
    const recheck = buttonOf(rig, "recheckBrowsers");
    expect(recheck.disabled).toBe(true);
    expect(recheck.getAttribute("aria-describedby")).toBe("collector-wizard-status");
    recheck.dispatch(makeEvent("click"));
    expect(rig.events).toEqual([]);
    expect(rig.dialog.getAttribute("aria-busy")).toBe("true");
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
    expect(buttonOf(rig, "copyPath").parent?.className).toBe("collector-wizard-actions-tools");
    expect(buttonOf(rig, "loaded").parent?.className).toBe("collector-wizard-actions-nav");
    copy.dispatch(makeEvent("click"));
    expect(rig.events).toEqual([{ type: "copyAddress" }]);
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
