import type { CanonicalShelfSearchReference } from "../shelf-ipc";
import { normalizeSearchText } from "./unified-search";

export type CanonicalShelfSearchField = "quote" | "privateMemo" | "title" | "authors" | "page" | "url";

export const DEFAULT_CANONICAL_SHELF_SEARCH_FIELDS: readonly CanonicalShelfSearchField[] = Object.freeze([
  "quote", "privateMemo", "title", "authors", "page", "url"
]);

export function filterCanonicalShelfResults(
  results: readonly CanonicalShelfSearchReference[],
  query: string,
  fields: ReadonlySet<CanonicalShelfSearchField>
): readonly CanonicalShelfSearchReference[] {
  if (fields.size === 0) return [];
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return results;
  return results.filter((reference) => (
    (fields.has("quote") && normalizeSearchText(reference.quote).includes(normalizedQuery))
    || (fields.has("privateMemo") && normalizeSearchText(reference.privateMemo ?? "").includes(normalizedQuery))
    || (fields.has("title") && normalizeSearchText(reference.title).includes(normalizedQuery))
    || (fields.has("authors") && reference.authors.some((author) => normalizeSearchText(author).includes(normalizedQuery)))
    || (fields.has("page") && reference.page !== undefined && normalizeSearchText(String(reference.page)).includes(normalizedQuery))
    || (fields.has("url") && reference.url !== undefined && normalizeSearchText(reference.url).includes(normalizedQuery))
  ));
}

export function createShelfSourceUrlElement(url: string | undefined, document: Document): HTMLSpanElement | null {
  if (url === undefined) return null;
  const element = document.createElement("span");
  element.className = "shelf-source-url";
  element.textContent = `URL: ${url}`;
  return element;
}
