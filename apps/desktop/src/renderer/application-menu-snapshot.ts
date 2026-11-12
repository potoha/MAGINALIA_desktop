import type { ApplicationMenuCommandId, ApplicationMenuCommandState } from "../application-menu-contract";

export interface ApplicationMenuSnapshotInput {
  readonly commandIds: readonly ApplicationMenuCommandId[];
  /** Public commands whose `when` currently matches. */
  readonly enabledCommandIds: ReadonlySet<string>;
  /** True while the modal Settings Center owns keyboard focus. */
  readonly modalOpen: boolean;
  readonly allowedDuringModal: ReadonlySet<string>;
  /** Effective binding in Electron platform spelling, or null. */
  readonly getShortcut: (commandId: ApplicationMenuCommandId) => string | null;
}

/** Pure projection of Registry + keybinding state into the validated native menu snapshot. */
export function buildApplicationMenuSnapshot(input: ApplicationMenuSnapshotInput): ApplicationMenuCommandState[] {
  return input.commandIds.map((id) => {
    const allowedDuringModal = !input.modalOpen || input.allowedDuringModal.has(id);
    const shortcut = input.getShortcut(id);
    return {
      id,
      enabled: input.enabledCommandIds.has(id) && allowedDuringModal,
      ...(shortcut === null ? {} : { shortcut })
    };
  });
}
