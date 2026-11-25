import { describe, expect, it } from "vitest";
import { WIZARD_INFLIGHT_CANCEL_MS, initialWizardState, isWizardEventAllowed, moveRadioSelection, reduceWizard, wizardBrowserOptions, type WizardState } from "./collector-wizard-model";
import { buildWizardView, isRadioKey, type WizardView } from "./collector-wizard-view";
import {
  CONNECTED,
  T0,
  applyResponse,
  atStepA,
  atStepB,
  atStepC,
  atStepD,
  atStepE,
  connection,
  entry,
  respond,
  send,
  start,
  status,
  type Harness,
} from "./collector-wizard-test-support";

function allText(view: WizardView): string[] {
  const out: string[] = [view.title, view.dialogLabel];
  if (view.progress !== null) out.push(view.progress);
  for (const message of [...view.live.status, ...view.live.alert]) {
    out.push(message.headline);
    if (message.detail !== null) out.push(message.detail);
  }
  if (view.reasonText !== null) out.push(view.reasonText);
  for (const block of view.blocks) {
    switch (block.kind) {
      case "paragraph":
        out.push(block.text);
        break;
      case "callout":
        out.push(block.headline);
        if (block.detail !== null) out.push(block.detail);
        break;
      case "list":
        if (block.label !== null) out.push(block.label);
        for (const item of block.items) {
          out.push(item.text);
          if (item.note !== null) out.push(item.note);
        }
        break;
      case "radiogroup":
        out.push(block.label);
        for (const option of block.options) {
          out.push(option.label);
          if (option.note !== null) out.push(option.note);
        }
        break;
      case "disclosure":
        out.push(block.summary, block.detail);
        break;
    }
  }
  for (const button of view.buttons) out.push(button.label);
  return out;
}

function expectClean(view: WizardView): void {
  for (const text of allText(view)) {
    expect(text.length, JSON.stringify(text)).toBeGreaterThan(0);
    expect(text).not.toMatch(/\{[A-Za-z]+\}/);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    expect(text).not.toContain("[object");
    expect(text).not.toMatch(/[A-Za-z]:\\/);
  }
  expect(view.title.length).toBeGreaterThan(0);
  const ids = view.buttons.map((button) => button.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const block of view.blocks) {
    if (block.kind !== "list") continue;
    for (const item of block.items) for (const id of item.inlineButtonIds) expect(ids).toContain(id);
  }
}

const view = (h: Harness): WizardView => buildWizardView(h.state);
const labels = (v: WizardView): string[] => v.buttons.map((button) => button.label);

function radiogroupOf(v: WizardView) {
  const group = v.blocks.find((block) => block.kind === "radiogroup");
  if (group?.kind !== "radiogroup") throw new Error("expected a radiogroup");
  return group;
}

