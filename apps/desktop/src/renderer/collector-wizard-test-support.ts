/** Shared fixtures for the wizard panel tests (B3). Test-only: nothing in production imports this. */
import type { CollectorBrowserId } from "../collector-browser-table";
import type {
  CollectorBrowserSummary,
  CollectorConnectionSummary,
  CollectorIntegrationResponse,
  CollectorIntegrationStatus,
} from "../collector-integration-ipc";
import {
  initialWizardState,
  reduceWizard,
  type WizardEffect,
  type WizardState,
  type WizardSystemEvent,
  type WizardUserEvent,
} from "./collector-wizard-model";

export const T0 = 1_000_000;

export function entry(id: CollectorBrowserId, over: Partial<CollectorBrowserSummary> = {}): CollectorBrowserSummary {
  return {
    id,
    verification: id === "chrome" ? "verified" : "unverified",
    installed: "found",
    registration: "absent",
    registrationVia: null,
    policyBlocked: false,
    extensionLoadMayBeBlocked: false,
    extensionsAddress: `${id}://extensions`,
    ...over,
  };
}

export type StatusOverrides = Omit<Partial<CollectorIntegrationStatus>, "browsers"> & { browsers?: Partial<CollectorIntegrationStatus["browsers"]> };

export function status(over: StatusOverrides = {}): CollectorIntegrationStatus {
  const { browsers, ...rest } = over;
  return {
    applyInProgress: false,
    removeRequested: false,
    state: "not-set-up",
    reasons: [],
    inspectionComplete: true,
    registration: "absent",
    browsers: {
      defaultBrowser: "chrome",
      recommended: "chrome",
      recommendationReason: "default-supported",
      preferred: null,
      entries: [entry("edge"), entry("chrome"), entry("vivaldi")],
      ...browsers,
    },
    policy: { blocked: false, userLevelHostsDisabled: false, hostBlocked: false, extensionLoadMayBeBlocked: false },
    installed: { hostVersion: null, extensionVersion: null },
    payloadStatus: "valid",
    extensionFolderPlaced: true,
    writesAllowed: true,
    ...rest,
  };
}

export function statusResponse(over: StatusOverrides = {}): CollectorIntegrationResponse {
  return { kind: "status", status: status(over) };
}

export function applyResponse(over: Partial<Extract<CollectorIntegrationResponse, { kind: "apply" }>> = {}): CollectorIntegrationResponse {
  return { kind: "apply", action: "setup", outcome: "applied", reason: null, warnings: [], selfCheck: "ok", status: status({ state: "ready" }), ...over };
}

export function connection(summary: CollectorConnectionSummary): CollectorIntegrationResponse {
  return { kind: "connection", state: "ready", applyInProgress: false, connection: summary };
}

export const CONNECTED: CollectorConnectionSummary = {
  state: "connected",
  extensionVersion: "0.3.0",
  hostVersion: "0.2.0",
  contactedAt: "2026-11-20T00:00:00.000Z",
};

export interface Harness {
  state: WizardState;
  now: number;
  log: WizardEffect[];
}

export function start(): Harness {
  return { state: initialWizardState(), now: T0, log: [] };
}

export function send(h: Harness, event: WizardUserEvent | WizardSystemEvent, at?: number): readonly WizardEffect[] {
  if (at !== undefined) h.now = at;
  const reduction = reduceWizard(h.state, { ...event, now: h.now });
  h.state = reduction.state;
  h.log.push(...reduction.effects);
  return reduction.effects;
}

export function respond(h: Harness, response: CollectorIntegrationResponse): readonly WizardEffect[] {
  if (h.state.inFlight === null) throw new Error("no request in flight");
  return send(h, { type: "response", requestId: h.state.inFlight.requestId, response });
}

export function atStepA(over: StatusOverrides = {}): Harness {
  const h = start();
  send(h, { type: "opened" });
  respond(h, statusResponse(over));
  return h;
}

export function atStepB(over: StatusOverrides = {}): Harness {
  const h = atStepA(over);
  send(h, { type: "next" });
  return h;
}

export function atStepC(): Harness {
  const h = atStepB();
  send(h, { type: "register" });
  respond(h, applyResponse());
  send(h, { type: "next" });
  return h;
}

export function atStepD(placed = true): Harness {
  const h = atStepC();
  send(h, { type: "confirmDestination" });
  send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: true } });
  send(h, { type: "next" });
  respond(h, statusResponse({ state: "ready", extensionFolderPlaced: placed }));
  return h;
}

export function atStepE(): Harness {
  const h = atStepD();
  send(h, { type: "loaded" }, T0 + 10_000);
  return h;
}
