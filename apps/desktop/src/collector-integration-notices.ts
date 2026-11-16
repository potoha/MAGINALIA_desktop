/**
 * Notice model and persisted notice state for the Collector integration (design 5 and 6, WP-5c).
 *
 * A notice is plain data: a stable id, a kind, the values its text needs, the actions (stable
 * command IDs, design 5) and the condition that clears it. No renderer, no dialogs. WP-7 renders
 * the data and dispatches the command IDs; nothing here registers a command.
 *
 * Persisted state (Desktop userData, one small JSON file) holds only flags, a version string and a
 * timestamp. It never holds a path, a Shelf identifier or any Collector content.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { parseCollectorVersion } from "./collector-version.js";

/** Commands already named by design 5. Registered by WP-7 together with the panel. */
export const COLLECTOR_SETUP_COMMAND_ID = "maginalia.collector.setup";
export const COLLECTOR_REPAIR_COMMAND_ID = "maginalia.collector.repair";
/** New in WP-5c (not in design 5): the notice buttons of design 6.5 / 5. */
export const COLLECTOR_OPEN_CHROME_EXTENSIONS_COMMAND_ID = "maginalia.collector.openChromeExtensions";
export const COLLECTOR_DISMISS_NOTICE_COMMAND_ID = "maginalia.collector.dismissNotice";

export const COLLECTOR_NOTICE_IDS = Object.freeze({
  updated: "collector.notice.updated",
  repair: "collector.notice.repair",
  alpha1Migration: "collector.notice.alpha1-migration",
} as const);

export type CollectorNoticeKind = "updated" | "repair" | "alpha1-migration";
export type CollectorRepairNoticeState = "foreign-registration" | "registration-missing" | "damaged";

export interface CollectorNoticeAction {
  readonly commandId: string;
  readonly label: string;
  /** Only `maginalia.collector.dismissNotice` carries an argument: the id of the notice to close. */
  readonly argument?: { readonly noticeId: string };
  /** After this action runs, the caller also dispatches `maginalia.collector.dismissNotice` for this notice. */
  readonly closesNoticeId?: string;
}

interface NoticeBase {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly actions: readonly CollectorNoticeAction[];
}

export type CollectorNotice =
  | (NoticeBase & {
    readonly kind: "updated";
    /** The Collector extension version Desktop placed. */
    readonly extensionVersion: string;
    /** ISO time of the refresh. A contact record counts only when it is not older than this. */
    readonly createdAt: string;
    /** Cleared by a contact record that reports `extensionVersion` (or newer) after `createdAt`, or by dismissal. */
    readonly clearsWhen: "contact-reports-extension-version";
  })
  | (NoticeBase & {
    readonly kind: "repair";
    readonly state: CollectorRepairNoticeState;
    /** Recomputed at every start; closed for the session by dismissal. */
    readonly clearsWhen: "state-recovers-or-dismissed";
  })
  | (NoticeBase & {
    readonly kind: "alpha1-migration";
    /** Shown once; dismissal (or the setup action) is remembered. */
    readonly clearsWhen: "dismissed";
  });

export function buildUpdatedNotice(extensionVersion: string, createdAt: string): CollectorNotice {
  return Object.freeze({
    id: COLLECTOR_NOTICE_IDS.updated,
    kind: "updated" as const,
    title: `MAGINALIA Collector を新しい版（${extensionVersion}）に更新しました。`,
    detail: "Chrome の拡張機能の画面で MAGINALIA Collector の［更新］（↻）を押すか、Chrome を再起動すると反映されます。",
    extensionVersion,
    createdAt,
    clearsWhen: "contact-reports-extension-version" as const,
    actions: Object.freeze([
      { commandId: COLLECTOR_OPEN_CHROME_EXTENSIONS_COMMAND_ID, label: "Chrome で拡張機能の画面を開く" },
      { commandId: COLLECTOR_DISMISS_NOTICE_COMMAND_ID, label: "閉じる", argument: { noticeId: COLLECTOR_NOTICE_IDS.updated } },
    ]),
  });
}