describe("wizard view: step A", () => {
  it("while loading: heading, busy status, no radiogroup, buttons disabled and pointing at the status", () => {
    const h = start();
    send(h, { type: "opened" });
    const v = view(h);
    expect(v.step).toBe("A");
    expect(v.progress).toBe("手順 1 / 5");
    expect(v.busy).toBe(true);
    expect(v.live.status).toEqual([{ headline: "状態を確認しています…", detail: null }]);
    expect(v.live.alert).toEqual([]);
    expect(v.blocks.some((block) => block.kind === "radiogroup")).toBe(false);
    // Everything is disabled except 「あとで設定」, which may still leave while only the first look runs.
    expect(v.buttons.filter((button) => !button.enabled).every((button) => button.describedBy === "busy")).toBe(true);
    expect(v.buttons.filter((button) => button.enabled).map((button) => button.id)).toEqual(["later"]);
    expectClean(v);
  });

  it("the initial state before `opened` is also a clean view", () => {
    expectClean(buildWizardView(initialWizardState()));
  });

  it("ready: radiogroup with the recommendation selected and tabbable, 次へ enabled, no reason text", () => {
    const v = view(atStepA());
    const group = radiogroupOf(v);
    expect(group.label).toBe("Collector を使うブラウザー");
    const chrome = group.options.find((option) => option.id === "chrome")!;
    expect(chrome).toMatchObject({ checked: true, tabbable: true, selectable: true });
    expect(chrome.label).toContain("おすすめ");
    expect(group.options.filter((option) => option.tabbable)).toHaveLength(1);
    expect(chrome.event).toEqual({ type: "selectBrowser", browser: "chrome" });
    expect(v.buttons.find((button) => button.id === "next")).toMatchObject({ enabled: true, primary: true, describedBy: null });
    expect(v.reasonText).toBeNull();
    expect(v.busy).toBe(false);
    expect(v.live.status).toEqual([]);
    expectClean(v);
  });

  it("no selection: one selectable radio is the single tab stop and 次へ explains why it is disabled", () => {
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "default-unsupported", entries: [entry("chrome"), entry("edge", { verification: "verified" })] } });
    const v = view(h);
    const group = radiogroupOf(v);
    expect(group.options.every((option) => !option.checked)).toBe(true);
    expect(group.options.filter((option) => option.tabbable)).toHaveLength(1);
    expect(group.options.find((option) => option.tabbable)?.selectable).toBe(true);
    const next = v.buttons.find((button) => button.id === "next")!;
    expect(next.enabled).toBe(false);
    expect(next.describedBy).toBe("reason");
    expect(v.reasonText).toBe("ブラウザーを選ぶと、次へ進めます。");
    expectClean(v);
  });

  it("arrow keys: the radioKey event keeps the selection on a single option and asks to focus the radio", () => {
    // Only Chrome is verified today, so the ring has one member: every key lands on it.
    const h = atStepA();
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"] as const) {
      const effects = send(h, { type: "radioKey", key });
      expect(h.state.selectedBrowser).toBe("chrome");
      expect(effects).toContainEqual({ type: "focusRadio", browser: "chrome" });
    }
  });

  it("arrow keys move forward and backward and wrap over several selectable options (view follows the model)", () => {
    const options = [
      { id: "edge", recommended: false, selectable: true, note: null },
      { id: "chrome", recommended: true, selectable: true, note: null },
      { id: "vivaldi", recommended: false, selectable: false, note: "policy-blocked" },
    ] as const;
    expect(moveRadioSelection(options, "chrome", "ArrowDown")).toBe("edge");
    expect(moveRadioSelection(options, "edge", "ArrowUp")).toBe("chrome");
    expect(moveRadioSelection(options, "edge", "ArrowRight")).toBe("chrome");
    expect(moveRadioSelection(options, "chrome", "ArrowLeft")).toBe("edge");
    expect(moveRadioSelection(options, "chrome", "Home")).toBe("edge");
    expect(moveRadioSelection(options, "edge", "End")).toBe("chrome");
    expect(moveRadioSelection(options, null, "ArrowDown")).toBe("edge");
    expect(moveRadioSelection(options, null, "ArrowUp")).toBe("chrome");
  });

  it("isRadioKey accepts exactly the six keys", () => {
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]) expect(isRadioKey(key)).toBe(true);
    for (const key of ["Tab", " ", "Enter", "a"]) expect(isRadioKey(key)).toBe(false);
  });

  it("all browsers blocked: one live notice, nothing selectable, no 次へ", () => {
    const h = atStepA({
      state: "policy-blocked",
      browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("edge", { verification: "verified", policyBlocked: true }), entry("chrome", { policyBlocked: true }), entry("vivaldi")] },
    });
    const v = view(h);
    expect(v.live.alert.length + v.live.status.length).toBe(1);
    expect(v.buttons.some((button) => button.id === "next")).toBe(false);
    expect(v.buttons.some((button) => button.id === "recheckBrowsers")).toBe(true);
    const group = v.blocks.find((block) => block.kind === "radiogroup");
    if (group?.kind === "radiogroup") {
      expect(group.options.every((option) => !option.selectable && !option.tabbable && option.event === null)).toBe(true);
    }
    expectClean(v);
  });

  it("none installed: download buttons are tools, continue is a step button", () => {
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { installed: "not-found" })] } });
    const v = view(h);
    expect(v.buttons.some((button) => button.id.startsWith("openDownloadPage-") && button.group === "tools")).toBe(true);
    expect(v.buttons.find((button) => button.id === "continueWithoutBrowser")?.group).toBe("nav");
    expectClean(v);
  });

  it("detection failed: a verified browser is an option marked 確認できませんでした", () => {
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "detection-failed", entries: [entry("chrome", { installed: "unknown" })] } });
    const v = view(h);
    expect(radiogroupOf(v).options.some((option) => option.note === "確認できませんでした")).toBe(true);
    expectClean(v);
  });

  it("a failed first inspection is an alert with a retry", () => {
    const h = start();
    send(h, { type: "opened" });
    respond(h, { kind: "error" });
    const v = view(h);
    expect(h.state.statusLoad).toBe("failed");
    expect(v.live.alert).toHaveLength(1);
    expect(labels(v)).toContain("もう一度確認");
    expect(v.buttons.every((button) => button.enabled)).toBe(true);
    expectClean(v);
  });

  it("an unavailable environment (terminal) offers only あとで設定", () => {
    const h = start();
    send(h, { type: "opened" });
    respond(h, { kind: "unavailable", reason: "e2e-isolation" });
    const v = view(h);
    expect(labels(v)).toEqual(["あとで設定"]);
    expect(v.live.alert).toHaveLength(1);
    expectClean(v);
  });
});

