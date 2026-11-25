import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectorIntegrationRequest, CollectorIntegrationResponse } from "../collector-integration-ipc";
import type { CollectorSaveDestinationIpcResult } from "../collector-save-destination-ipc";
import type { WizardClosedOutcome, WizardUserEvent } from "./collector-wizard-model";
import { WIZARD_INFLIGHT_CANCEL_MS, WIZARD_POLL_INTERVAL_MS, WIZARD_TICK_INTERVAL_MS } from "./collector-wizard-model";
import { isCollectorWizardOpen, openCollectorWizard, type CollectorWizardDeps, type CollectorWizardHandle } from "./collector-wizard-controller";
import type { WizardPanel, WizardPanelOptions } from "./collector-wizard-panel";
import type { WizardView } from "./collector-wizard-view";
import { CONNECTED, applyResponse, connection, statusResponse } from "./collector-wizard-test-support";

// ----- fakes ------------------------------------------------------------------------------------

interface Deferred<T> {
  readonly request: CollectorIntegrationRequest | null;
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(request: CollectorIntegrationRequest | null): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { request, promise, resolve, reject };
}

class FakePanel implements WizardPanel {
  public views: WizardView[] = [];
  public calls: string[] = [];
  public disposed = false;
  public copied: string[] = [];
  public constructor(public readonly options: WizardPanelOptions) {}
  public show(): void {
    this.calls.push("show");
  }
  public render(view: WizardView): void {
    this.calls.push("render");
    this.views.push(view);
  }
  public focusHeading(): void {
    this.calls.push("focusHeading");
  }
  public focusRadio(browser: string): void {
    this.calls.push(`focusRadio:${browser}`);
  }
  public focusPanel(): void {
    this.calls.push("focusPanel");
  }
  public async copyText(text: string): Promise<boolean> {
    this.copied.push(text);
    return true;
  }
  public dispose(): void {
    this.calls.push("dispose");
    this.disposed = true;
  }
  public get view(): WizardView {
    return this.views[this.views.length - 1]!;
  }
  public press(id: string): void {
    const button = this.view.buttons.find((candidate) => candidate.id === id);
    if (button === undefined) throw new Error(`no button ${id}`);
    if (!button.enabled) throw new Error(`button ${id} is disabled`);
    this.options.onEvent(button.event);
  }
  public emit(event: WizardUserEvent): void {
    this.options.onEvent(event);
  }
}

interface Rig {
  readonly deps: CollectorWizardDeps;
  readonly panels: FakePanel[];
  readonly runs: Deferred<CollectorIntegrationResponse>[];
  readonly configures: Deferred<CollectorSaveDestinationIpcResult>[];
  readonly intervals: { callback: () => void; intervalMs: number; cleared: boolean }[];
  readonly rafQueue: (() => void)[];
  readonly closed: WizardClosedOutcome[];
  readonly clock: { now: number };
  readonly nowCalls: number[];
  readonly clipboard: { texts: string[]; result: () => Promise<boolean | void> };
  readonly panel: FakePanel;
  flushRaf(): void;
  tick(ms: number): void;
}

