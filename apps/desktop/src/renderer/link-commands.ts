import { parseInternalLinks } from "../project-links";
import type { CommandArgs, CommandRegistry } from "./command-registry";

export const OPEN_INTERNAL_LINK_COMMAND_ID = "maginalia.link.openInTab";
export const OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID = "maginalia.link.openInternalAtCursor";
export const OPEN_EXTERNAL_LINK_COMMAND_ID = "maginalia.link.openExternal";
export const OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID = "maginalia.link.openExternalAtCursor";

const EXTERNAL_LINK = /\[[^\]]+\]\((https?:\/\/[^)\s]*)\)/gu;

function lineBounds(text: string, offset: number): { readonly start: number; readonly end: number } {
  const clamped = Math.max(0, Math.min(text.length, offset));
  const start = text.lastIndexOf("\n", Math.max(0, clamped - 1)) + 1;
  const newline = text.indexOf("\n", clamped);
  return { start: clamped === 0 ? 0 : start, end: newline < 0 ? text.length : newline };
}

/**
 * The Project wiki-link target under the caret, or the first one on the caret
 * line (matching the line-scoped `editor.linkType` context key).
 */
export function internalLinkTargetAtOffset(text: string, offset: number): string | null {
  const { start, end } = lineBounds(text, offset);
  const links = parseInternalLinks(text).filter((link) => link.kind === "link" && link.start >= start && link.end <= end);
  const containing = links.find((link) => link.start <= offset && offset <= link.end);
  const link = containing ?? links[0];
  return link !== undefined && link.kind === "link" ? link.target : null;
}

/** The HTTP(S) Markdown link URL under the caret, or the first one on the caret line. */
export function externalLinkUrlAtOffset(text: string, offset: number): string | null {
  const { start, end } = lineBounds(text, offset);
  const line = text.slice(start, end);
  let first: string | null = null;
  for (const match of line.matchAll(EXTERNAL_LINK)) {
    const url = match[1] ?? "";
    const matchStart = start + (match.index ?? 0);
    const matchEnd = matchStart + match[0].length;
    if (matchStart <= offset && offset <= matchEnd) return url;
    first ??= url;
  }
  return first;
}

/** Renderer-side pre-check only; the main process revalidates before opening. */
export function isOpenableExternalUrl(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || /[\u0000-\u001F\u007F]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

export interface LinkCommandDependencies {
  /** Active authoring text and caret offset, or null without a document. */
  readonly getCaret: () => { readonly text: string; readonly offset: number } | null;
  /** Resolve a wiki-link target to an opaque file ID in the active Project. */
  readonly resolveInternalTarget: (target: string) => Promise<string | null>;
  /** Open an opaque Project file ID through Project navigation (tab). */
  readonly openInternalFile: (fileId: string) => Promise<void>;
  /** Main-process validated opener; null when this runtime has none. */
  readonly openExternal: ((url: string) => Promise<{ readonly kind: "opened" } | { readonly kind: "error"; readonly message: string }>) | null;
}

/**
 * One implementation per link action. Argument commands serve Preview clicks;
 * the "at cursor" commands serve the editor context menu and the Palette.
 */
export function registerLinkCommands(registry: CommandRegistry, dependencies: LinkCommandDependencies): void {
  const openExternal = async (url: string): Promise<void> => {
    if (!isOpenableExternalUrl(url)) throw new Error("The external link is not an allowed HTTP(S) URL.");
    const opener = dependencies.openExternal;
    if (opener === null) throw new Error("Opening external links is unavailable.");
    const result = await opener(url);
    if (result.kind !== "opened") throw new Error(result.message);
  };

  registry.register({
    id: OPEN_INTERNAL_LINK_COMMAND_ID,
    title: "Open Internal Link in Tab",
    description: "Open a resolved Project link target in a document tab.",
    category: "Links",
    keywords: ["wiki", "internal", "tab"],
    when: "editor.hasDocument && project.active",
    visibility: "internal"
  }, async (args?: CommandArgs) => {
    const fileId = args?.fileId;
    if (fileId === undefined || fileId.length === 0) throw new Error("The internal link is no longer available.");
    await dependencies.openInternalFile(fileId);
  });

  registry.register({
    id: OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID,
    title: "Open Internal Link at Cursor",
    description: "Open the Project link at the cursor in a document tab.",
    category: "Links",
    keywords: ["wiki", "internal", "tab", "open", "リンク"],
    when: "editor.hasDocument && project.active && editor.linkType == internal"
  }, async () => {
    const caret = dependencies.getCaret();
    const target = caret === null ? null : internalLinkTargetAtOffset(caret.text, caret.offset);
    if (target === null) throw new Error("No Project link is at the cursor.");
    const fileId = await dependencies.resolveInternalTarget(target);
    if (fileId === null) throw new Error("The linked Project document was not found.");
    await dependencies.openInternalFile(fileId);
  });

  registry.register({
    id: OPEN_EXTERNAL_LINK_COMMAND_ID,
    title: "Open External Link",
    description: "Open an HTTP(S) link in the system browser after main-process validation.",
    category: "Links",
    keywords: ["url", "browser", "external"],
    when: "link.externalAvailable",
    visibility: "internal"
  }, async (args?: CommandArgs) => {
    const url = args?.url;
    if (url === undefined) throw new Error("Choose an external link to open.");
    await openExternal(url);
  });

  registry.register({
    id: OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID,
    title: "Open External Link at Cursor",
    description: "Open the HTTP(S) link at the cursor in the system browser.",
    category: "Links",
    keywords: ["url", "browser", "external", "open", "リンク"],
    when: "editor.hasDocument && link.externalAvailable && editor.linkType == external"
  }, async () => {
    const caret = dependencies.getCaret();
    const url = caret === null ? null : externalLinkUrlAtOffset(caret.text, caret.offset);
    if (url === null) throw new Error("No external link is at the cursor.");
    await openExternal(url);
  });
}