describe("wizard view: steps B and C", () => {
  it("B: no live message at the start, the register button is primary, progress 2/5", () => {
    const v = view(atStepB());
    expect(v.progress).toBe("手順 2 / 5");
    expect(v.live).toEqual({ status: [], alert: [] });
    expect(v.buttons.find((button) => button.primary)?.label).toBe("連携プログラムを登録する");
    expect(labels(v)).toEqual(expect.arrayContaining(["戻る", "あとで設定"]));
    expectClean(v);
  });

  it("B busy: disabled buttons point at the busy status; あとで設定 is disabled while registering", () => {
    const h = atStepB();
    send(h, { type: "register" });
    const v = view(h);
    expect(v.busy).toBe(true);
    expect(v.live.status.at(-1)?.headline).toBe("状態を確認しています…");
    for (const button of v.buttons) {
      expect(button.enabled).toBe(isWizardEventAllowed(h.state, button.event));
      if (!button.enabled) expect(button.describedBy).toBe("busy");
    }
    expect(v.buttons.find((button) => button.id === "later")?.enabled).toBe(false);
    expectClean(v);
  });

  it("B success is a polite status with 次へ", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, applyResponse());
    const v = view(h);
    expect(v.live.status).toHaveLength(1);
    expect(v.live.alert).toEqual([]);
    expect(v.buttons.find((button) => button.id === "next")?.enabled).toBe(true);
    expectClean(v);
  });

  it("B outdated-pending is a status and lets the user go on", () => {
    const h = atStepB({ state: "outdated" });
    send(h, { type: "register" });
    const v = view(h);
    expect(v.live.status.some((message) => (message.detail ?? "").includes("次回起動時"))).toBe(true);
    expect(v.buttons.find((button) => button.id === "next")?.enabled).toBe(true);
    expectClean(v);
  });

  it("B outdated with a remove requested says the update is paused, not 次回起動時 (B-3)", () => {
    const h = atStepB({ state: "outdated", removeRequested: true });
    send(h, { type: "register" });
    const v = view(h);
    const text = v.live.status.map((message) => `${message.headline}${message.detail ?? ""}`).join("");
    expect(text).toContain("解除の途中で止まっています");
    expect(text).not.toContain("次回起動時");
    expect(v.buttons.find((button) => button.id === "next")?.enabled).toBe(true);
    expectClean(v);
  });

  it("B paused: the cancel button sits before the primary 次へ (戻る, あとで設定, 解除を取りやめる, 次へ) and is a plain nav button", () => {
    const h = atStepB({ state: "outdated", removeRequested: true });
    send(h, { type: "register" });
    const v = view(h);
    expect(v.buttons.map((button) => [button.id, button.label])).toEqual([
      ["back", "戻る"],
      ["later", "あとで設定"],
      ["cancelRemove", "解除を取りやめる"],
      ["next", "次へ"],
    ]);
    expect(v.buttons.find((button) => button.id === "cancelRemove")).toMatchObject({ primary: false, enabled: true, group: "nav", describedBy: null, event: { type: "cancelRemove" } });
    expect(v.buttons.find((button) => button.id === "next")).toMatchObject({ primary: true, enabled: true });
    expect(v.live.alert).toEqual([]);
    expectClean(v);
  });

  it("B while the cancel runs: the button stays (disabled with the busy explanation) and the step is busy", () => {
    const h = atStepB({ state: "outdated", removeRequested: true });
    send(h, { type: "register" });
    send(h, { type: "cancelRemove" });
    const v = view(h);
    expect(v.busy).toBe(true);
    expect(v.buttons.find((button) => button.id === "cancelRemove")).toMatchObject({ enabled: false, describedBy: "busy" });
    expect(v.buttons.find((button) => button.id === "next")).toMatchObject({ enabled: false, describedBy: "busy" });
    expectClean(v);
  });

  it("B cancel answered: cleared is a status that names the next start; unchanged is an alert with one retry button", () => {
    const cleared = atStepB({ state: "outdated", removeRequested: true });
    send(cleared, { type: "register" });
    send(cleared, { type: "cancelRemove" });
    respond(cleared, { kind: "cancel-remove", result: "cleared" });
    const v = view(cleared);
    expect(v.live.status.map((message) => message.headline)).toContain("解除を取りやめました。");
    expect(v.live.status.map((message) => message.detail ?? "").join("")).toContain("次回起動時");
    expect(v.live.alert).toEqual([]);
    expect(labels(v)).toEqual(["戻る", "あとで設定", "次へ"]);
    expectClean(v);

    const failed = atStepB({ state: "outdated", removeRequested: true });
    send(failed, { type: "register" });
    send(failed, { type: "cancelRemove" });
    respond(failed, { kind: "cancel-remove", result: "unchanged" });
    const w = view(failed);
    expect(w.live.alert).toEqual([expect.objectContaining({ headline: "解除の取りやめを保存できませんでした。" })]);
    expect(w.live.status).toEqual([]);
    expect(w.buttons.map((button) => [button.id, button.label, button.primary])).toEqual([
      ["back", "戻る", false],
      ["later", "あとで設定", false],
      ["cancelRemove", "もう一度試す", true],
    ]);
    expectClean(w);
  });

  it("B self-check-failed is an alert; only 戻る and 閉じる remain (no register, no 次へ)", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, applyResponse({ outcome: "failed", reason: "self-check-failed", selfCheck: "failed", status: status({ state: "damaged" }) }));
    const v = view(h);
    expect(v.live.alert).toHaveLength(1);
    expect(v.live.status).toEqual([]);
    expect(labels(v)).toEqual(["戻る", "閉じる"]);
    expect(v.live.alert[0]!.detail).toContain("開き直して");
    expectClean(v);
  });

  it("B foreign registration asks for the explicit switch", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, applyResponse({ outcome: "refused", reason: "foreign-confirmation-required", status: status({ state: "foreign-registration" }) }));
    const v = view(h);
    expect(v.live.alert).toHaveLength(1);
    expect(labels(v)).toEqual(expect.arrayContaining(["切り替える", "やめる"]));
    expectClean(v);
  });

  it("C: two paragraphs, a primary confirm, then a configured result with 次へ", () => {
    const h = atStepC();
    let v = view(h);
    expect(v.progress).toBe("手順 3 / 5");
    expect(v.blocks.filter((block) => block.kind === "paragraph")).toHaveLength(2);
    expect(v.buttons.find((button) => button.id === "confirmDestination")?.primary).toBe(true);
    expectClean(v);
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: true } });
    v = view(h);
    expect(v.live.status).toHaveLength(1);
    expect(v.buttons.find((button) => button.id === "next")?.enabled).toBe(true);
    expectClean(v);
  });

  it("C with writes disabled keeps its own 次へ wording", () => {
    const h = atStepC();
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: false } });
    const v = view(h);
    expect(labels(v)).toContain("次へ（保存は無効のまま）");
    expectClean(v);
  });
});

