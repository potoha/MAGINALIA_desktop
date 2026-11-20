/**
 * Collector integration wizard: view description (S8 / WP-7 slice B, step B3, layer 1 of 3).
 *
 * `buildWizardView(state)` turns a `WizardState` into plain data that says WHAT the panel shows:
 * heading, progress text, content blocks, live-region messages and buttons. It never touches the
 * DOM, a clock or IPC, so every screen can be checked in a node test. The DOM adapter
 * (`collector-wizard-panel.ts`) only maps this data to elements. All words come from the model and
 * `collector-wizard-copy.ts`; nothing is written here.
 */
import {
  wizardActions,
  wizardAView,
  wizardConnectionView,
  wizardCopy,
  wizardDoneView,
  wizardInFlightNotice,
  wizardIsBusy,
  wizardMessage,
  wizardProgress,
  wizardStepDView,
  type WizardAction,
  type WizardRadioKey,
  type WizardState,
  type WizardUserEvent,
} from "./collector-wizard-model";
import type { WizardMessageRole } from "./collector-wizard-copy";
import type { CollectorBrowserId } from "../collector-browser-table";

/** One message in a live region (`status` is polite, `alert` is assertive). */
export interface WizardLiveMessage {
  readonly headline: string;
  readonly detail: string | null;
}

export interface WizardViewListItem {
  readonly text: string;
  /** A paragraph shown directly under the item (step D: the address note under instruction 1). */
  readonly note: string | null;
  /** Buttons (by `WizardViewButton.id`) rendered inside the item instead of the action area. */
  readonly inlineButtonIds: readonly string[];
}

export interface WizardViewRadio {
  readonly id: CollectorBrowserId;
  readonly label: string;
  /** 「組織の管理設定により使えません」 / 「確認できませんでした」, or `null`. */
  readonly note: string | null;
  readonly selectable: boolean;
  /** `aria-checked`. */
  readonly checked: boolean;
  /** Roving tabindex: exactly one selectable radio is tabbable (the selected one, else the first). */
  readonly tabbable: boolean;
  /** Dispatched by click / Space / Enter. `null` when not selectable. */
  readonly event: WizardUserEvent | null;
}

export type WizardViewBlock =
  | { readonly kind: "paragraph"; readonly text: string; readonly tone: "normal" | "muted" | "warning" }
  | { readonly kind: "list"; readonly ordered: boolean; readonly label: string | null; readonly items: readonly WizardViewListItem[] }
  | { readonly kind: "radiogroup"; readonly label: string; readonly options: readonly WizardViewRadio[] }
  | { readonly kind: "disclosure"; readonly summary: string; readonly detail: string }
  | { readonly kind: "callout"; readonly headline: string; readonly detail: string | null };

export interface WizardViewButton {
  /** `data-action`. */
  readonly id: string;
  readonly label: string;
  readonly primary: boolean;
  readonly enabled: boolean;
  /**
   * Where a disabled button's explanation lives: `busy` points at the status live region
   * (「状態を確認しています…」), `reason` at `WizardView.reasonText`. `null` when enabled.
   */
  readonly describedBy: "busy" | "reason" | null;
  /** `inline` buttons sit inside a list item; `tools` are side actions; `nav` are the step buttons. */
  readonly group: "inline" | "tools" | "nav";
  readonly event: WizardUserEvent;
}

export interface WizardView {
  readonly step: WizardState["step"];
  /** The accessible name of the dialog when no heading applies. */
  readonly dialogLabel: string;
  /** 「手順 n / 5」, or `null` on the last screen. */
  readonly progress: string | null;
  /** The step heading. Focus moves here on a step change. */
  readonly title: string;
  readonly busy: boolean;
  readonly blocks: readonly WizardViewBlock[];
  readonly live: { readonly status: readonly WizardLiveMessage[]; readonly alert: readonly WizardLiveMessage[] };
  /** Visible explanation for disabled buttons that are not simply busy, or `null`. */
  readonly reasonText: string | null;
  readonly buttons: readonly WizardViewButton[];
}

const TOOL_ACTION_IDS = new Set(["openBrowserExtensions", "copyPath", "revealFolder", "retryPlacement"]);

function groupOf(id: string, inlineIds: ReadonlySet<string>): WizardViewButton["group"] {
  if (inlineIds.has(id)) return "inline";
  if (TOOL_ACTION_IDS.has(id) || id.startsWith("openDownloadPage-")) return "tools";
  return "nav";
}

function paragraph(text: string, tone: "normal" | "muted" | "warning" = "normal"): WizardViewBlock {
  return { kind: "paragraph", text, tone };
}

function pushLive(
  live: { status: WizardLiveMessage[]; alert: WizardLiveMessage[] },
  role: WizardMessageRole,
  message: WizardLiveMessage,
): void {
  live[role].push(message);
}

function radioOptions(state: WizardState): readonly WizardViewRadio[] {
  const view = wizardAView(state);
  const firstSelectable = view.options.find((option) => option.selectable)?.id ?? null;
  const selectedSelectable = view.options.find((option) => option.selected && option.selectable)?.id ?? null;
  const tabbableId = selectedSelectable ?? firstSelectable;
  return view.options.map((option) => ({
    id: option.id,
    label: option.label,
    note: option.noteText,
    selectable: option.selectable,
    checked: option.selected,
    tabbable: option.id === tabbableId,
    event: option.selectable ? ({ type: "selectBrowser", browser: option.id } as const) : null,
  }));
}

export function isRadioKey(key: string): key is WizardRadioKey {
  return key === "ArrowDown" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowLeft" || key === "Home" || key === "End";
}

