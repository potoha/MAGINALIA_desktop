import { describe, expect, it, vi } from "vitest";
import type { CanonicalShelfSearchReference } from "../shelf-ipc";
import {
  createShelfSourceUrlElement,
  DEFAULT_CANONICAL_SHELF_SEARCH_FIELDS,
  filterCanonicalShelfResults,
} from "./shelf-search-view";

const withUrl: CanonicalShelfSearchReference = {
  annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sourceId: "book:01ARZ3NDEKTSV4RRFFQ69G0000",
  quote: "Collector quote text",
  title: "Web source",
  authors: [],
  url: "https://example.com/distinctive-path",
};

const withoutUrl: CanonicalShelfSearchReference = {
  annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAW",
  sourceId: "isbn:9780306406157",
  quote: "Legacy quote text",
  title: "Print source",
  authors: [],
};

describe("canonical Shelf search presentation", () => {
  it("includes URL in the default field set and filters URL-only, quote-only, and combined searches", () => {
    expect(DEFAULT_CANONICAL_SHELF_SEARCH_FIELDS).toContain("url");

    expect(filterCanonicalShelfResults([withUrl, withoutUrl], "distinctive-path", new Set(["url"])))
      .toEqual([withUrl]);
    expect(filterCanonicalShelfResults([withUrl, withoutUrl], "Collector quote", new Set(["quote"])))
      .toEqual([withUrl]);
    expect(filterCanonicalShelfResults([withUrl, withoutUrl], "distinctive-path", new Set(["url", "quote"])))
      .toEqual([withUrl]);
    expect(filterCanonicalShelfResults([withUrl, withoutUrl], "distinctive-path", new Set(["quote"])))
      .toEqual([]);
    expect(filterCanonicalShelfResults([withUrl, withoutUrl], "", new Set(["url"])))
      .toEqual([withUrl, withoutUrl]);
  });

  it("renders an optional URL as text and omits it for records without provenance", () => {
    const span = { className: "", textContent: "" };
    const document = { createElement: vi.fn(() => span) } as unknown as Document;

    const rendered = createShelfSourceUrlElement(withUrl.url, document);
    expect(rendered).toBe(span);
    expect(rendered).toMatchObject({ className: "shelf-source-url", textContent: `URL: ${withUrl.url}` });
    expect(document.createElement).toHaveBeenCalledWith("span");
    expect(createShelfSourceUrlElement(withoutUrl.url, document)).toBeNull();
    expect(document.createElement).toHaveBeenCalledTimes(1);
  });
});