function makeRig(over: Partial<CollectorWizardDeps> = {}): Rig {
  const panels: FakePanel[] = [];
  const runs: Deferred<CollectorIntegrationResponse>[] = [];
  const configures: Deferred<CollectorSaveDestinationIpcResult>[] = [];
  const intervals: Rig["intervals"] = [];
  const rafQueue: (() => void)[] = [];
  const closed: WizardClosedOutcome[] = [];
  const clock = { now: 50_000 };
  const nowCalls: number[] = [];
  const clipboard: Rig["clipboard"] = { texts: [], result: async () => true };
  const deps: CollectorWizardDeps = {
    runCollectorIntegration: (request) => {
      const entry = deferred<CollectorIntegrationResponse>(request);
      runs.push(entry);
      return entry.promise;
    },
    configureCollectorSaveDestination: () => {
      const entry = deferred<CollectorSaveDestinationIpcResult>(null);
      configures.push(entry);
      return entry.promise;
    },
    writeClipboardText: async (text) => {
      clipboard.texts.push(text);
      return clipboard.result();
    },
    now: () => {
      nowCalls.push(clock.now);
      return clock.now;
    },
    setInterval: (callback, intervalMs) => {
      const handle = { callback, intervalMs, cleared: false };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      (handle as Rig["intervals"][number]).cleared = true;
    },
    requestAnimationFrame: (callback) => {
      rafQueue.push(callback);
    },
    createPanel: (options) => {
      const panel = new FakePanel(options);
      panels.push(panel);
      return panel;
    },
    onClosed: (outcome) => closed.push(outcome),
    ...over,
  };
  return {
    deps,
    panels,
    runs,
    configures,
    intervals,
    rafQueue,
    closed,
    clock,
    nowCalls,
    clipboard,
    get panel() {
      return panels[panels.length - 1]!;
    },
    flushRaf() {
      for (const callback of rafQueue.splice(0)) callback();
    },
    tick(ms: number) {
      clock.now += ms;
      for (const interval of intervals) if (!interval.cleared) interval.callback();
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

let handles: CollectorWizardHandle[] = [];
function open(rig: Rig): CollectorWizardHandle {
  const handle = openCollectorWizard(rig.deps);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles) handle.close();
  handles = [];
});

/** Resolve the first inspection and arrive at step A (ready). */
async function readyA(rig: Rig): Promise<void> {
  rig.runs[0]!.resolve(statusResponse());
  await settle();
}

async function toStepD(rig: Rig): Promise<void> {
  await readyA(rig);
  rig.panel.press("next");
  rig.panel.press("register");
  rig.runs.at(-1)!.resolve(applyResponse());
  await settle();
  rig.panel.press("next");
  rig.panel.press("confirmDestination");
  rig.configures[0]!.resolve({ kind: "configured", writesEnabled: true });
  await settle();
  rig.panel.press("next");
  rig.runs.at(-1)!.resolve(statusResponse({ state: "ready", extensionFolderPlaced: true }));
  await settle();
}

async function toStepE(rig: Rig): Promise<void> {
  await toStepD(rig);
  rig.panel.press("loaded");
}

// ----- tests ------------------------------------------------------------------------------------

describe("wizard controller: open and the request round trip", () => {
  it("opens the panel, renders, sends `opened`, and runs the first inspection", async () => {
    const rig = makeRig();
    expect(isCollectorWizardOpen()).toBe(false);
    open(rig);
    expect(isCollectorWizardOpen()).toBe(true);
    expect(rig.panels).toHaveLength(1);
    expect(rig.panel.calls.slice(0, 2)).toEqual(["show", "render"]);
    expect(rig.runs).toHaveLength(1);
    expect(rig.runs[0]!.request).toEqual({ intent: "inspect" });
    expect(rig.panel.view.busy).toBe(true);

    rig.runs[0]!.resolve(statusResponse());
    await settle();
    expect(rig.panel.view.busy).toBe(false);
    expect(rig.panel.view.blocks.some((block) => block.kind === "radiogroup")).toBe(true);
  });

  it("a rejected request becomes requestFailed (an alert with a retry), not a stuck spinner", async () => {
    const rig = makeRig();
    open(rig);
    rig.runs[0]!.reject(new Error("ipc down"));
    await settle();
    expect(rig.panel.view.busy).toBe(false);
    expect(rig.panel.view.live.alert).toHaveLength(1);
    expect(rig.panel.view.buttons.some((button) => button.id === "recheckBrowsers" && button.enabled)).toBe(true);
  });

  it("a synchronous throw and a malformed (non-object) answer are also requestFailed", async () => {
    const thrower = makeRig({
      runCollectorIntegration: () => {
        throw new Error("sync");
      },
    });
    open(thrower);
    await settle();
    expect(thrower.panel.view.live.alert).toHaveLength(1);
    handles.pop()!.close();

    const malformed = makeRig({ runCollectorIntegration: async () => undefined as unknown as CollectorIntegrationResponse });
    open(malformed);
    await settle();
    expect(malformed.panel.view.live.alert).toHaveLength(1);
  });

  it("the destination effect calls configureCollectorSaveDestination and returns destinationResult", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("register");
    rig.runs.at(-1)!.resolve(applyResponse());
    await settle();
    rig.panel.press("next");
    rig.panel.press("confirmDestination");
    expect(rig.configures).toHaveLength(1);
    expect(rig.panel.view.busy).toBe(true);
    rig.configures[0]!.resolve({ kind: "configured", writesEnabled: true });
    await settle();
    expect(rig.panel.view.busy).toBe(false);
    expect(rig.panel.view.live.status).toHaveLength(1);
    // A rejection of that call is a requestFailed too.
    handles.pop()!.close();
    const again = makeRig();
    open(again);
    await readyA(again);
    again.panel.press("next");
    again.panel.press("register");
    again.runs.at(-1)!.resolve(applyResponse());
    await settle();
    again.panel.press("next");
    again.panel.press("confirmDestination");
    again.configures[0]!.reject(new Error("dialog failed"));
    await settle();
    expect(again.panel.view.busy).toBe(false);
    expect(again.panel.view.live.alert).toHaveLength(1);
  });
});

