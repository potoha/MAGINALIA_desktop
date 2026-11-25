import { matchesWhen, type CommandContext } from "./command-context";

export interface CommandDescriptor {
  readonly id: string;
  readonly title: string;
  /** Short action summary shared by Palette and future discovery surfaces. */
  readonly description?: string;
  readonly category?: string;
  readonly keywords?: readonly string[];
  readonly when?: string;
  /** Internal commands remain executable but are omitted from public discovery surfaces by default. */
  readonly visibility?: "public" | "internal";
}

export interface CommandTextRange {
  /** UTF-16 offset into the original command title, with an exclusive end. */
  readonly start: number;
  readonly end: number;
}

export interface CommandSearchResult {
  readonly descriptor: CommandDescriptor;
  readonly relevance: number;
  readonly titleMatches: readonly CommandTextRange[];
  readonly categoryMatches: readonly CommandTextRange[];
  readonly descriptionMatches: readonly CommandTextRange[];
}

export interface CommandTextSearchMatch {
  readonly relevance: number;
  readonly matches: readonly CommandTextRange[];
}

/**
 * Optional, bounded invocation arguments. Values are opaque scalar strings
 * (for example a document, file, or annotation ID) so a surface can target a
 * concrete object without inventing a private action path. Commands that can
 * only run with arguments are registered as `internal`, which keeps them out of
 * the Palette, Shortcut Editor, and native menu.
 */
export type CommandArgs = Readonly<Record<string, string>>;
export type CommandHandler = (args?: CommandArgs) => void | Promise<void>;
export type CommandOrigin = "core" | "mod";

interface RegisteredCommand {
  readonly descriptor: CommandDescriptor;
  readonly handler: CommandHandler;
  readonly origin: CommandOrigin;
}

export type CommandExecutionResult =
  | { readonly kind: "executed" }
  | { readonly kind: "disabled" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly error: Error };

function validDescriptor(value: CommandDescriptor): boolean {
  return /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/iu.test(value.id)
    && value.title.trim().length > 0
    && value.id.length <= 200
    && (value.description === undefined || (typeof value.description === "string" && value.description.trim().length > 0 && value.description.length <= 500))
    && (value.visibility === undefined || value.visibility === "public" || value.visibility === "internal");
}

/** Workbench-owned command routing with failure isolation for Core and Mods. */
export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly listeners = new Set<() => void>();

  public register(descriptor: CommandDescriptor, handler: CommandHandler, origin: CommandOrigin = "core"): () => void {
    if (!validDescriptor(descriptor)) throw new Error("Invalid command descriptor.");
    if (this.commands.has(descriptor.id)) throw new Error(`Command already registered: ${descriptor.id}`);
    const registered: RegisteredCommand = {
      descriptor: Object.freeze({
        ...descriptor,
        description: descriptor.description?.trim() || descriptor.title.trim(),
        keywords: Object.freeze([...(descriptor.keywords ?? [])]),
        visibility: descriptor.visibility ?? "public"
      }),
      handler,
      origin
    };
    this.commands.set(descriptor.id, registered);
    this.notify();
    return () => this.unregisterIfCurrent(descriptor.id, registered);
  }

  public unregister(id: string): boolean {
    const removed = this.commands.delete(id);
    if (removed) this.notify();
    return removed;
  }

  private unregisterIfCurrent(id: string, expected: RegisteredCommand): boolean {
    if (this.commands.get(id) !== expected) return false;
    this.commands.delete(id);
    this.notify();
    return true;
  }

  public get(id: string): CommandDescriptor | null { return this.commands.get(id)?.descriptor ?? null; }

  public list(context: CommandContext, includeDisabled = false, includeInternal = false): readonly CommandDescriptor[] {
    return [...this.commands.values()]
      .filter(({ descriptor }) => (includeInternal || descriptor.visibility !== "internal")
        && (includeDisabled || matchesWhen(context, descriptor.when)))
      .map(({ descriptor }) => descriptor)
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }

  public discover(query: string, context: CommandContext, includeInternal = false): readonly CommandDescriptor[] {
    return this.search(query, context, includeInternal).map(({ descriptor }) => descriptor);
  }

  /** Finds visible, enabled commands and orders non-empty searches by relevance. */
  public search(query: string, context: CommandContext, includeInternal = false): readonly CommandSearchResult[] {
    const normalized = query.trim().toLocaleLowerCase();
    const tokens = normalized.length === 0 ? [] : normalized.split(/\s+/u);
    const results: CommandSearchResult[] = [];

    for (const descriptor of this.list(context, false, includeInternal)) {
      if (tokens.length === 0) {
        results.push({ descriptor, relevance: 0, titleMatches: [], categoryMatches: [], descriptionMatches: [] });
        continue;
      }

      const fields: readonly { readonly value: string; readonly weight: number }[] = [
        { value: descriptor.title, weight: 650 },
        { value: descriptor.category ?? "", weight: 280 },
        { value: descriptor.description ?? "", weight: 240 },
        { value: descriptor.id, weight: 180 },
        ...(descriptor.keywords ?? []).map((value) => ({ value, weight: 140 }))
      ];
      let relevance = 0;
      const titlePositions = new Map<number, number>();
      const categoryPositions = new Map<number, number>();
      const descriptionPositions = new Map<number, number>();
      let matchesEveryToken = true;

      for (const token of tokens) {
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const field of fields) {
          const match = fuzzyTextMatch(field.value, token);
          if (match === null) continue;
          bestScore = Math.max(bestScore, field.weight + match.score);
        }
        if (!Number.isFinite(bestScore)) {
          matchesEveryToken = false;
          break;
        }
        relevance += bestScore;

        collectPositions(titlePositions, fuzzyTextMatch(descriptor.title, token));
        collectPositions(categoryPositions, fuzzyTextMatch(descriptor.category ?? "", token));
        collectPositions(descriptionPositions, fuzzyTextMatch(descriptor.description ?? "", token));
      }

      if (!matchesEveryToken) continue;
      results.push({
        descriptor,
        relevance,
        titleMatches: compressRanges([...titlePositions].map(([start, end]) => ({ start, end }))
          .sort((left, right) => left.start - right.start)),
        categoryMatches: compressRanges([...categoryPositions].map(([start, end]) => ({ start, end }))
          .sort((left, right) => left.start - right.start)),
        descriptionMatches: compressRanges([...descriptionPositions].map(([start, end]) => ({ start, end }))
          .sort((left, right) => left.start - right.start))
      });
    }

    return results.sort((left, right) => right.relevance - left.relevance
      || left.descriptor.title.localeCompare(right.descriptor.title)
      || left.descriptor.id.localeCompare(right.descriptor.id));
  }

  public async execute(id: string, context: CommandContext, args?: CommandArgs): Promise<CommandExecutionResult> {
    const command = this.commands.get(id);
    if (command === undefined) return { kind: "missing" };
    if (!matchesWhen(context, command.descriptor.when)) return { kind: "disabled" };
    const invocationArgs = args === undefined ? undefined : copyCommandArgs(args);
    if (invocationArgs === null) return { kind: "failed", error: new Error("Invalid command arguments.") };
    try {
      await command.handler(invocationArgs);
      return { kind: "executed" };
    } catch (error: unknown) {
      return { kind: "failed", error: error instanceof Error ? error : new Error("Command failed.") };
    }
  }

  public onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* one surface cannot break commands */ }
    }
  }
}