export function buildWizardView(state: WizardState): WizardView {
  const copy = wizardCopy(state);
  const busy = wizardIsBusy(state);
  const live: { status: WizardLiveMessage[]; alert: WizardLiveMessage[] } = { status: [], alert: [] };
  const blocks: WizardViewBlock[] = [];
  const inlineIds = new Set<string>();
  let title = "";
  let reasonText: string | null = null;

  const message = wizardMessage(state);
  if (message !== null) pushLive(live, message.role, { headline: message.copy.headline, detail: message.copy.detail });
  // The watchdog notice appears once (the alert region only re-announces when its content changes).
  const slow = wizardInFlightNotice(state);
  if (slow !== null) pushLive(live, slow.role, { headline: slow.copy.headline, detail: slow.copy.detail });

  switch (state.step) {
    case "A": {
      const a = wizardAView(state);
      title = a.title;
      blocks.push(paragraph(a.body));
      blocks.push({ kind: "list", ordered: false, label: null, items: a.bullets.map((text) => ({ text, note: null, inlineButtonIds: [] })) });
      blocks.push(paragraph(a.menuNote, "muted"));
      if (a.loading) {
        // The first inspection: the busy indicator is the live status line below.
      } else if (a.allBlocked && a.notice !== null) {
        pushLive(live, a.notice.role, { headline: a.notice.copy.headline, detail: a.notice.copy.detail });
      } else {
        if (a.reasonCopy !== null) {
          blocks.push({ kind: "callout", headline: a.reasonCopy.lead, detail: a.reasonCopy.detail });
        }
        if (a.previouslyChosen !== null) blocks.push(paragraph(a.previouslyChosen, "muted"));
      }
      if (a.options.length > 0) {
        blocks.push({ kind: "radiogroup", label: a.radiogroupLabel, options: radioOptions(state) });
      }
      break;
    }
    case "B":
      title = copy.stepB.title;
      blocks.push(paragraph(copy.stepB.intro));
      break;
    case "C":
      title = copy.stepC.title;
      blocks.push(paragraph(copy.stepC.intro));
      blocks.push(paragraph(copy.stepC.detail));
      break;
    case "D": {
      const d = wizardStepDView(state);
      title = d.title;
      blocks.push(paragraph(d.intro));
      if (d.placement === "checking") {
        // The busy status line (「状態を確認しています…」) covers this; the folder wording is the visible text.
        blocks.push(paragraph(d.checkingFolder, "muted"));
      } else if (d.placement === "placed") {
        blocks.push(paragraph(d.pathNote, "muted"));
        const hasAddressButton = state.selectedBrowser !== null;
        if (hasAddressButton) inlineIds.add("copyAddress");
        blocks.push({
          kind: "list",
          ordered: true,
          label: d.stepsLabel,
          items: d.steps.map((text, index) => ({
            text,
            note: index === d.addressNoteAfterStep - 1 ? d.addressNote : null,
            inlineButtonIds: index === d.addressNoteAfterStep - 1 && hasAddressButton ? ["copyAddress"] : [],
          })),
        });
        if (d.alternative !== null) blocks.push(paragraph(d.alternative));
        if (d.showPolicyWarning) blocks.push(paragraph(d.policyWarning, "warning"));
        blocks.push({ kind: "list", ordered: false, label: d.cautionsLabel, items: d.cautions.map((text) => ({ text, note: null, inlineButtonIds: [] })) });
        blocks.push({ kind: "disclosure", summary: d.multiBrowserSummary, detail: d.multiBrowserNote });
      }
      break;
    }
    case "E": {
      const e = wizardConnectionView(state);
      title = copy.stepE.title;
      if (e !== null) {
        pushLive(live, e.role, { headline: e.headline, detail: e.detail });
        if (e.checklist !== null) {
          blocks.push({ kind: "list", ordered: false, label: e.checklistLabel, items: e.checklist.map((text) => ({ text, note: null, inlineButtonIds: [] })) });
        }
        if (e.destinationLine !== null) blocks.push(paragraph(e.destinationLine));
        if (e.howToOpen !== null) blocks.push({ kind: "disclosure", summary: e.howToOpen.summary, detail: e.howToOpen.detail });
      }
      break;
    }
    case "done": {
      const done = wizardDoneView(state);
      title = done.title;
      blocks.push(paragraph(done.body));
      break;
    }
    default:
      break;
  }

  if (busy) {
    // The busy line is the reason every disabled button is disabled (aria-describedby points here).
    live.status.push({ headline: copy.common.loading, detail: null });
  } else if (state.step === "A" && state.statusLoad === "loading") {
    live.status.push({ headline: copy.common.loading, detail: null });
  }

  const actions = wizardActions(state);
  const buttons = actions.map((action: WizardAction): WizardViewButton => {
    let describedBy: WizardViewButton["describedBy"] = null;
    if (!action.enabled) {
      if (busy || (state.step === "A" && state.statusLoad === "loading")) {
        describedBy = "busy";
      } else if (state.step === "A" && (action.id === "next" || action.id === "continueWithoutBrowser")) {
        describedBy = "reason";
        reasonText = copy.stepA.selectBrowserFirst;
      }
    }
    return {
      id: action.id,
      label: action.label,
      primary: action.primary,
      enabled: action.enabled,
      describedBy,
      group: groupOf(action.id, inlineIds),
      event: action.event,
    };
  });

  return {
    step: state.step,
    dialogLabel: copy.dialogLabel,
    progress: wizardProgress(state),
    title,
    busy,
    blocks,
    live,
    reasonText,
    buttons,
  };
}
