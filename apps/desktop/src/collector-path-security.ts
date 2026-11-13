/**
 * Ownership / ACL policy for the fixed per-user Collector integration state.
 *
 * Desktop #86 design memo, section 1: the binding file, its directory and the
 * coordination root must be owned by the current user SID, no principal other than the
 * current user, SYSTEM and BUILTIN\Administrators may hold write access, and no checked
 * entry may be a reparse point. Every other state fails closed.
 *
 * The native addon (`inspectPathSecurity`) reports raw facts read from one handle that
 * does not follow a final reparse point; this module only interprets them, so the
 * policy is unit-testable with fakes. It never repairs or re-permissions anything.
 */
import * as path from "node:path";
import type { ShelfBindingStoragePaths } from "./shelf-binding-store.js";

export const WINDOWS_SYSTEM_SID = "S-1-5-18";
export const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";

/**
 * Access bits that let a principal change, replace, delete or re-permission an entry:
 * FILE_WRITE_DATA / FILE_ADD_FILE, FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY,
 * FILE_WRITE_EA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES, DELETE, WRITE_DAC,
 * WRITE_OWNER, MAXIMUM_ALLOWED, GENERIC_ALL and GENERIC_WRITE.
 */
export const WRITE_ACCESS_MASK = (
  0x0000_0002 | 0x0000_0004 | 0x0000_0010 | 0x0000_0040 | 0x0000_0100
  | 0x0001_0000 | 0x0004_0000 | 0x0008_0000
  | 0x0200_0000 | 0x1000_0000 | 0x4000_0000
) >>> 0;

export type AceType = "allow" | "deny" | "allow-object" | "deny-object" | "other";

export interface PathSecurityAce {
  readonly type: AceType;
  readonly sid: string;
  readonly mask: number;
  readonly inheritOnly: boolean;
}

export type PathSecurityFacts =
  | { readonly exists: false }
  | {
    readonly exists: true;
    readonly isDirectory: boolean;
    readonly isReparsePoint: boolean;
    readonly ownerSid: string;
    readonly currentUserSid: string;
    readonly daclPresent: boolean;
    readonly aces: readonly PathSecurityAce[];
  };

export type PathSecurityViolation =
  | "inspection-failed"
  | "missing"
  | "reparse-point"
  | "wrong-entry-type"
  | "owner-not-current-user"
  | "null-dacl"
  | "foreign-writer"
  | "unsupported-ace";

export type PathSecurityEvaluation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violation: PathSecurityViolation };

export type PathSecurityInspector = (target: string) => unknown;