describe("wizard controller: time", () => {
  it("every event carries the injected now(); the default clock is performance.now", async () => {
    const rig = makeRig();
    open(rig);
    expect(rig.nowCalls.length).toBeGreaterThan(0);
    expect(rig.nowCalls.every((value) => value === 50_000)).toBe(true);

    const spy = vi.spyOn(performance, "now").mockReturnValue(123);
    try {
      const plain = makeRig({ now: undefined });
      handles.pop()!.close();
      open(plain);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("entering step E starts exactly one ticker; polling follows the model's interval", async () => {
    const rig = makeRig();
    open(rig);
    await toStepE(rig);
    const active = rig.intervals.filter((interval) => !interval.cleared);
    expect(active).toHaveLength(1);
    expect(active[0]!.intervalMs).toBe(WIZARD_TICK_INTERVAL_MS);
    // The first poll went out when E opened; answer it with "waiting".
    const polls = rig.runs.filter((run) => run.request?.intent === "checkConnection");
    expect(polls).toHaveLength(1);
    polls[0]!.resolve(connection({ state: "waiting" }));
    await settle();
    rig.tick(WIZARD_POLL_INTERVAL_MS);
    expect(rig.runs.filter((run) => run.request?.intent === "checkConnection")).toHaveLength(2);
    // Never stacked: still one live timer.
    expect(rig.intervals.filter((interval) => !interval.cleared)).toHaveLength(1);
  });

  it("the ticker stops when the connection is confirmed and when the wizard closes", async () => {
    const rig = makeRig();
    const handle = open(rig);
    await toStepE(rig);
    rig.runs.filter((run) => run.request?.intent === "checkConnection")[0]!.resolve(connection(CONNECTED));
    await settle();
    expect(rig.intervals.every((interval) => interval.cleared)).toBe(true);
    expect(rig.panel.view.buttons.find((button) => button.id === "finish")).toBeDefined();
    handle.close();
  });

  it("closing while the ticker runs clears it, and a stale timer callback does nothing", async () => {
    const rig = makeRig();
    const handle = open(rig);
    await toStepE(rig);
    const timer = rig.intervals.find((interval) => !interval.cleared)!;
    const renders = rig.panel.views.length;
    handle.close();
    expect(timer.cleared).toBe(true);
    timer.callback();
    expect(rig.panel.views.length).toBe(renders);
    expect(rig.runs.filter((run) => run.request?.intent === "checkConnection")).toHaveLength(1);
  });
});

describe("wizard controller: in-flight watchdog and cancel", () => {
  const active = (rig: Rig) => rig.intervals.filter((interval) => !interval.cleared);

  async function toRegisterInFlight(rig: Rig): Promise<void> {
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("register");
  }

  it("a ticker runs during the setup request, uses the injected clock, and stops once it answers", async () => {
    const rig = makeRig();
    open(rig);
    await toRegisterInFlight(rig);
    expect(active(rig)).toHaveLength(1);
    expect(active(rig)[0]!.intervalMs).toBe(WIZARD_TICK_INTERVAL_MS);
    rig.tick(1_000);
    expect(rig.panel.view.buttons.some((button) => button.id === "cancelInFlight")).toBe(false);
    rig.runs.at(-1)!.resolve(applyResponse());
    await settle();
    expect(active(rig)).toHaveLength(0);
  });

  it("a ticker also runs during the destination request", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("register");
    rig.runs.at(-1)!.resolve(applyResponse());
    await settle();
    rig.panel.press("next");
    rig.panel.press("confirmDestination");
    expect(active(rig)).toHaveLength(1);
    rig.configures[0]!.resolve({ kind: "configured", writesEnabled: true });
    await settle();
    expect(active(rig)).toHaveLength(0);
  });

  it("a wall-clock jump of 3 minutes with no ticks in between surfaces the cancel button on the next tick", async () => {
    const rig = makeRig();
    open(rig);
    await toRegisterInFlight(rig);
    expect(rig.panel.view.live.alert).toEqual([]);
    rig.clock.now += WIZARD_INFLIGHT_CANCEL_MS;
    expect(rig.panel.view.buttons.some((button) => button.id === "cancelInFlight")).toBe(false);
    active(rig)[0]!.callback();
    expect(rig.panel.view.buttons.some((button) => button.id === "cancelInFlight" && button.enabled)).toBe(true);
    expect(rig.panel.view.live.alert.map((message) => message.headline)).toEqual(["応答に時間がかかっています。"]);
  });

  it("cancel stops the ticker, and a late response, rejection or destination result leaves the screen unchanged", async () => {
    const rig = makeRig();
    open(rig);
    await toRegisterInFlight(rig);
    const lateRun = rig.runs.at(-1)!;
    rig.tick(WIZARD_INFLIGHT_CANCEL_MS);
    rig.panel.press("cancelInFlight");
    expect(active(rig)).toHaveLength(0);
    const after = rig.panel.view;
    const renders = rig.panel.views.length;
    lateRun.resolve(applyResponse());
    await settle();
    expect(rig.panel.view).toEqual(after);
    expect(rig.panel.view.step).toBe("B");
    expect(rig.panel.view.busy).toBe(false);
    expect(rig.closed).toEqual([]);
    // Whatever was rendered after the late answer is identical to the screen before it.
    for (const view of rig.panel.views.slice(renders)) expect(view).toEqual(after);
  });

  it("a late rejection after cancel changes nothing either", async () => {
    const rig = makeRig();
    open(rig);
    await toRegisterInFlight(rig);
    const lateRun = rig.runs.at(-1)!;
    rig.tick(WIZARD_INFLIGHT_CANCEL_MS);
    rig.panel.press("cancelInFlight");
    const after = rig.panel.view;
    lateRun.reject(new Error("late failure"));
    await settle();
    expect(rig.panel.view).toEqual(after);
    expect(rig.panel.view.live.alert).toEqual([]);
  });

  it("a late destination result after cancel changes nothing", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("register");
    rig.runs.at(-1)!.resolve(applyResponse());
    await settle();
    rig.panel.press("next");
    rig.panel.press("confirmDestination");
    rig.tick(WIZARD_INFLIGHT_CANCEL_MS);
    rig.panel.press("cancelInFlight");
    const after = rig.panel.view;
    rig.configures[0]!.resolve({ kind: "configured", writesEnabled: true });
    await settle();
    expect(rig.panel.view).toEqual(after);
    expect(rig.panel.view.step).toBe("C");
    expect(active(rig)).toHaveLength(0);
  });

  it("a late destination rejection after cancel changes nothing", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("register");
    rig.runs.at(-1)!.resolve(applyResponse());
    await settle();
    rig.panel.press("next");
    rig.panel.press("confirmDestination");
    rig.tick(WIZARD_INFLIGHT_CANCEL_MS);
    rig.panel.press("cancelInFlight");
    const after = rig.panel.view;
    rig.configures[0]!.reject(new Error("late"));
    await settle();
    expect(rig.panel.view).toEqual(after);
  });

  it("the destination-error screen: 保存先を選び直す reopens the picker, キャンセル closes with later", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("register");
    rig.runs.at(-1)!.resolve(applyResponse());
    await settle();
    rig.panel.press("next");
    rig.panel.press("confirmDestination");
    rig.configures[0]!.resolve({ kind: "busy" });
    await settle();
    expect(rig.panel.view.buttons.map((button) => button.id)).toEqual(["chooseDestinationAgain", "cancelSetup", "confirmDestination"]);
    rig.panel.press("chooseDestinationAgain");
    expect(rig.configures).toHaveLength(2);
    expect(rig.panel.view.busy).toBe(true);
    rig.configures[1]!.resolve({ kind: "error" } as never);
    await settle();
    rig.panel.emit({ type: "escape" });
    expect(rig.closed).toEqual(["later"]);
    expect(rig.panel.disposed).toBe(true);
  });

  it("dispose while a request is slow clears the ticker", async () => {
    const rig = makeRig();
    const handle = open(rig);
    await toRegisterInFlight(rig);
    handle.close();
    expect(active(rig)).toHaveLength(0);
  });
});

