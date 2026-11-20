/**
 * Collector integration wizard: DOM adapter (S8 / WP-7 slice B, step B3, layer 2 of 3).
 *
 * A thin mapping from a `WizardView` to elements inside one modal `<dialog>`. It owns no wizard
 * logic: user input leaves through `onEvent` (a `WizardUserEvent`, without `now`), and the
 * controller (`collector-wizard-controller.ts`) decides what happens. Words come from the view.
 *
 * Accessibility (design 4.7): labelled dialog; the heading is `tabindex="-1"` and takes focus on a
 * step change; `role="status"` (polite) and `role="alert"` live regions exist from the start and
 * are only edited when their content changes (so polling never re-announces); the browser list is
 * a `radiogroup` with a roving tabindex and arrow-key movement; every action is a real `<button>`
 * with a text label; Tab is trapped inside the dialog; Escape is routed to the model, never to the
 * native dialog cancel. Real rendering is checked by hand (B5); node tests only use a stub document.
 */
import type { CollectorBrowserId } from "../collector-browser-table";
import type { WizardUserEvent } from "./collector-wizard-model";
import { isRadioKey, type WizardView, type WizardViewButton, type WizardViewListItem } from "./collector-wizard-view";

export interface WizardPanelOptions {
  readonly document: Document;
  /** Called for every user action (click, key). The controller stamps `now`. */
  readonly onEvent: (event: WizardUserEvent) => void;
}

export interface WizardPanel {
  /** Append and open the modal dialog; remembers the previously focused element. */
  show(): void;
  render(view: WizardView): void;
  focusHeading(): void;
  focusRadio(browser: CollectorBrowserId): void;
  /** Bring an already open panel back to the user: focus stays where it is, or goes to the heading. */
  focusPanel(): void;
  /** Copy a fixed address to the clipboard (Clipboard API, then a selection fallback inside the dialog). */
  copyText(text: string): Promise<boolean>;
  /** Close and remove the dialog, drop every listener, return focus to where it was. */
  dispose(): void;
}

export type WizardPanelFactory = (options: WizardPanelOptions) => WizardPanel;

const IDS = {
  dialog: "collector-wizard",
  heading: "collector-wizard-title",
  progress: "collector-wizard-progress",
  status: "collector-wizard-status",
  alert: "collector-wizard-alert",
  reason: "collector-wizard-reason",
} as const;

export const createWizardPanel: WizardPanelFactory = (options) => new DomWizardPanel(options);

class DomWizardPanel implements WizardPanel {
  private readonly doc: Document;
  private readonly dialog: HTMLDialogElement;
  private readonly progress: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly statusRegion: HTMLElement;
  private readonly alertRegion: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly keydownListener: (event: KeyboardEvent) => void;
  private readonly keyupListener: () => void;
  private readonly cancelListener: (event: Event) => void;

  private previousFocus: HTMLElement | null = null;
  private contentKey = "";
  private statusKey = "";
  private alertKey = "";
  /** Focusable elements in DOM order (heading excluded), rebuilt on every content render. */
  private focusables: HTMLElement[] = [];
  private readonly byFocusKey = new Map<string, HTMLElement>();
  private readonly radios = new Map<CollectorBrowserId, HTMLElement>();
  private escapeKeyDown = false;
  private disposed = false;