const SID_PATTERN = /^S-1-\d+(?:-\d+)*$/u;
const ACE_TYPES: ReadonlySet<string> = new Set(["allow", "deny", "allow-object", "deny-object", "other"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strictly parse the addon result; anything unexpected is treated as an inspection failure. */
export function parsePathSecurityFacts(value: unknown): PathSecurityFacts | undefined {
  if (!isRecord(value) || typeof value.exists !== "boolean") return undefined;
  if (!value.exists) return Object.freeze({ exists: false as const });
  if (typeof value.isDirectory !== "boolean" || typeof value.isReparsePoint !== "boolean"
    || typeof value.ownerSid !== "string" || typeof value.currentUserSid !== "string"
    || !SID_PATTERN.test(value.currentUserSid)
    || typeof value.daclPresent !== "boolean" || !Array.isArray(value.aces)) return undefined;
  const aces: PathSecurityAce[] = [];
  for (const ace of value.aces as unknown[]) {
    if (!isRecord(ace) || typeof ace.type !== "string" || !ACE_TYPES.has(ace.type)
      || typeof ace.sid !== "string" || typeof ace.mask !== "number" || !Number.isInteger(ace.mask)
      || ace.mask < 0 || ace.mask > 0xffff_ffff || typeof ace.inheritOnly !== "boolean") return undefined;
    aces.push(Object.freeze({ type: ace.type as AceType, sid: ace.sid, mask: ace.mask, inheritOnly: ace.inheritOnly }));
  }
  return Object.freeze({
    exists: true as const,
    isDirectory: value.isDirectory,
    isReparsePoint: value.isReparsePoint,
    ownerSid: value.ownerSid,
    currentUserSid: value.currentUserSid,
    daclPresent: value.daclPresent,
    aces: Object.freeze(aces),
  });
}

function sameSid(left: string, right: string): boolean {
  return left.length > 0 && left.toUpperCase() === right.toUpperCase();
}

/** Apply the ownership/ACL rule to one entry. */
export function evaluatePathSecurity(
  facts: PathSecurityFacts,
  expected: "file" | "directory",
): PathSecurityEvaluation {
  if (!facts.exists) return Object.freeze({ ok: false, violation: "missing" });
  if (facts.isReparsePoint) return Object.freeze({ ok: false, violation: "reparse-point" });
  if (facts.isDirectory !== (expected === "directory")) return Object.freeze({ ok: false, violation: "wrong-entry-type" });
  if (!sameSid(facts.ownerSid, facts.currentUserSid)) return Object.freeze({ ok: false, violation: "owner-not-current-user" });
  // A NULL DACL grants everyone full control.
  if (!facts.daclPresent) return Object.freeze({ ok: false, violation: "null-dacl" });
  const trusted = [facts.currentUserSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID];
  for (const ace of facts.aces) {
    // Inherit-only entries (for example CREATOR OWNER templates) do not apply to this entry.
    if (ace.inheritOnly) continue;
    // Object-specific allows with a write-capable right fail closed.
    if (ace.type === "allow-object" && (ace.mask & WRITE_ACCESS_MASK) !== 0) {
      return Object.freeze({ ok: false, violation: "unsupported-ace" });
    }
    // The native addon reports mask 0 for ACE types it does not classify, so the rights
    // of an "other" ACE are unknown. Any such entry that applies here fails closed.
    if (ace.type === "other") {
      return Object.freeze({ ok: false, violation: "unsupported-ace" });
    }
    if (ace.type !== "allow" || (ace.mask & WRITE_ACCESS_MASK) === 0) continue;
    if (!trusted.some((sid) => sameSid(sid, ace.sid))) {
      return Object.freeze({ ok: false, violation: "foreign-writer" });
    }
  }
  return Object.freeze({ ok: true });
}

export function inspectAndEvaluatePathSecurity(
  inspect: PathSecurityInspector,
  target: string,
  expected: "file" | "directory",
  options: { readonly optional?: boolean } = {},
): PathSecurityEvaluation {
  let facts: PathSecurityFacts | undefined;
  try {
    facts = parsePathSecurityFacts(inspect(target));
  } catch {
    return Object.freeze({ ok: false, violation: "inspection-failed" });
  }
  if (facts === undefined) return Object.freeze({ ok: false, violation: "inspection-failed" });
  if (!facts.exists && options.optional === true) return Object.freeze({ ok: true });
  return evaluatePathSecurity(facts, expected);
}

export type CollectorStorageSecurityTarget = "application-root" | "binding-directory" | "binding-file" | "coordination-root";

export type CollectorStorageSecurityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly target: CollectorStorageSecurityTarget; readonly violation: PathSecurityViolation };

/**
 * Verify the fixed integration state before the binding may authorize a write: the
 * `MAGINALIA` application root, the binding directory, the binding file, and the
 * coordination root when it already exists (the writer creates it below the checked
 * application root otherwise).
 */
export function verifyCollectorStorageSecurity(
  paths: ShelfBindingStoragePaths,
  inspect: PathSecurityInspector,
): CollectorStorageSecurityResult {
  const applicationRoot = path.win32.dirname(paths.bindingDirectory);
  const checks: readonly [CollectorStorageSecurityTarget, string, "file" | "directory", boolean][] = [
    ["application-root", applicationRoot, "directory", false],
    ["binding-directory", paths.bindingDirectory, "directory", false],
    ["binding-file", paths.bindingPath, "file", false],
    ["coordination-root", paths.coordinationRoot, "directory", true],
  ];
  for (const [target, entry, expected, optional] of checks) {
    const result = inspectAndEvaluatePathSecurity(inspect, entry, expected, { optional });
    if (!result.ok) return Object.freeze({ ok: false, target, violation: result.violation });
  }
  return Object.freeze({ ok: true });
}
