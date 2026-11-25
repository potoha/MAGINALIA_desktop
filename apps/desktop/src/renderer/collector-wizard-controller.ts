/**
 * Collector integration wizard: controller (S8 / WP-7 slice B, step B3, layer 3 of 3).
 *
 * `openCollectorWizard(deps)` opens the wizard and keeps it running until it closes. It runs the
 * model's effects (see the EXECUTOR CONTRACT in `collector-wizard-model.ts`) and feeds the outcomes
 * back as events:
 * - every event carries `now()` (monotonic, `performance.now()` by default);
 * - every asynchronous result is bound to the wizard INSTANCE that issued the effect and dropped once
 *   that instance is disposed (`nextRequestId` restarts at 0 in a new instance, so an old promise must
 *   never answer a new one);
 * - the ticker is started and stopped idempotently and is always stopped on dispose;
 * - only one wizard exists at a time: a second call returns the open one and brings it forward.
 *
 * Menus, command IDs and notices are NOT here (slice B4); they call `openCollectorWizard`.
 */
import type { CollectorIntegrationRequest, CollectorIntegrationResponse } from "../collector-integration-ipc";
import type { CollectorSaveDestinationIpcResult } from "../collector-save-destination-ipc";
import {
  initialWizardState,
  reduceWizard,
  type WizardClosedOutcome,
  type WizardEffect,
  type WizardEvent,
  type WizardState,
  type WizardSystemEvent,
  type WizardUserEvent,
} from "./collector-wizard-model";
import { createWizardPanel, type WizardPanel, type WizardPanelFactory } from "./collector-wizard-panel";
import { buildWizardView } from "./collector-wizard-view";

export interface CollectorWizardDeps {
  /** `window.maginalia.runCollectorIntegration`. */
  readonly runCollectorIntegration: (request: CollectorIntegrationRequest) => Promise<CollectorIntegrationResponse>;
  /** `window.maginalia.configureCollectorSaveDestination`. */
  readonly configureCollectorSaveDestination: () => Promise<CollectorSaveDestinationIpcResult>;
  /**
   * Writes a fixed browser address to the clipboard; resolve `false` (or reject) when it failed.
   * Default: the panel's own writer (Clipboard API, then a selection fallback inside the dialog).
   */
  readonly writeClipboardText?: (text: string) => Promise<boolean | void>;
  /** Monotonic milliseconds. Default `performance.now()`. */
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Default `requestAnimationFrame` (or a 0 ms timeout when there is none). */
  readonly requestAnimationFrame?: (callback: () => void) => void;
  /** Default: the real `<dialog>` panel on the global `document`. */
  readonly createPanel?: WizardPanelFactory;
  /** Receives an unexpected exception from rendering or an effect. Default: `console.error`. */
  readonly onError?: (error: unknown) => void;
  /** Called once when the wizard closes by its own event (`later` / `finished`), after cleanup. */
  readonly onClosed?: (outcome: WizardClosedOutcome) => void;
}

export interface CollectorWizardHandle {
  /** Close without any model event (for example at application shutdown). Writes nothing. Idempotent. */
  close(): void;
  /** Bring the open wizard to the front and put focus back in it. */
  focus(): void;
}

interface ActiveWizard {
  readonly handle: CollectorWizardHandle;
}

let active: ActiveWizard | null = null;

/** Test hook: whether a wizard is currently open. */
export function isCollectorWizardOpen(): boolean {
  return active !== null;
}

export function openCollectorWizard(deps: CollectorWizardDeps): CollectorWizardHandle {
  if (active !== null) {
    active.handle.focus();
    return active.handle;
  }
  const instance = new WizardInstance(deps, () => {
    if (active?.handle === instance.handle) active = null;
  });
  active = { handle: instance.handle };
  try {
    instance.start();
  } catch (error) {
    instance.handle.close();
    throw error;
  }
  return instance.handle;
}

class WizardInstance {
  public readonly handle: CollectorWizardHandle;

  private state: WizardState = initialWizardState();
  private readonly panel: WizardPanel;
  private tickTimer: unknown = null;
  private disposed = false;