  public constructor(private readonly options: WizardPanelOptions) {
    const doc = options.document;
    this.doc = doc;
    this.dialog = doc.createElement("dialog");
    this.dialog.id = IDS.dialog;
    this.dialog.className = "collector-wizard";
    this.dialog.setAttribute("aria-labelledby", IDS.heading);

    const shell = doc.createElement("div");
    shell.className = "collector-wizard-shell";

    this.progress = doc.createElement("p");
    this.progress.id = IDS.progress;
    this.progress.className = "collector-wizard-progress";

    this.heading = doc.createElement("h2");
    this.heading.id = IDS.heading;
    this.heading.className = "collector-wizard-title";
    this.heading.setAttribute("tabindex", "-1");

    this.statusRegion = doc.createElement("div");
    this.statusRegion.id = IDS.status;
    this.statusRegion.className = "collector-wizard-live collector-wizard-live-status";
    this.statusRegion.setAttribute("role", "status");
    this.statusRegion.setAttribute("aria-live", "polite");
    this.statusRegion.setAttribute("aria-atomic", "true");

    this.alertRegion = doc.createElement("div");
    this.alertRegion.id = IDS.alert;
    this.alertRegion.className = "collector-wizard-live collector-wizard-live-alert";
    this.alertRegion.setAttribute("role", "alert");

    this.body = doc.createElement("div");
    this.body.className = "collector-wizard-body";
    this.actions = doc.createElement("div");
    this.actions.className = "collector-wizard-actions";

    shell.append(this.progress, this.heading, this.statusRegion, this.alertRegion, this.body, this.actions);
    this.dialog.append(shell);

    this.keydownListener = (event) => this.onKeyDown(event);
    this.keyupListener = () => {
      this.escapeKeyDown = false;
    };
    this.cancelListener = (event) => {
      // The native cancel (Esc) must never close the dialog by itself: the model decides.
      event.preventDefault();
      if (!this.escapeKeyDown) this.options.onEvent({ type: "escape" });
    };
    this.dialog.addEventListener("keydown", this.keydownListener, true);
    this.dialog.addEventListener("keyup", this.keyupListener, true);
    this.dialog.addEventListener("cancel", this.cancelListener);
  }

  public show(): void {
    const active = this.doc.activeElement;
    this.previousFocus = active !== null && typeof (active as HTMLElement).focus === "function" ? (active as HTMLElement) : null;
    this.doc.body.append(this.dialog);
    this.dialog.showModal();
  }

  public render(view: WizardView): void {
    if (this.disposed) return;
    this.setText(this.heading, view.title);
    this.progress.hidden = view.progress === null;
    this.setText(this.progress, view.progress ?? "");
    if (view.progress === null) this.dialog.removeAttribute("aria-describedby");
    else this.dialog.setAttribute("aria-describedby", IDS.progress);
    this.dialog.setAttribute("aria-busy", String(view.busy));

    this.renderLive(this.statusRegion, view.live.status, "status");
    this.renderLive(this.alertRegion, view.live.alert, "alert");

    const key = JSON.stringify([view.blocks, view.buttons, view.reasonText, view.busy]);
    if (key === this.contentKey) return;
    this.contentKey = key;
    const focusedKey = this.focusedKey();
    this.rebuildContent(view);
    if (focusedKey !== null) this.byFocusKey.get(focusedKey)?.focus();
  }

  public focusHeading(): void {
    if (!this.disposed) this.heading.focus();
  }

  public focusRadio(browser: CollectorBrowserId): void {
    if (!this.disposed) this.radios.get(browser)?.focus();
  }

  public focusPanel(): void {
    if (this.disposed) return;
    const active = this.doc.activeElement;
    if (active === this.heading || (active !== null && this.focusables.includes(active as HTMLElement))) return;
    this.heading.focus();
  }

