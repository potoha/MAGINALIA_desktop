/**
 * Desktop commands that set or clear the Private Shelf MAGINALIA Collector saves to.
 *
 * `maginalia.collector.configureSaveDestination` and
 * `maginalia.collector.clearSaveDestination` are the only writers of the production
 * Collector configuration (Desktop #86 design memo, section 1). The configuration is
 * the #87 Shelf binding; the Native Messaging Host reads it and never writes it.
 *
 * Configure shows the Private Shelf currently named by `shelf_location.yml` (display
 * name only), re-reads its typed D068 marker, asks for explicit confirmation, and then
 * persists the binding atomically through `shelf-binding-store` with the next
 * generation. It reuses the Reviewer binding flow, so both writers share one binding
 * policy. There is no adoption, repair or silent rebinding: an invalid, conflicting or
 * changed marker, or an unreadable existing binding, ends in an error dialog without a
 * write.
 *
 * Clear removes only the binding file. The Shelf, its journal, the coordination
 * directory and the Collector extension's pending requests are never touched.
 *
 * Single-writer limitation (#87 P1): `persistShelfBinding` checks the expected
 * generation before an atomic rename, but that check is not a cross-process
 * compare-and-swap. Two Desktop processes confirming different Shelves at the same
 * moment could each pass the check and the later rename wins. This is accepted for α
 * because the binding is written only from this explicit Desktop UI action (the Host
 * is read-only), and it is documented in `docs/collector-host-binding.md`.
 */
import { lstat } from "node:fs/promises";
import { inspectFolderMarkers } from "./folder-identity.js";
import { parseShelfLocationSource } from "./shelf-location-registry.js";
import type { SecureShelfBindingPersistenceAdapter } from "./shelf-binding.js";
import type { ShelfBindingStoragePaths } from "./shelf-binding-store.js";
import { resolveReviewerShelfWriteCoordination } from "./reviewer-shelf-write-binding.js";
import { verifyCollectorStorageSecurity, type PathSecurityInspector } from "./collector-path-security.js";
import {
  inspectConfiguredPrivateShelfMarker,
  readBoundedTextFile,
  readPrivateShelfLibraryName,
  type CollectorConfigurationErrorCode,
} from "./collector-shelf-configuration.js";

export const CONFIGURE_COLLECTOR_SAVE_DESTINATION_COMMAND_ID = "maginalia.collector.configureSaveDestination";
export const CLEAR_COLLECTOR_SAVE_DESTINATION_COMMAND_ID = "maginalia.collector.clearSaveDestination";