describe("wizard controller: instance binding", () => {
  it("a late answer after close is dropped (no render, no throw)", async () => {
    const rig = makeRig();
    const handle = open(rig);
    const renders = rig.panel.views.length;
    handle.close();
    rig.runs[0]!.resolve(statusResponse());
    await settle();
    expect(rig.panel.views.length).toBe(renders);
    expect(rig.panel.disposed).toBe(true);
    expect(isCollectorWizardOpen()).toBe(false);
  });

  it("a new instance (requestId restarts at 1) is not answered by the old instance's pending promise", async () => {
    const rig = makeRig();
    const first = open(rig);
    const oldRun = rig.runs[0]!;
    first.close();
    handles = [];

    const second = open(rig);
    const secondRun = rig.runs[1]!;
    expect(rig.panels).toHaveLength(2);
    // The old call resolves with a recognisable answer; the new wizard must not take it.
    oldRun.resolve(statusResponse({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [] } }));
    await settle();
    expect(rig.panels[1]!.view.busy).toBe(true);
    expect(rig.panels[1]!.view.blocks.some((block) => block.kind === "radiogroup")).toBe(false);
    secondRun.resolve(statusResponse());
    await settle();
    expect(rig.panels[1]!.view.busy).toBe(false);
    second.close();
  });

  it("an old clipboard or destination result cannot answer a later instance either", async () => {
    const rig = makeRig();
    const first = open(rig);
    await toStepD(rig);
    let release!: (value: boolean) => void;
    rig.clipboard.result = () => new Promise<boolean>((resolve) => (release = resolve));
    rig.panel.press("copyAddress");
    first.close();
    handles = [];
    open(rig);
    release(true);
    await settle();
    expect(rig.panels[1]!.view.live.status.filter((message) => message.headline.includes("コピー"))).toEqual([]);
  });
});