  public async copyText(text: string): Promise<boolean> {
    const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
    if (clipboard !== undefined) {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Permission denied or no gesture: use the selection fallback below.
      }
    }
    return this.copyBySelection(text);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dialog.removeEventListener("keydown", this.keydownListener, true);
    this.dialog.removeEventListener("keyup", this.keyupListener, true);
    this.dialog.removeEventListener("cancel", this.cancelListener);
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
    this.focusables = [];
    this.byFocusKey.clear();
    this.radios.clear();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous !== null) previous.focus();
  }

  // ----- Rendering -------------------------------------------------------------------------------

  private setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }

  private renderLive(region: HTMLElement, messages: WizardView["live"]["status"], which: "status" | "alert"): void {
    const key = JSON.stringify(messages);
    if (which === "status" ? key === this.statusKey : key === this.alertKey) return;
    if (which === "status") this.statusKey = key;
    else this.alertKey = key;
    region.replaceChildren(
      ...messages.map((message) => {
        const item = this.doc.createElement("div");
        item.className = "collector-wizard-message";
        const headline = this.doc.createElement("p");
        headline.className = "collector-wizard-message-headline";
        headline.textContent = message.headline;
        item.append(headline);
        if (message.detail !== null) {
          const detail = this.doc.createElement("p");
          detail.className = "collector-wizard-message-detail";
          detail.textContent = message.detail;
          item.append(detail);
        }
        return item;
      }),
    );
  }

  private rebuildContent(view: WizardView): void {
    this.focusables = [];
    this.byFocusKey.clear();
    this.radios.clear();
    const inlineButtons = new Map<string, WizardViewButton>();
    for (const button of view.buttons) if (button.group === "inline") inlineButtons.set(button.id, button);

    const blocks: HTMLElement[] = [];
    let disclosureIndex = 0;
    let listIndex = 0;
    for (const block of view.blocks) {
      switch (block.kind) {
        case "paragraph": {
          const p = this.doc.createElement("p");
          p.className = `collector-wizard-text collector-wizard-text-${block.tone}`;
          p.textContent = block.text;
          blocks.push(p);
          break;
        }
        case "callout": {
          const box = this.doc.createElement("div");
          box.className = "collector-wizard-callout";
          const lead = this.doc.createElement("p");
          lead.className = "collector-wizard-callout-lead";
          lead.textContent = block.headline;
          box.append(lead);
          if (block.detail !== null) {
            const detail = this.doc.createElement("p");
            detail.textContent = block.detail;
            box.append(detail);
          }
          blocks.push(box);
          break;
        }
        case "list":
          blocks.push(this.buildList(listIndex++, block.ordered, block.label, block.items, inlineButtons));
          break;
        case "radiogroup":
          blocks.push(this.buildRadioGroup(block));
          break;
        case "disclosure": {
          const details = this.doc.createElement("details");
          details.className = "collector-wizard-disclosure";
          const summary = this.doc.createElement("summary");
          summary.textContent = block.summary;
          this.register(summary, `summary:${disclosureIndex}`);
          disclosureIndex += 1;
          const text = this.doc.createElement("p");
          text.textContent = block.detail;
          details.append(summary, text);
          blocks.push(details);
          break;
        }
        default:
          break;
      }
    }
    if (view.reasonText !== null) {
      const reason = this.doc.createElement("p");
      reason.id = IDS.reason;
      reason.className = "collector-wizard-text collector-wizard-text-muted";
      reason.textContent = view.reasonText;
      blocks.push(reason);
    }
    this.body.replaceChildren(...blocks);

    const tools = view.buttons.filter((button) => button.group === "tools");
    const nav = view.buttons.filter((button) => button.group === "nav");
    const rows: HTMLElement[] = [];
    for (const [name, group] of [["tools", tools], ["nav", nav]] as const) {
      if (group.length === 0) continue;
      const row = this.doc.createElement("div");
      row.className = `collector-wizard-actions-${name}`;
      row.append(...group.map((button) => this.buildButton(button)));
      rows.push(row);
    }
    this.actions.replaceChildren(...rows);
  }

  private buildList(listIndex: number, ordered: boolean, label: string | null, items: readonly WizardViewListItem[], inlineButtons: ReadonlyMap<string, WizardViewButton>): HTMLElement {
    const wrapper = this.doc.createElement("div");
    wrapper.className = "collector-wizard-list-block";
    const list = this.doc.createElement(ordered ? "ol" : "ul");
    list.className = "collector-wizard-list";
    if (label !== null) {
      const heading = this.doc.createElement("p");
      heading.className = "collector-wizard-list-label";
      heading.id = `collector-wizard-list-label-${listIndex}`;
      heading.textContent = label;
      list.setAttribute("aria-labelledby", heading.id);
      wrapper.append(heading);
    }
    for (const item of items) {
      const li = this.doc.createElement("li");
      li.append(item.text);
      if (item.note !== null) {
        const note = this.doc.createElement("p");
        note.className = "collector-wizard-list-note";
        note.textContent = item.note;
        li.append(note);
      }
      for (const id of item.inlineButtonIds) {
        const button = inlineButtons.get(id);
        if (button !== undefined) li.append(this.buildButton(button));
      }
      list.append(li);
    }
    wrapper.append(list);
    return wrapper;
  }

  private buildRadioGroup(block: Extract<WizardView["blocks"][number], { kind: "radiogroup" }>): HTMLElement {
    const group = this.doc.createElement("div");
    group.className = "collector-wizard-radiogroup";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", block.label);
    for (const option of block.options) {
      const radio = this.doc.createElement("div");
      radio.className = "collector-wizard-radio";
      radio.setAttribute("role", "radio");
      radio.setAttribute("aria-checked", String(option.checked));
      if (!option.selectable) radio.setAttribute("aria-disabled", "true");
      radio.setAttribute("tabindex", option.tabbable ? "0" : "-1");
      radio.dataset.browser = option.id;
      const labelId = `collector-wizard-radio-${option.id}-label`;
      const label = this.doc.createElement("span");
      label.id = labelId;
      label.className = "collector-wizard-radio-label";
      label.textContent = option.label;
      radio.append(label);
      radio.setAttribute("aria-labelledby", labelId);
      if (option.note !== null) {
        const noteId = `collector-wizard-radio-${option.id}-note`;
        const note = this.doc.createElement("span");
        note.id = noteId;
        note.className = "collector-wizard-radio-note";
        note.textContent = option.note;
        radio.append(note);
        radio.setAttribute("aria-describedby", noteId);
      }
      radio.addEventListener("click", () => {
        if (option.event !== null) this.options.onEvent(option.event);
      });
      radio.addEventListener("keydown", (event) => {
        if (isRadioKey(event.key)) {
          event.preventDefault();
          this.options.onEvent({ type: "radioKey", key: event.key });
        } else if ((event.key === " " || event.key === "Enter") && option.event !== null) {
          event.preventDefault();
          this.options.onEvent(option.event);
        }
      });
      this.radios.set(option.id, radio);
      if (option.tabbable) this.register(radio, `radio:${option.id}`);
      else this.byFocusKey.set(`radio:${option.id}`, radio);
      group.append(radio);
    }
    return group;
  }

  private buildButton(view: WizardViewButton): HTMLElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = view.primary ? "collector-wizard-button collector-wizard-button-primary" : "collector-wizard-button";
    button.textContent = view.label;
    button.dataset.action = view.id;
    if (view.enabled) {
      button.addEventListener("click", () => this.options.onEvent(view.event));
      this.register(button, `button:${view.id}`);
    } else {
      button.disabled = true;
      if (view.describedBy === "busy") button.setAttribute("aria-describedby", IDS.status);
      else if (view.describedBy === "reason") button.setAttribute("aria-describedby", IDS.reason);
    }
    return button;
  }

  private register(element: HTMLElement, focusKey: string): void {
    this.focusables.push(element);
    this.byFocusKey.set(focusKey, element);
  }

  private focusedKey(): string | null {
    const active = this.doc.activeElement;
    if (active === null) return null;
    for (const [key, element] of this.byFocusKey) if (element === active) return key;
    return null;
  }

  // ----- Keyboard --------------------------------------------------------------------------------

  private onKeyDown(event: KeyboardEvent): void {
    this.escapeKeyDown = false;
    if (event.key === "Escape") {
      event.preventDefault();
      this.escapeKeyDown = true;
      this.options.onEvent({ type: "escape" });
      return;
    }
    if (event.key === "Tab") this.trapTab(event);
  }

  private trapTab(event: KeyboardEvent): void {
    const stops = this.focusables;
    if (stops.length === 0) {
      event.preventDefault();
      this.heading.focus();
      return;
    }
    const active = this.doc.activeElement as HTMLElement | null;
    const index = active === null ? -1 : stops.indexOf(active);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (event.shiftKey) {
      if (index <= 0) {
        event.preventDefault();
        last.focus();
      }
    } else if (index === stops.length - 1 || (index < 0 && active !== this.heading)) {
      event.preventDefault();
      first.focus();
    }
  }

  private copyBySelection(text: string): boolean {
    const area = this.doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.className = "collector-wizard-clipboard-buffer";
    const restore = this.doc.activeElement as HTMLElement | null;
    this.dialog.append(area);
    try {
      area.focus();
      area.select();
      return this.doc.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
      restore?.focus();
    }
  }
}