  private readonly now: () => number;
  private readonly setIntervalFn: (callback: () => void, intervalMs: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly raf: (callback: () => void) => void;

  public constructor(private readonly deps: CollectorWizardDeps, private readonly onDisposed: () => void) {
    this.now = deps.now ?? (() => performance.now());
    this.setIntervalFn = deps.setInterval ?? ((callback, intervalMs) => globalThis.setInterval(callback, intervalMs));
    this.clearIntervalFn = deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
    this.raf =
      deps.requestAnimationFrame ??
      ((callback) => {
        if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(() => callback());
        else globalThis.setTimeout(callback, 0);
      });
    const createPanel = deps.createPanel ?? createWizardPanel;
    this.panel = createPanel({
      document: globalThis.document,
      onEvent: (event: WizardUserEvent) => this.dispatch(event),
      onBroken: () => {
        // The dialog is gone and cannot be re-opened: end the wizard (nothing is undone).
        if (this.disposed) return;
        this.dispose();
        this.deps.onClosed?.("later");
      },
    });
    this.handle = {
      close: () => this.dispose(),
      focus: () => {
        if (!this.disposed) this.panel.focusPanel();
      },
    };
  }

  public start(): void {
    this.panel.show();
    this.panel.render(buildWizardView(this.state));
    this.dispatch({ type: "opened" });
  }

  /** Every state change goes through here. Events for a disposed instance are dropped. */
  private dispatch(event: WizardUserEvent | WizardSystemEvent): void {
    if (this.disposed) return;
    const stamped = { ...event, now: this.now() } as WizardEvent;
    const reduction = reduceWizard(this.state, stamped);
    this.state = reduction.state;
    // A throwing render must not strand the wizard: the state is already updated, the effects
    // still run, and later / Esc stay possible.
    this.guard(() => this.panel.render(buildWizardView(this.state)));
    for (const effect of reduction.effects) {
      if (this.disposed) return;
      this.guard(() => this.run(effect));
    }
  }

  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (this.deps.onError !== undefined) this.deps.onError(error);
      else console.error("Collector wizard error", error);
    }
  }

  private run(effect: WizardEffect): void {
    switch (effect.type) {
      case "request": {
        const { requestId } = effect;
        this.settle(
          () => this.deps.runCollectorIntegration(effect.request),
          (response) => {
            if (typeof response !== "object" || response === null) this.dispatch({ type: "requestFailed", requestId });
            else this.dispatch({ type: "response", requestId, response });
          },
          () => this.dispatch({ type: "requestFailed", requestId }),
        );
        break;
      }
      case "configureSaveDestination": {
        const { requestId } = effect;
        this.settle(
          () => this.deps.configureCollectorSaveDestination(),
          (result) => {
            if (typeof result !== "object" || result === null) this.dispatch({ type: "requestFailed", requestId });
            else this.dispatch({ type: "destinationResult", requestId, result });
          },
          () => this.dispatch({ type: "requestFailed", requestId }),
        );
        break;
      }
      case "copyText": {
        const { purpose, text } = effect;
        const write = this.deps.writeClipboardText ?? ((value: string) => this.panel.copyText(value));
        this.settle(
          () => write(text),
          (result) => this.dispatch({ type: "clipboardResult", purpose, ok: result !== false }),
          () => this.dispatch({ type: "clipboardResult", purpose, ok: false }),
        );
        break;
      }
      case "ticker":
        if (effect.active) {
          if (this.tickTimer === null) this.tickTimer = this.setIntervalFn(() => this.dispatch({ type: "tick" }), effect.intervalMs);
        } else {
          this.stopTicker();
        }
        break;
      case "focusHeading":
        this.raf(() => {
          if (!this.disposed) this.panel.focusHeading();
        });
        break;
      case "focusRadio": {
        // Rendering is synchronous, so the radio already exists: focus it directly.
        this.panel.focusRadio(effect.browser);
        break;
      }
      case "close": {
        const { outcome } = effect;
        this.dispose();
        this.deps.onClosed?.(outcome);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Run an async call (a sync throw counts as a rejection) and report back. The callbacks go through
   * `dispatch`, which drops everything once this instance is disposed.
   */
  private settle<T>(call: () => Promise<T> | T, onValue: (value: T) => void, onFailure: () => void): void {
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(call());
    } catch {
      pending = Promise.reject(new Error("call threw"));
    }
    pending.then(
      (value) => {
        if (!this.disposed) onValue(value);
      },
      () => {
        if (!this.disposed) onFailure();
      },
    );
  }

  private stopTicker(): void {
    if (this.tickTimer === null) return;
    this.clearIntervalFn(this.tickTimer);
    this.tickTimer = null;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTicker();
    this.panel.dispose();
    this.onDisposed();
  }
}
