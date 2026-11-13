import { describe, expect, it } from "vitest";
import {
  brandProgressUpdateScript,
  createBrandProgressState,
  normalizeBrandProgress,
  renderBrandProgressHtml,
  BRAND_FALLBACK_FONT_STACK,
  BRAND_FONT_FAMILY,
} from "./brand-progress";
import { PRODUCT_DISPLAY_NAME, RELEASE_CODENAME, brandVersionString } from "./branding";

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
    }, "0.2.0");

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
    const html = renderBrandProgressHtml({ logoDataUrl: null, markerDataUrl: null }, "0.2.0");

    expect(html).toContain("brand-fallback");
    expect(html).toContain(`MAGINALIA <small>${RELEASE_CODENAME} 0.2.0</small>`);
    expect(html).toContain('<div id="brand-art" class="brand-art" hidden>');
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

  describe("splash text rendering", () => {
    const images = { logoDataUrl: "data:image/png;base64,logo", markerDataUrl: null, fontDataUrl: "data:font/woff2;base64,Zm9udA==" };

    it("renders the codename and the injected version as real text below the art", () => {
      const html = renderBrandProgressHtml(images, "9.8.7");

      expect(html).toContain(`<p class="brand-line brand-line-1" id="brand-codename">${RELEASE_CODENAME}</p>`);
      expect(html).toContain('<p class="brand-line brand-line-2" id="brand-version">9.8.7</p>');
      expect(html).toContain(`alt="${PRODUCT_DISPLAY_NAME} 9.8.7"`);
      expect(html.indexOf('class="brand-image"')).toBeLessThan(html.indexOf('id="brand-codename"'));
    });

    it("reads the version through the injected source", () => {
      expect(brandVersionString({ getVersion: () => " 1.2.3 " })).toBe("1.2.3");
    });

    it("exposes the layout CSS variables with the specified defaults and container-relative units", () => {
      const html = renderBrandProgressHtml(images, "0.2.0");

      expect(html).toContain("container-type: inline-size");
      expect(html).toContain("--text-left: 17.8cqw;");
      expect(html).toContain("--line1-top: 4.5cqw;");
      expect(html).toContain("--line2-top: 10cqw;");
      expect(html).toContain("--text-size: 5cqw;");
      expect(html).toContain("--text-color: #1a1a1a;");
      expect(html).toContain("white-space: nowrap");
    });

    it("embeds the bundled font as a data URL, with the system stack as fallback and no network references", () => {
      const html = renderBrandProgressHtml(images, "0.2.0");

      expect(html).toContain(`@font-face { font-family: "${BRAND_FONT_FAMILY}"`);
      expect(html).toContain("url('data:font/woff2;base64,Zm9udA==')");
      expect(html).toContain("font-src data:");
      expect(html).toContain(`--brand-font: "${BRAND_FONT_FAMILY}", ${BRAND_FALLBACK_FONT_STACK}`);
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).not.toContain("fonts.googleapis");
    });

    it("omits @font-face but keeps the fallback stack when the font is unavailable", () => {
      const html = renderBrandProgressHtml({ ...images, fontDataUrl: null }, "0.2.0");

      expect(html).not.toContain("@font-face");
      expect(html).toContain(BRAND_FALLBACK_FONT_STACK);
      expect(html).toContain('id="brand-codename"');
    });

    it("escapes the injected version", () => {
      const html = renderBrandProgressHtml(images, '<b>"x"</b>');

      expect(html).not.toContain("<b>");
    });
  });
});
