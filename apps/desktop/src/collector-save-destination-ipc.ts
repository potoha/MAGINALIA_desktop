/** Renderer-to-main bridge for the two Collector save-destination commands. */
export const CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL = "maginalia:collector-configure-save-destination";
export const CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL = "maginalia:collector-clear-save-destination";

/** No paths, UUIDs or Shelf names cross this boundary; the main process shows the dialogs. */
export type CollectorSaveDestinationIpcResult =
  | { readonly kind: "configured"; readonly writesEnabled: boolean }
  | { readonly kind: "already-configured"; readonly writesEnabled: boolean }
  | { readonly kind: "cleared" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "busy" }
  | { readonly kind: "error" };
