/**
 * The optional Collector guide on the first-run completion card (WIZ-02).
 *
 * It is only a pointer: the button opens the existing Collector wizard (the same opener as the
 * 「Collector 連携を設定」 command) and nothing is registered or written until the user acts inside that
 * wizard. Not pressing it changes nothing about the first-run setup.
 */
export const FIRST_RUN_COLLECTOR_HEADING = "ブラウザー拡張 Collector（任意）";
export const FIRST_RUN_COLLECTOR_BODY =
  "閲覧中のページを、引用の記録として Private Shelf に取り込めます。対応しているブラウザーから選んで設定します。あとで「Collector 連携を設定」からでも設定できます。";
export const FIRST_RUN_COLLECTOR_BUTTON = "Collector を設定する";
export const FIRST_RUN_COLLECTOR_FAILED = "Collector の設定画面を開けませんでした。あとで「Collector 連携を設定」からお試しください。";

/** The slice of a button this guide needs (an `HTMLButtonElement` satisfies it). */
export interface FirstRunCollectorButton {
  addEventListener(type: "click", listener: () => void): void;
}

export interface FirstRunCollectorGuideDeps {
  readonly button: FirstRunCollectorButton;
  /** The wizard opener; `null` when this runtime cannot run the wizard. */
  readonly openWizard: (() => void) | null;
  /** Shows a one-line problem. */
  readonly reportError: (message: string) => void;
}

/**
 * Wires the button. Returns whether the guide can be offered at all: `false` (no opener) means the
 * caller keeps the guide hidden, so no dead button is shown.
 */
export function bindFirstRunCollectorGuide(deps: FirstRunCollectorGuideDeps): boolean {
  const { openWizard } = deps;
  if (openWizard === null) return false;
  deps.button.addEventListener("click", () => {
    try {
      openWizard();
    } catch {
      deps.reportError(FIRST_RUN_COLLECTOR_FAILED);
    }
  });
  return true;
}