describe("wizard controller: only one wizard at a time", () => {
  it("a second open returns the open wizard, brings it forward, and creates no second panel", async () => {
    const rig = makeRig();
    const first = open(rig);
    const second = openCollectorWizard(rig.deps);
    expect(second).toBe(first);
    expect(rig.panels).toHaveLength(1);
    expect(rig.runs).toHaveLength(1);
    expect(rig.panel.calls).toContain("focusPanel");
    first.focus();
    expect(rig.panel.calls.filter((call) => call === "focusPanel")).toHaveLength(2);
  });

  it("after close a new wizard can be opened, and focus() on a closed handle is harmless", () => {
    const rig = makeRig();
    const first = open(rig);
    first.close();
    first.close();
    first.focus();
    expect(isCollectorWizardOpen()).toBe(false);
    open(rig);
    expect(rig.panels).toHaveLength(2);
    expect(rig.panels[1]!.disposed).toBe(false);
  });

  it("a panel that fails to show is cleaned up and does not block the next open", () => {
    const failing = makeRig({
      createPanel: (options) => {
        const panel = new FakePanel(options);
        panel.show = () => {
          throw new Error("showModal failed");
        };
        return panel;
      },
    });
    expect(() => openCollectorWizard(failing.deps)).toThrow("showModal failed");
    expect(isCollectorWizardOpen()).toBe(false);
    open(makeRig());
    expect(isCollectorWizardOpen()).toBe(true);
  });
});

