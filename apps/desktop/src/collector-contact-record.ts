/**
 * Collector contact record (`host_info`, Desktop wizard-integration design 4.6).
 *
 * When the production Host answers `host_info` for the allowed origin it best-effort
 * records `%LOCALAPPDATA%\MAGINALIA\integration\collector-contact.json` so the Desktop
 * wizard can see that the pinned extension reached the registered Host. The record has
 * exactly five fields and no path, Shelf UUID, Shelf name, URL or quote text.
 *
 * - The location comes only from the native known-folder path through
 *   `resolveShelfBindingStoragePaths`; the integration folder is never created here.
 * - The write happens only when the `MAGINALIA` application root and the `integration`
 *   folder are owned by the current user with no foreign writers and no reparse points
 *   (the same checks `verifyCollectorStorageSecurity` applies to those two entries; the
 *   binding file is deliberately not required, because the extension may connect before
 *   a Shelf is bound).
 * - An existing final entry must be a regular file; it is never opened for writing. A
 *   private `O_EXCL` temp file is renamed over it, and removed on any failure.
 * - A record with the same values written less than 60 s ago is left alone. Each Host
 *   process serves one Chrome connection, so the limit is read from the record itself.
 * - It never throws and never reports a diagnostic: the caller's response is unchanged.
 */
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { inspectAndEvaluatePathSecurity, type PathSecurityInspector } from "./collector-path-security.js";
import { resolveShelfBindingStoragePaths } from "./shelf-binding-store.js";

export const COLLECTOR_CONTACT_RECORD_FILENAME = "collector-contact.json";
export const COLLECTOR_CONTACT_MIN_INTERVAL_MS = 60_000;
const MAX_CONTACT_RECORD_BYTES = 4096;

export interface CollectorContactValues {
  readonly protocol: string;
  readonly hostVersion: string;
  readonly extensionVersion: string;
}

export interface CollectorContactRecorderDependencies {
  readonly resolveLocalAppDataPath: () => string;
  readonly inspectPathSecurity: PathSecurityInspector;
  readonly now?: () => Date;
  /** Test seam: runs after the temp file is complete and before it is renamed into place. */
  readonly beforeRename?: () => Promise<void>;
}

export type CollectorContactOutcome = "written" | "skipped";
export type CollectorContactRecorder = (values: CollectorContactValues) => Promise<CollectorContactOutcome>;

type EntryState = "absent" | "regular" | "refused";

async function classifyEntry(file: string): Promise<EntryState> {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() ? "regular" : "refused";
  } catch (error: unknown) {
    const code = error !== null && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return code === "ENOENT" ? "absent" : "refused";
  }
}

/** True when `file` already holds the same values written less than the minimum interval ago. */
async function isFresh(file: string, values: CollectorContactValues, now: Date): Promise<boolean> {
  try {
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_CONTACT_RECORD_BYTES) return false;
    const record = JSON.parse(text) as Record<string, unknown> | null;
    if (record === null || typeof record !== "object" || record.version !== 1
      || record.protocol !== values.protocol || record.hostVersion !== values.hostVersion
      || record.extensionVersion !== values.extensionVersion || typeof record.contactedAt !== "string") return false;
    const elapsed = now.getTime() - Date.parse(record.contactedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < COLLECTOR_CONTACT_MIN_INTERVAL_MS;
  } catch {
    return false;
  }
}

export function createCollectorContactRecorder(dependencies: CollectorContactRecorderDependencies): CollectorContactRecorder {
  const now = dependencies.now ?? (() => new Date());
  return async (values) => {
    let temporary: string | undefined;
    try {
      const paths = resolveShelfBindingStoragePaths(dependencies.resolveLocalAppDataPath());
      const applicationRoot = path.win32.dirname(paths.bindingDirectory);
      for (const directory of [applicationRoot, paths.bindingDirectory]) {
        // Missing entries fail this check too: the integration folder is never created here.
        if (!inspectAndEvaluatePathSecurity(dependencies.inspectPathSecurity, directory, "directory").ok) return "skipped";
      }
      const file = path.win32.join(paths.bindingDirectory, COLLECTOR_CONTACT_RECORD_FILENAME);
      const current = now();
      const before = await classifyEntry(file);
      if (before === "refused") return "skipped";
      if (before === "regular" && await isFresh(file, values, current)) return "skipped";

      const record = {
        version: 1,
        protocol: values.protocol,
        hostVersion: values.hostVersion,
        extensionVersion: values.extensionVersion,
        contactedAt: current.toISOString(),
      };
      temporary = path.win32.join(paths.bindingDirectory, `.${COLLECTOR_CONTACT_RECORD_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Re-check the final entry right before the atomic replace.
      if (await classifyEntry(file) === "refused") throw new Error("refused");
      await dependencies.beforeRename?.();
      await rename(temporary, file);
      temporary = undefined;
      return "written";
    } catch {
      if (temporary !== undefined) await unlink(temporary).catch(() => {});
      return "skipped";
    }
  };
}
