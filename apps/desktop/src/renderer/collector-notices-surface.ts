/**
 * Collector notices in the renderer (S8 / WP-7 slice B4).
 *
 * The renderer has no toast surface, so this is the one small surface for the notices the main process
 * owns (`CollectorNotice`): a region at the bottom right of the window that lists them. It holds no
 * notice logic. Every button runs `dispatchCollectorNoticeAction`, which executes the notice's own
 * command ID through the Command Registry (design 5).
 *
 * `startCollectorNotices` asks for the notices exactly once (that first call is what releases the
 * one-time alpha1 notice in the main process) and then follows the pushed `onCollectorNotices` list.
 */
import type { CollectorNotice, CollectorNoticeAction } from "../collector-integration-notices";

export interface CollectorNoticesApi {
  readonly getCollectorNotices?: () => Promise<readonly CollectorNotice[]>;
  readonly onCollectorNotices?: (callback: (notices: readonly CollectorNotice[]) => void) => () => void;
}

export interface CollectorNoticesDeps {
  readonly api: CollectorNoticesApi;
  /** Shows the full list (an empty list clears the surface). */
  readonly present: (notices: readonly CollectorNotice[]) => void;
  /** Receives a failure of the notice request. Default: `console.error`. */
  readonly onError?: (error: unknown) => void;
}

export interface CollectorNoticesHandle {
  stop(): void;
}

/** Starts the notice flow once per renderer start. Does nothing when the preload has no notice API. */
export function startCollectorNotices(deps: CollectorNoticesDeps): CollectorNoticesHandle {
  const { api } = deps;
  const onError = deps.onError ?? ((error: unknown) => console.error("MAGINALIA_COLLECTOR_NOTICES_FAILED", error instanceof Error ? error.name : typeof error));
  let stopped = false;
  /** A pushed list is newer than the answer of the one pull that may still be pending. */
  let pushed = false;
  const unsubscribe = typeof api.onCollectorNotices === "function"
    ? api.onCollectorNotices((notices) => {
      if (stopped) return;
      pushed = true;
      deps.present(notices);
    })
    : null;
  if (typeof api.getCollectorNotices === "function") {
    try {
      api.getCollectorNotices().then((notices) => {
        if (!stopped && !pushed) deps.present(notices);
      }).catch(onError);
    } catch (error: unknown) {
      onError(error); // a synchronous throw (for example a validation error in the preload)
    }
  }
  return {
    stop(): void {
      stopped = true;
      unsubscribe?.();
    },
  };
}

/** A rendered notice button runs `action`; the caller dispatches it. */
export type CollectorNoticeActionHandler = (action: CollectorNoticeAction) => void;

/** The DOM surface. `document` is injectable for tests; nothing else touches the page. */
export function createCollectorNoticePresenter(
  doc: Document,
  onAction: CollectorNoticeActionHandler,
): (notices: readonly CollectorNotice[]) => void {
  const region = doc.createElement("section");
  region.id = "collector-notices";
  region.className = "collector-notices";
  region.setAttribute("aria-label", "Collector の通知");
  region.setAttribute("aria-live", "polite");
  region.hidden = true;
  doc.body.append(region);

  /** The buttons of the last render, keyed by notice id + action index, to carry focus across a re-render. */
  let buttons: Array<{ readonly key: string; readonly element: HTMLButtonElement }> = [];

  return (notices) => {
    const focusedKey = buttons.find((entry) => entry.element === doc.activeElement)?.key;
    buttons = [];
    region.replaceChildren();
    for (const notice of notices) {
      const card = doc.createElement("div");
      card.className = "collector-notice";
      // The remove-failed notice needs the user's attention (a removal half done); the others are polite.
      card.setAttribute("role", notice.kind === "remove-failed" ? "alert" : "group");
      card.setAttribute("aria-label", notice.title);
      card.dataset.noticeId = notice.id;
      const title = doc.createElement("p");
      title.className = "collector-notice-title";
      title.textContent = notice.title;
      card.append(title);
      if (notice.detail !== null) {
        const detail = doc.createElement("p");
        detail.className = "collector-notice-detail";
        detail.textContent = notice.detail;
        card.append(detail);
      }
      const actions = doc.createElement("div");
      actions.className = "collector-notice-actions";
      for (const [index, action] of notice.actions.entries()) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "collector-notice-button";
        button.textContent = action.label;
        button.addEventListener("click", () => onAction(action));
        actions.append(button);
        buttons.push({ key: `${notice.id}:${index}`, element: button });
      }
      card.append(actions);
      region.append(card);
    }
    region.hidden = notices.length === 0;
    if (focusedKey !== undefined) {
      // Focus was on a notice button: keep it on the same button when it still exists. Otherwise (the notice was
      // dismissed or changed) move it to the first remaining button, or to the page body when none is left, so
      // keyboard focus never falls to a removed element.
      (buttons.find((entry) => entry.key === focusedKey) ?? buttons[0])?.element.focus();
      if (buttons.length === 0) doc.body.focus();
    }
  };
}