/** Repair copy is not fixed by the design; WP-7 may refine the wording. */
export function buildRepairNotice(state: CollectorRepairNoticeState): CollectorNotice {
  return Object.freeze({
    id: COLLECTOR_NOTICE_IDS.repair,
    kind: "repair" as const,
    title: "Collector 連携の確認が必要です。",
    detail: "Chrome から本棚へ引用を保存する連携が、この MAGINALIA の設定と一致していません。自動では変更していません。",
    state,
    clearsWhen: "state-recovers-or-dismissed" as const,
    actions: Object.freeze([
      { commandId: COLLECTOR_REPAIR_COMMAND_ID, label: "確認・修復…" },
      { commandId: COLLECTOR_DISMISS_NOTICE_COMMAND_ID, label: "閉じる", argument: { noticeId: COLLECTOR_NOTICE_IDS.repair } },
    ]),
  });
}

export function buildAlpha1MigrationNotice(): CollectorNotice {
  return Object.freeze({
    id: COLLECTOR_NOTICE_IDS.alpha1Migration,
    kind: "alpha1-migration" as const,
    title: "Chrome で読んでいる Web ページの引用を、本棚に保存できるようになりました（MAGINALIA Collector）。",
    detail: null,
    clearsWhen: "dismissed" as const,
    actions: Object.freeze([
      { commandId: COLLECTOR_SETUP_COMMAND_ID, label: "設定する", closesNoticeId: COLLECTOR_NOTICE_IDS.alpha1Migration },
      { commandId: COLLECTOR_DISMISS_NOTICE_COMMAND_ID, label: "今はしない", argument: { noticeId: COLLECTOR_NOTICE_IDS.alpha1Migration } },
    ]),
  });
}

// ----- Persisted state ----------------------------------------------------------------------

export type CollectorAlpha1NoticeState = "unseen" | "shown" | "dismissed";

export interface CollectorNoticeState {
  readonly version: 1;
  /** The user asked for `remove`: no repair notice and no automatic refresh until a setup/repair is applied. */
  readonly removeRequested: boolean;
  readonly alpha1: CollectorAlpha1NoticeState;
  /** The pending "updated" notice (until a matching contact or dismissal). */
  readonly updated: { readonly extensionVersion: string; readonly createdAt: string } | null;
}

export const DEFAULT_COLLECTOR_NOTICE_STATE: CollectorNoticeState = Object.freeze({
  version: 1 as const,
  removeRequested: false,
  alpha1: "unseen" as const,
  updated: null,
});

const STATE_FIELDS = ["version", "removeRequested", "alpha1", "updated"] as const;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const MAX_STATE_BYTES = 2048;

/** `undefined` for anything that is not exactly the persisted shape. */
export function parseCollectorNoticeState(text: string): CollectorNoticeState | undefined {
  if (text.length > MAX_STATE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== STATE_FIELDS.length || !STATE_FIELDS.every((field) => Object.hasOwn(record, field))) return undefined;
  if (record.version !== 1 || typeof record.removeRequested !== "boolean") return undefined;
  if (record.alpha1 !== "unseen" && record.alpha1 !== "shown" && record.alpha1 !== "dismissed") return undefined;
  let updated: CollectorNoticeState["updated"] = null;
  if (record.updated !== null) {
    const pending = record.updated;
    if (pending === undefined || typeof pending !== "object" || Array.isArray(pending)) return undefined;
    const fields = pending as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || typeof fields.extensionVersion !== "string" || typeof fields.createdAt !== "string") return undefined;
    if (parseCollectorVersion(fields.extensionVersion) === undefined || !TIMESTAMP_PATTERN.test(fields.createdAt)) return undefined;
    updated = Object.freeze({ extensionVersion: fields.extensionVersion, createdAt: fields.createdAt });
  }
  return Object.freeze({ version: 1 as const, removeRequested: record.removeRequested, alpha1: record.alpha1, updated });
}

export interface CollectorNoticeStore {
  /** Never throws: a missing or damaged file reads as the defaults. */
  read(): Promise<CollectorNoticeState>;
  /** Throws when the state cannot be written; callers treat that as "not persisted". */
  write(state: CollectorNoticeState): Promise<void>;
}

/** Atomic (private temp + rename) JSON file in Desktop userData. */
export function createFileCollectorNoticeStore(filePath: string): CollectorNoticeStore {
  return {
    async read(): Promise<CollectorNoticeState> {
      try {
        const text = await readFile(filePath, "utf8");
        return parseCollectorNoticeState(text) ?? DEFAULT_COLLECTOR_NOTICE_STATE;
      } catch {
        return DEFAULT_COLLECTOR_NOTICE_STATE;
      }
    },
    async write(state: CollectorNoticeState): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, filePath);
      } catch (error: unknown) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}
