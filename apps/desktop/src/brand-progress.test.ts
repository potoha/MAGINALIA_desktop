import { describe, expect, it } from "vitest";
import {
  brandProgressUpdateScript,
  createBrandProgressState,
  normalizeBrandProgress,
  renderBrandProgressHtml,
} from "./brand-progress";

describe("brand progress presentation", () => {
  it("keeps determinate progress numeric and clamps it to 0..1", () => {
    expect(normalizeBrandProgress(-0.2)).toBe(0);
    expect(normalizeBrandProgress(0.45)).toBe(0.45);
    expect(normalizeBrandProgress(1.4)).toBe(1);
    expect(normalizeBrandProgress(Number.NaN)).toBeNull();
    expect(normalizeBrandProgress(null)).toBeNull();
  });

  it("renders an accessible determinate progress bar with the supplied artwork", () => {
    const html = renderBrandProgressHtml({
      logoDataUrl: "data:image/png;base64,logo",
      markerDataUrl: "data:image/png;base64,marker",
    });

    expect(html).toContain("aria-valuemin=\"0\"");
    expect(html).toContain("aria-valuemax=\"100\"");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("clip-path: inset(0 100% 0 0)");
    expect(html).toContain("transition: clip-path var(--motion) linear");
    expect(html).toContain('messagePaint.style.clipPath = "inset(0 " + clippedPercent + " 0 0)"');
    expect(html).not.toContain("transform: scaleX(var(--progress");
    expect(html).toContain("data:image/png;base64,logo");
    expect(html).toContain("data:image/png;base64,marker");
    expect(html).toContain("MAGINALIA Alpha2 Wild Berry");
  });

  it("has a readable fallback when one or both branded images are unavailable", () => {
    const html = renderBrandProgressHtml({ logoDataUrl: null, markerDataUrl: null });

    expect(html).toContain("brand-fallback");
    expect(html).toContain("MAGINALIA <small>α2 wild berry</small>");
    expect(html).toContain("linear-gradient(93deg, #baff13");
    expect(html).toContain("clip-path: inset(0 58% 0 0)");
  });

  it("updates status text without treating it as markup and retains a numeric fraction", () => {
    const state = createBrandProgressState("Loading <Project>", 0.6);
    const script = brandProgressUpdateScript(state);

    expect(script).toContain(JSON.stringify({ message: "Loading <Project>", progress: 0.6 }));
    expect(script).toContain("maginaliaBrandProgress?.update");
    expect(state.progress).toBe(0.6);
  });
});