export type CollectorSaveDestinationResult =
  | { readonly kind: "configured"; readonly writesEnabled: boolean }
  | { readonly kind: "already-configured"; readonly writesEnabled: boolean }
  | { readonly kind: "cleared" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error" };

export interface CollectorSaveDestinationConfirmation {
  readonly kind: "configure" | "replace" | "clear";
  readonly shelfName?: string;
}

export interface CollectorSaveDestinationNotice {
  readonly type: "info" | "warning" | "error";
  readonly message: string;
  readonly detail?: string;
}

export interface CollectorSaveDestinationDependencies {
  /** Desktop's own `shelf_location.yml` (Electron userData). */
  readonly shelfLocationPath: string;
  readonly storagePaths: ShelfBindingStoragePaths;
  readonly store: SecureShelfBindingPersistenceAdapter;
  readonly inspectPathSecurity: PathSecurityInspector;
  readonly removeBinding: () => Promise<boolean>;
  readonly confirm: (request: CollectorSaveDestinationConfirmation) => Promise<boolean>;
  readonly notify: (notice: CollectorSaveDestinationNotice) => Promise<void>;
}

const UNCHANGED = "Collector の保存先の設定は変更されていません。";

function configurationErrorNotice(code: CollectorConfigurationErrorCode): CollectorSaveDestinationNotice {
  switch (code) {
    case "shelf_unconfigured":
      return { type: "error", message: "Private Shelf が設定されていません。", detail: `先に Shelf を開いて Private Shelf を設定してください。${UNCHANGED}` };
    case "shelf_identity_unavailable":
      return { type: "error", message: "本棚の識別マーカーを確認できません。", detail: `本棚フォルダーの .magi マーカーが見つからないか、壊れているか、競合しています。マーカーの作成や修復は行いません。${UNCHANGED}` };
    case "shelf_identity_mismatch":
      return { type: "error", message: "本棚の識別マーカーが一致しません。", detail: UNCHANGED };
    case "shelf_unavailable":
      return { type: "error", message: "本棚を開けません。", detail: `本棚フォルダーまたは library.json を確認できませんでした。${UNCHANGED}` };
    case "configuration_unavailable":
    default:
      return { type: "error", message: "本棚の設定を読み取れません。", detail: `shelf_location.yml を確認できませんでした。${UNCHANGED}` };
  }
}

function writesEnabledNotice(writesEnabled: boolean): string {
  return writesEnabled
    ? "Collector からの保存はこの本棚に書き込まれます。本棚のファイルや識別マーカーは変更していません。"
    : "ただし、設定フォルダーの所有者またはアクセス権を安全と確認できないため、Collector からの保存は無効のままです。";
}

async function readLocator(shelfLocationPath: string): Promise<string | null> {
  try {
    const parsed = parseShelfLocationSource(await readBoundedTextFile(shelfLocationPath, 64 * 1024));
    return parsed?.privateShelf.registry ?? null;
  } catch {
    return null;
  }
}

/** `maginalia.collector.configureSaveDestination` */
export async function configureCollectorSaveDestination(
  dependencies: CollectorSaveDestinationDependencies,
): Promise<CollectorSaveDestinationResult> {
  const configured = await inspectConfiguredPrivateShelfMarker(dependencies.shelfLocationPath);
  if (configured.kind === "error") {
    await dependencies.notify(configurationErrorNotice(configured.code));
    return { kind: "error" };
  }
  const shelfName = await readPrivateShelfLibraryName(configured.root);
  if (typeof shelfName !== "string") {
    await dependencies.notify(configurationErrorNotice(shelfName.code));
    return { kind: "error" };
  }

  let asked = false;
  let confirmed = false;
  try {
    await resolveReviewerShelfWriteCoordination({
      storagePaths: dependencies.storagePaths,
      store: dependencies.store,
      context: {
        shelfName,
        shelfRoot: configured.root,
        shelfLocationPath: dependencies.shelfLocationPath,
        privateShelfLocator: configured.locator,
        typedMarker: configured.marker,
      },
      confirmRebind: async (reason) => {
        asked = true;
        confirmed = await dependencies.confirm({
          kind: reason === "binding-missing" ? "configure" : "replace",
          shelfName,
        });
        return confirmed;
      },
      reloadConfiguration: () => readLocator(dependencies.shelfLocationPath),
      reloadTypedMarker: async () => {
        const latest = await inspectFolderMarkers(configured.root).catch(() => undefined);
        return latest?.kind === "valid" && latest.marker.type === "shelf" ? latest.marker : null;
      },
    });
  } catch {
    if (asked && !confirmed) return { kind: "cancelled" };
    await dependencies.notify(asked
      ? {
        type: "error",
        message: "Collector の保存先を設定できませんでした。",
        detail: `確認中に本棚の設定または識別マーカーが変わったか、設定を保存できませんでした。${UNCHANGED}`,
      }
      : {
        type: "error",
        message: "保存されている Collector の保存先設定を確認できません。",
        detail: `設定ファイルが読み取れないか、この版では扱えない形式です。自動では修復しません。${UNCHANGED}`,
      });
    return { kind: "error" };
  }

  const writesEnabled = verifyCollectorStorageSecurity(dependencies.storagePaths, dependencies.inspectPathSecurity).ok;
  if (!asked) {
    await dependencies.notify({
      type: writesEnabled ? "info" : "warning",
      message: `Collector の保存先は既に「${shelfName}」に設定されています。`,
      detail: writesEnabledNotice(writesEnabled),
    });
    return { kind: "already-configured", writesEnabled };
  }
  await dependencies.notify({
    type: writesEnabled ? "info" : "warning",
    message: `Collector の保存先を「${shelfName}」に設定しました。`,
    detail: writesEnabledNotice(writesEnabled),
  });
  return { kind: "configured", writesEnabled };
}

/** `maginalia.collector.clearSaveDestination` */
export async function clearCollectorSaveDestination(
  dependencies: CollectorSaveDestinationDependencies,
): Promise<CollectorSaveDestinationResult> {
  let present: boolean;
  try {
    await lstat(dependencies.storagePaths.bindingPath);
    present = true;
  } catch (error: unknown) {
    const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      await dependencies.notify({ type: "error", message: "Collector の保存先設定を確認できません。", detail: UNCHANGED });
      return { kind: "error" };
    }
    present = false;
  }
  if (!present) {
    await dependencies.notify({ type: "info", message: "Collector の保存先は設定されていません。" });
    return { kind: "not-configured" };
  }
  if (!await dependencies.confirm({ kind: "clear" })) return { kind: "cancelled" };
  try {
    const removed = await dependencies.removeBinding();
    if (!removed) {
      await dependencies.notify({ type: "info", message: "Collector の保存先は設定されていません。" });
      return { kind: "not-configured" };
    }
  } catch {
    await dependencies.notify({ type: "error", message: "Collector の保存先の設定を解除できませんでした。", detail: UNCHANGED });
    return { kind: "error" };
  }
  await dependencies.notify({
    type: "info",
    message: "Collector の保存先の設定を解除しました。",
    detail: "本棚・引用データ・書き込み記録は変更していません。Collector からの保存は、再度設定するまで保留されます。",
  });
  return { kind: "cleared" };
}

/** Japanese confirmation dialog text for the main-process message box. */
export function collectorSaveDestinationConfirmationText(request: CollectorSaveDestinationConfirmation): {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly confirmLabel: string;
} {
  switch (request.kind) {
    case "clear":
      return {
        title: "Collector の保存先",
        message: "Collector の保存先の設定を解除しますか？",
        detail: "解除するのは保存先の設定だけです。本棚・引用データ・書き込み記録は削除・変更されません。解除後、Collector からの保存は再度設定するまで保留されます。",
        confirmLabel: "解除する",
      };
    case "replace":
      return {
        title: "Collector の保存先",
        message: "Collector の保存先をこの本棚に変更しますか？",
        detail: `本棚: ${request.shelfName ?? ""}\n\n保存されている設定は、別の本棚またはフォルダーを指しています。本棚のファイルや識別マーカーは変更されません。`,
        confirmLabel: "この本棚に変更",
      };
    case "configure":
    default:
      return {
        title: "Collector の保存先",
        message: "Collector の保存先をこの本棚に設定しますか？",
        detail: `本棚: ${request.shelfName ?? ""}\n\nブラウザー拡張機能 MAGINALIA Collector で保存した Web 引用を、この Private Shelf に書き込みます。本棚のファイルや識別マーカーは変更されません。`,
        confirmLabel: "この本棚に設定",
      };
  }
}
