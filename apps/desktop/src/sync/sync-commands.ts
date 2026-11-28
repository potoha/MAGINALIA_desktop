/**
 * Stable Command IDs for backup / Sync actions. Constants only: registration
 * in the Command Registry and the handlers arrive with the UI slice. Menus,
 * buttons, the Command Palette and Mods must all dispatch these same IDs.
 */
export const SYNC_COMMAND_IDS = Object.freeze({
  setup: "maginalia.sync.setup",
  syncNow: "maginalia.sync.now",
  reconnect: "maginalia.sync.reconnect",
  disconnect: "maginalia.sync.disconnect",
  showStatus: "maginalia.sync.showStatus",
  checkpoint: "maginalia.history.checkpoint",
  restore: "maginalia.sync.restore",
} as const);

export type SyncCommandId = (typeof SYNC_COMMAND_IDS)[keyof typeof SYNC_COMMAND_IDS];
