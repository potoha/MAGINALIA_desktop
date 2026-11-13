/**
 * Version comparison for the Collector integration (design 6, "Compatibility checks").
 *
 * Accepts the shapes that occur in practice: Chrome extension versions (1 to 4 numeric
 * components) and Desktop / Host versions (`major.minor.patch` with an optional
 * pre-release and build suffix). Anything else is `unparseable`, never silently equal.
 */

const VERSION_PATTERN = /^(\d{1,9}(?:\.\d{1,9}){0,3})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,31}))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/u;

export type VersionComparison = "equal" | "older" | "newer" | "unparseable";

interface ParsedVersion {
  readonly numbers: readonly number[];
  readonly prerelease: readonly string[];
}

export function parseCollectorVersion(value: unknown): ParsedVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  const numbers = (match[1] as string).split(".").map(Number);
  const prerelease = match[2] === undefined ? [] : match[2].split(".");
  if (prerelease.some((part) => part.length === 0)) return undefined;
  return { numbers, prerelease };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  // A release (no pre-release part) is newer than any pre-release of the same numbers.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/** Compares `installed` against `expected`: `older` means the installed one is behind. */
export function compareCollectorVersions(installed: unknown, expected: unknown): VersionComparison {
  const a = parseCollectorVersion(installed);
  const b = parseCollectorVersion(expected);
  if (a === undefined || b === undefined) return "unparseable";
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.numbers[index] ?? 0;
    const y = b.numbers[index] ?? 0;
    if (x !== y) return x < y ? "older" : "newer";
  }
  const pre = comparePrerelease(a.prerelease, b.prerelease);
  return pre === 0 ? "equal" : pre < 0 ? "older" : "newer";
}