describe("wizard view: steps D and E and the done screen", () => {
  it("D while checking the folder: no instruction list yet", () => {
    const h = atStepC();
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: true } });
    send(h, { type: "next" });
    const v = view(h);
    expect(h.state.placement).toBe("checking");
    expect(v.blocks.some((block) => block.kind === "list")).toBe(false);
    expect(v.busy).toBe(true);
    expectClean(v);
  });

  it("D folder missing: an alert and a retry tool", () => {
    const h = atStepD(false);
    const v = view(h);
    expect(h.state.placement).toBe("missing");
    expect(v.live.alert).toHaveLength(1);
    expect(v.buttons.find((button) => button.id === "retryPlacement")?.group).toBe("tools");
    expectClean(v);
  });

  it("D placed: five ordered steps, the address note and copy-address button inside item 1", () => {
    const v = view(atStepD());
    const steps = v.blocks.find((block) => block.kind === "list" && block.ordered);
    if (steps?.kind !== "list") throw new Error("steps");
    expect(steps.items).toHaveLength(5);
    expect(steps.items[0]!.note).not.toBeNull();
    expect(steps.items[0]!.inlineButtonIds).toEqual(["copyAddress"]);
    expect(steps.items.slice(1).every((item) => item.note === null && item.inlineButtonIds.length === 0)).toBe(true);
    expect(v.buttons.find((button) => button.id === "copyAddress")?.group).toBe("inline");
    for (const id of ["openBrowserExtensions", "copyPath", "revealFolder"]) expect(v.buttons.find((button) => button.id === id)?.group).toBe("tools");
    expect(v.buttons.find((button) => button.id === "loaded")).toMatchObject({ primary: true, group: "nav" });
    expect(v.blocks.some((block) => block.kind === "disclosure")).toBe(true);
    expectClean(v);
  });

  it("D after copying the address: a status on success, an alert on failure", () => {
    const h = atStepD();
    send(h, { type: "copyAddress" });
    send(h, { type: "clipboardResult", purpose: "address", ok: true });
    expect(view(h).live.status).toHaveLength(1);
    send(h, { type: "copyAddress" });
    send(h, { type: "clipboardResult", purpose: "address", ok: false });
    expect(view(h).live.alert).toHaveLength(1);
    expectClean(view(h));
  });

  it("E waiting: polite status, how-to-open disclosure, 戻る / あとで設定", () => {
    const v = view(atStepE());
    expect(v.progress).toBe("手順 5 / 5");
    expect(v.live.status).toHaveLength(1);
    expect(v.live.alert).toEqual([]);
    expect(v.blocks.some((block) => block.kind === "disclosure")).toBe(true);
    expect(labels(v)).toEqual(["戻る", "あとで設定"]);
    expectClean(v);
  });

  it("E connected: status, the destination line, 完了 primary and no あとで設定", () => {
    const h = atStepE();
    respond(h, connection(CONNECTED));
    const v = view(h);
    expect(v.live.status).toHaveLength(1);
    expect(v.live.alert).toEqual([]);
    expect(v.blocks.some((block) => block.kind === "paragraph" && block.text.startsWith("保存先"))).toBe(true);
    expect(v.buttons.find((button) => button.id === "finish")?.primary).toBe(true);
    expect(v.buttons.find((button) => button.id === "later")).toBeUndefined();
    expectClean(v);
  });

  it("E version differs: an alert naming both versions and a re-check", () => {
    const h = atStepE();
    respond(h, connection({ state: "extension-version-differs", loadedVersion: "0.3.0", placedVersion: "0.4.0" }));
    const v = view(h);
    expect(v.live.alert).toHaveLength(1);
    expect(v.live.alert[0]!.headline).toContain("0.3.0");
    expect(v.live.alert[0]!.headline).toContain("0.4.0");
    expect(labels(v)).toContain("もう一度確認");
    expectClean(v);
  });

  it("E timed out: an alert, a checklist, wait-again and the explicit confirmation", () => {
    const h = atStepE();
    send(h, { type: "tick" }, T0 + 10_000 + 180_000);
    const v = view(h);
    expect(h.state.connection?.phase).toBe("timed-out");
    expect(v.live.alert).toHaveLength(1);
    const checklist = v.blocks.find((block) => block.kind === "list");
    if (checklist?.kind !== "list") throw new Error("checklist");
    expect(checklist.items.length).toBeGreaterThan(0);
    expect(v.buttons.map((button) => button.id)).toEqual(expect.arrayContaining(["waitAgain", "userConfirmed"]));
    expectClean(v);
  });

  it("E protocol differs: an alert and only 閉じる", () => {
    const h = atStepE();
    respond(h, connection({ state: "protocol-differs" }));
    const v = view(h);
    expect(v.live.alert).toHaveLength(1);
    expect(labels(v)).toEqual(["閉じる"]);
    expectClean(v);
  });

  it("E unavailable, user-confirmed, then the done screen that is not shown as verified", () => {
    const h = atStepE();
    respond(h, connection({ state: "unavailable" }));
    expect(view(h).live.alert).toHaveLength(1);
    expectClean(view(h));
    send(h, { type: "userConfirmed" });
    expect(view(h).live.status).toHaveLength(1);
    send(h, { type: "finish" });
    const done = view(h);
    expect(done.step).toBe("done");
    expect(done.progress).toBeNull();
    expect(done.live).toEqual({ status: [], alert: [] });
    expect(labels(done)).toEqual(["閉じる"]);
    expectClean(done);

    const verified = atStepE();
    respond(verified, connection(CONNECTED));
    send(verified, { type: "finish" });
    const verifiedView = view(verified);
    expect(verifiedView.title).not.toBe(done.title);
    expectClean(verifiedView);
  });

  it("C destination-error and destination-busy show exactly the three buttons, with 保存先を選び直す dispatching its own event", () => {
    for (const result of [{ kind: "error" }, { kind: "busy" }] as const) {
      const h = atStepC();
      send(h, { type: "confirmDestination" });
      send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: result as never });
      const v = view(h);
      expect(labels(v)).toEqual(["保存先を選び直す", "Collector のセットアップをキャンセル", "もう一度試す"]);
      expect(v.buttons.map((button) => button.event.type)).toEqual(["chooseDestinationAgain", "later", "confirmDestination"]);
      expect(v.buttons.every((button) => button.enabled)).toBe(true);
      expect(v.live.alert).toHaveLength(1);
      expectClean(v);
    }
  });

  it("the slow-response alert and 「キャンセル」 appear only after 3 minutes of a blocking request", () => {
    const h = atStepB();
    send(h, { type: "register" });
    expect(view(h).live.alert).toEqual([]);
    expect(labels(view(h))).not.toContain("キャンセル");
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS - 1);
    expect(view(h).live.alert).toEqual([]);
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS);
    const v = view(h);
    expect(v.live.alert).toHaveLength(1);
    expect(v.live.alert[0]!.headline).toBe("応答に時間がかかっています。");
    const cancel = v.buttons.find((button) => button.id === "cancelInFlight")!;
    expect(cancel.label).toBe("キャンセル");
    expect(cancel.enabled).toBe(true);
    expect(cancel.event).toEqual({ type: "cancelInFlight" });
    expect(cancel.group).toBe("nav");
    // A later tick leaves the view data identical (nothing to re-announce).
    send(h, { type: "tick" }, T0 + WIZARD_INFLIGHT_CANCEL_MS + 5_000);
    expect(view(h)).toEqual(v);
  });

  it("every button's enabled flag equals what the model allows", () => {
    for (const make of [atStepA, atStepB, atStepC, () => atStepD(), atStepE]) {
      const h = make();
      for (const button of view(h).buttons) expect(button.enabled).toBe(isWizardEventAllowed(h.state, button.event));
    }
  });

  it("a closed state still renders a clean view", () => {
    const h = atStepB();
    const closed: WizardState = reduceWizard(h.state, { type: "later", now: T0 }).state;
    expect(closed.closed).toBe("later");
    expectClean(buildWizardView(closed));
  });
});