describe("wizard controller: clipboard", () => {
  it("copyAddress writes the browser address and answers clipboardResult (status on success)", async () => {
    const rig = makeRig();
    open(rig);
    await toStepD(rig);
    rig.panel.press("copyAddress");
    await settle();
    expect(rig.clipboard.texts).toEqual(["chrome://extensions"]);
    expect(rig.panel.view.live.status).toHaveLength(1);
    expect(rig.panel.view.live.alert).toEqual([]);
  });

  it("a false result and a rejection both come back as a failure (alert)", async () => {
    const rig = makeRig();
    open(rig);
    await toStepD(rig);
    rig.clipboard.result = async () => false;
    rig.panel.press("copyAddress");
    await settle();
    expect(rig.panel.view.live.alert).toHaveLength(1);
    rig.clipboard.result = async () => {
      throw new Error("denied");
    };
    rig.panel.press("copyAddress");
    await settle();
    expect(rig.panel.view.live.alert).toHaveLength(1);
    expect(rig.clipboard.texts).toHaveLength(2);
  });

  it("without an injected writer the panel's own copy is used", async () => {
    const rig = makeRig({ writeClipboardText: undefined });
    open(rig);
    await toStepD(rig);
    rig.panel.press("copyAddress");
    await settle();
    expect(rig.panel.copied).toEqual(["chrome://extensions"]);
    expect(rig.panel.view.live.status).toHaveLength(1);
  });
});