const MAX_COMMAND_ARGS = 8;
const MAX_COMMAND_ARG_LENGTH = 4_096;

/** Accept only a small plain record of string values; anything else is rejected. */
function copyCommandArgs(value: unknown): CommandArgs | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_COMMAND_ARGS) return null;
  const copy: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!/^[a-z][a-zA-Z0-9]*$/u.test(key) || typeof entry !== "string" || entry.length > MAX_COMMAND_ARG_LENGTH) return null;
    copy[key] = entry;
  }
  return Object.freeze(copy);
}

interface FuzzyTextMatch {
  readonly score: number;
  readonly positions: readonly CommandTextRange[];
}

interface NormalizedCharacter {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function collectPositions(target: Map<number, number>, match: FuzzyTextMatch | null): void {
  match?.positions.forEach(({ start, end }) => target.set(start, end));
}

/** Rank and highlight one visible name using the same Unicode-aware fuzzy matcher as commands. */
export function searchCommandText(value: string, query: string): CommandTextSearchMatch | null {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return { relevance: 0, matches: [] };
  const positions = new Map<number, number>();
  let relevance = 0;
  for (const token of tokens) {
    const match = fuzzyTextMatch(value, token);
    if (match === null) return null;
    relevance += match.score;
    collectPositions(positions, match);
  }
  return {
    relevance,
    matches: compressRanges([...positions].map(([start, end]) => ({ start, end }))
      .sort((left, right) => left.start - right.start))
  };
}

function fuzzyTextMatch(text: string, needle: string): FuzzyTextMatch | null {
  const characters: NormalizedCharacter[] = [];
  let offset = 0;
  for (const original of Array.from(text)) {
    for (const value of Array.from(original.toLocaleLowerCase())) {
      characters.push({ value, start: offset, end: offset + original.length });
    }
    offset += original.length;
  }
  const query = Array.from(needle.toLocaleLowerCase());
  if (query.length === 0 || query.length > characters.length) return null;

  const values = characters.map(({ value }) => value);
  const sequenceAt = (start: number): boolean => query.every((character, index) => values[start + index] === character);
  let positions: number[] | null = null;
  let quality = 0;

  if (values.length === query.length && sequenceAt(0)) {
    positions = query.map((_character, index) => index);
    quality = 900;
  } else if (values.length >= query.length && sequenceAt(0)) {
    positions = query.map((_character, index) => index);
    quality = 780;
  } else {
    for (let start = 0; start <= values.length - query.length; start += 1) {
      if (sequenceAt(start)) {
        positions = query.map((_character, index) => start + index);
        const boundary = start === 0 || /[\s._:/\\-]/u.test(values[start - 1] ?? "");
        quality = boundary ? 690 : 590;
        break;
      }
    }

    if (positions === null) {
      const candidate: number[] = [];
      let cursor = 0;
      for (const character of query) {
        while (cursor < values.length && values[cursor] !== character) cursor += 1;
        if (cursor === values.length) return null;
        candidate.push(cursor);
        cursor += 1;
      }
      positions = candidate;
      const gaps = candidate[candidate.length - 1] - candidate[0] + 1 - candidate.length;
      quality = 420 - gaps * 8;
    }
  }

  const first = positions[0] ?? 0;
  const gaps = positions[positions.length - 1]! - first + 1 - positions.length;
  const score = quality - first * 2 - gaps * 5 - Math.max(0, values.length - query.length) * 0.1;
  return {
    score,
    positions: positions.map((position) => ({ start: characters[position]!.start, end: characters[position]!.end }))
  };
}

function compressRanges(positions: readonly CommandTextRange[]): readonly CommandTextRange[] {
  if (positions.length === 0) return [];
  const ranges: CommandTextRange[] = [];
  let start = positions[0]!.start;
  let end = positions[0]!.end;
  for (const position of positions.slice(1)) {
    if (position.start <= end) {
      end = Math.max(end, position.end);
      continue;
    }
    ranges.push({ start, end });
    start = position.start;
    end = position.end;
  }
  ranges.push({ start, end });
  return ranges;
}
