import type { MenuItemConstructorOptions } from "electron";
import {
  APPLICATION_MENU_COMMAND_CHANNEL,
  APPLICATION_MENU_MANIFEST,
  isApplicationMenuCommandId,
  isApplicationMenuSnapshot,
  normalizeApplicationMenuAccelerator,
  type AcceleratorPlatform,
  type ApplicationMenuCommandId,
  type ApplicationMenuCommandState
} from "./application-menu-contract";

export {
  APPLICATION_MENU_COMMAND_CHANNEL,
  APPLICATION_MENU_COMMAND_IDS,
  APPLICATION_MENU_MANIFEST,
  UPDATE_APPLICATION_MENU_CHANNEL,
  isApplicationMenuCommandId,
  isApplicationMenuSnapshot,
  normalizeApplicationMenuAccelerator
} from "./application-menu-contract";
export type { ApplicationMenuCommandId, ApplicationMenuCommandState } from "./application-menu-contract";

export interface ApplicationMenuIpcOwner {
  readonly mainFrame: object;
}

export interface ApplicationMenuIpcInvokeEvent {
  readonly sender: object;
  readonly senderFrame: object | null;
}

export type ApplicationMenuCommandDispatch = (commandId: ApplicationMenuCommandId) => void;

export function createApplicationMenuTemplate(
  snapshot: readonly ApplicationMenuCommandState[],
  dispatch: ApplicationMenuCommandDispatch,
  platform: AcceleratorPlatform
): MenuItemConstructorOptions[] {
  const states = new Map(snapshot.map((state) => [state.id, state]));
  return APPLICATION_MENU_MANIFEST.map((menu) => ({
    label: menu.label,
    submenu: menu.items.map((item): MenuItemConstructorOptions => {
      if (item.kind === "separator") return { type: "separator" };
      if (item.kind === "role") return { label: item.label, role: item.role };

      const state = states.get(item.id);
      const accelerator = state?.shortcut === undefined
        ? undefined
        : normalizeApplicationMenuAccelerator(state.shortcut, platform) ?? undefined;
      return {
        id: item.id,
        label: item.label,
        enabled: state?.enabled === true,
        ...(accelerator === undefined ? {} : { accelerator, registerAccelerator: false }),
        click: () => {
          if (state?.enabled === true && isApplicationMenuCommandId(item.id)) dispatch(item.id);
        }
      };
    })
  }));
}

/** Bind a menu-state update to the owner window's top-level frame and static command allowlist. */
export function createApplicationMenuUpdateHandler(
  getOwner: () => ApplicationMenuIpcOwner | null,
  update: (snapshot: readonly ApplicationMenuCommandState[]) => void
): (event: ApplicationMenuIpcInvokeEvent, value: unknown) => boolean {
  return (event, value) => {
    const owner = getOwner();
    if (owner === null || event.sender !== owner || event.senderFrame === null || event.senderFrame !== owner.mainFrame) return false;
    if (!isApplicationMenuSnapshot(value)) return false;
    update(value);
    return true;
  };
}

/** Treat native menu events as a second discovery surface, not an action implementation. */
export function dispatchApplicationMenuCommand(
  commandId: unknown,
  send: (channel: string, value: ApplicationMenuCommandId) => void
): boolean {
  if (!isApplicationMenuCommandId(commandId)) return false;
  send(APPLICATION_MENU_COMMAND_CHANNEL, commandId);
  return true;
}