describe("wizard controller: focus, Esc, later, finish", () => {
  it("focusHeading runs after the render, through requestAnimationFrame, and not after dispose", async () => {
    const rig = makeRig();
    const handle = open(rig);
    await readyA(rig);
    rig.flushRaf();
    rig.rafQueue.length = 0;
    rig.panel.calls.length = 0;
    rig.panel.press("next");
    expect(rig.panel.calls).toEqual(["render"]);
    expect(rig.rafQueue).toHaveLength(1);
    rig.flushRaf();
    expect(rig.panel.calls).toEqual(["render", "focusHeading"]);
    rig.panel.press("back");
    handle.close();
    rig.flushRaf();
    expect(rig.panel.calls.filter((call) => call === "focusHeading")).toHaveLength(1);
  });

  it("a radio arrow key dispatches radioKey and focuses the selected radio", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.flushRaf();
    rig.panel.emit({ type: "radioKey", key: "ArrowDown" });
    rig.flushRaf();
    expect(rig.panel.calls).toContain("focusRadio:chrome");
  });

  it("Esc closes like あとで設定 (outcome later) and cleans up", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.emit({ type: "escape" });
    expect(rig.closed).toEqual(["later"]);
    expect(rig.panel.disposed).toBe(true);
    expect(isCollectorWizardOpen()).toBe(false);
  });

  it("あとで設定 on a middle step closes with outcome later", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("later");
    expect(rig.closed).toEqual(["later"]);
    expect(rig.panel.disposed).toBe(true);
  });

  it("Esc and あとで設定 are ignored while the setup write is running", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.panel.press("next");
    rig.panel.press("register");
    rig.panel.emit({ type: "escape" });
    rig.panel.emit({ type: "later" });
    expect(rig.closed).toEqual([]);
    expect(rig.panel.disposed).toBe(false);
    rig.runs.at(-1)!.resolve(applyResponse());
    await settle();
    expect(rig.panel.view.live.status).toHaveLength(1);
  });

  it("Esc after a confirmed connection does nothing; 完了 then 閉じる ends with outcome finished", async () => {
    const rig = makeRig();
    open(rig);
    await toStepE(rig);
    rig.runs.filter((run) => run.request?.intent === "checkConnection")[0]!.resolve(connection(CONNECTED));
    await settle();
    rig.panel.emit({ type: "escape" });
    expect(rig.closed).toEqual([]);
    rig.panel.press("finish");
    expect(rig.panel.view.step).toBe("done");
    expect(rig.closed).toEqual([]);
    rig.panel.press("close");
    expect(rig.closed).toEqual(["finished"]);
    expect(rig.panel.disposed).toBe(true);
    expect(rig.intervals.every((interval) => interval.cleared)).toBe(true);
  });

  it("handle.close() disposes without reporting an outcome", async () => {
    const rig = makeRig();
    const handle = open(rig);
    await readyA(rig);
    handle.close();
    expect(rig.closed).toEqual([]);
    expect(rig.panel.disposed).toBe(true);
  });
});

describe("wizard controller: robustness", () => {
  it("a throwing render is reported, the wizard keeps its state, and Esc still works", async () => {
    const errors: unknown[] = [];
    const rig = makeRig({ onError: (error) => errors.push(error) });
    open(rig);
    const panel = rig.panel;
    const original = panel.render.bind(panel);
    let throwing = false;
    panel.render = (view) => {
      if (throwing) throw new Error("render failed");
      original(view);
    };
    throwing = true;
    rig.runs[0]!.resolve(statusResponse());
    await settle();
    expect(errors).toHaveLength(1);
    // The model state advanced (the first inspection is answered): Esc closes.
    panel.emit({ type: "escape" });
    expect(rig.closed).toEqual(["later"]);
    expect(panel.disposed).toBe(true);
  });

  it("a throwing effect does not stop the remaining effects", async () => {
    const errors: unknown[] = [];
    const rig = makeRig({
      onError: (error) => errors.push(error),
      setInterval: () => {
        throw new Error("no timers");
      },
    });
    open(rig);
    await toStepE(rig);
    expect(errors.length).toBeGreaterThan(0);
    expect(rig.runs.filter((run) => run.request?.intent === "checkConnection")).toHaveLength(1);
  });

  it("a panel that reports itself broken ends the wizard without leaking the ticker", async () => {
    const rig = makeRig();
    open(rig);
    await toStepE(rig);
    rig.panel.options.onBroken?.();
    expect(rig.closed).toEqual(["later"]);
    expect(isCollectorWizardOpen()).toBe(false);
    expect(rig.intervals.every((interval) => interval.cleared)).toBe(true);
  });

  it("focusRadio runs directly, focusHeading still waits for the animation frame", async () => {
    const rig = makeRig();
    open(rig);
    await readyA(rig);
    rig.flushRaf();
    rig.panel.calls.length = 0;
    rig.panel.emit({ type: "radioKey", key: "ArrowDown" });
    expect(rig.panel.calls).toContain("focusRadio:chrome");
    expect(rig.rafQueue).toHaveLength(0);
  });
});