describe("wizard view: button order (戻る → あとで → その他 → 主操作)", () => {
  // Shared rule: rank 0 = back, 1 = later, 2 = secondary, 3 = primary. DOM order is Tab order.
  const rankOf = (button: WizardView["buttons"][number]): number => (button.id === "back" ? 0 : button.id === "later" ? 1 : button.primary ? 3 : 2);
  const ids = (v: WizardView): string[] => v.buttons.filter((button) => button.group !== "inline").map((button) => button.id);
  const expectOrdered = (v: WizardView): void => {
    const ranks = v.buttons.filter((button) => button.group !== "inline").map(rankOf);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  };

  it("A: あとで before the primary 次へ", () => {
    const v = view(atStepA());
    expect(ids(v)).toEqual(["later", "next"]);
    expectOrdered(v);
  });

  it("A without any installed browser: あとで, the download/recheck/continue side actions, no primary", () => {
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { installed: "not-found" })] } });
    const v = view(h);
    expect(ids(v)[0]).toBe("later");
    expectOrdered(v);
  });

  it("B: 戻る, あとで, then the primary register", () => {
    const v = view(atStepB());
    expect(ids(v)).toEqual(["back", "later", "register"]);
    expectOrdered(v);
  });

  it("C before confirming: 戻る, あとで, then the primary confirm", () => {
    const v = view(atStepC());
    expect(ids(v)).toEqual(["back", "later", "confirmDestination"]);
    expectOrdered(v);
  });

  it("C configured: 戻る, あとで, then the primary 次へ", () => {
    const h = atStepC();
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: true } });
    const v = view(h);
    expect(ids(v)).toEqual(["back", "later", "next"]);
    expectOrdered(v);
  });

  it("C destination-error / destination-busy: no 戻る / あとで, the primary retry is last", () => {
    for (const kind of ["error", "busy"] as const) {
      const h = atStepC();
      send(h, { type: "confirmDestination" });
      send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind } as never });
      expect(ids(view(h))).toEqual(["chooseDestinationAgain", "cancelSetup", "confirmDestination"]);
    }
  });

  it("D placed: 戻る, あとで, the tools (secondary), then the primary 読み込んだ", () => {
    const v = view(atStepD());
    const order = ids(v);
    expect(order.slice(0, 2)).toEqual(["back", "later"]);
    expect(order[order.length - 1]).toBe("loaded");
    expect(order).toContain("copyPath");
    expectOrdered(v);
  });

  it("D folder missing: 戻る, あとで, then the primary retry", () => {
    const v = view(atStepD(false));
    expect(ids(v)).toEqual(["back", "later", "retryPlacement"]);
  });

  it("E waiting: 戻る, あとで", () => {
    const v = view(atStepE());
    expect(ids(v)).toEqual(["back", "later"]);
  });

  it("E timed out: 戻る, あとで, the confirmation (secondary), then the primary wait-again", () => {
    const h = atStepE();
    send(h, { type: "tick" }, T0 + 10_000 + 180_000);
    expect(ids(view(h))).toEqual(["back", "later", "userConfirmed", "waitAgain"]);
  });

  it("E connected: 戻る, then the primary finish", () => {
    const h = atStepE();
    respond(h, connection(CONNECTED));
    const v = view(h);
    expect(ids(v)).toEqual(["back", "finish"]);
  });
});
