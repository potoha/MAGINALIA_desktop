import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_BROWSERS,
  COLLECTOR_BROWSER_IDS,
  COLLECTOR_CORE_EVIDENCE_FIELDS,
  COLLECTOR_PRESENTATION_EVIDENCE_FIELDS,
  COLLECTOR_REGISTRY_TARGETS,
  COLLECTOR_REGISTRY_TARGET_IDS,
  classifyDefaultBrowser,
  collectorBrowserPresentationEvidenceGaps,
  collectorBrowserReleaseGateViolations,
  effectiveRegistration,
  recommendCollectorBrowser,
  type CollectorBrowserDetection,
  type CollectorBrowserId,
  type CollectorBrowserSpec,
  type CollectorRecommendationInput,
} from "./collector-browser-table";

const row = (id: CollectorBrowserId): CollectorBrowserSpec => {
  const found = COLLECTOR_BROWSERS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`row ${id}`);
  return found;
};

/** Same rows with Edge and Vivaldi forced to "verified" (for logic tests; the evidence is not asserted here). */
function allVerifiedTable(): readonly CollectorBrowserSpec[] {
  return COLLECTOR_BROWSERS.map((entry) => ({ ...entry, verification: "verified" }) as CollectorBrowserSpec);
}

const FOUND: CollectorBrowserDetection = { installed: "found", policyBlocked: false };
const MISSING: CollectorBrowserDetection = { installed: "not-found", policyBlocked: false };
const UNKNOWN: CollectorBrowserDetection = { installed: "unknown", policyBlocked: false };
const BLOCKED: CollectorBrowserDetection = { installed: "found", policyBlocked: true };

function recommend(input: CollectorRecommendationInput, table: readonly CollectorBrowserSpec[] = allVerifiedTable()) {
  return recommendCollectorBrowser(input, table);
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe("collector browser table: shape", () => {
  it("has exactly Edge, Chrome, Vivaldi in recommendation order", () => {
    expect(COLLECTOR_BROWSERS.map((entry) => entry.id)).toEqual([...COLLECTOR_BROWSER_IDS]);
    expect([...COLLECTOR_BROWSER_IDS]).toEqual(["edge", "chrome", "vivaldi"]);
  });

  it("is deep-frozen (rows, registry targets and nested arrays)", () => {
    expect(isDeepFrozen(COLLECTOR_BROWSERS)).toBe(true);
    expect(isDeepFrozen(COLLECTOR_REGISTRY_TARGETS)).toBe(true);
    expect(() => {
      (COLLECTOR_BROWSERS[0] as { displayName: string }).displayName = "x";
    }).toThrow(TypeError);
    expect(() => {
      (COLLECTOR_BROWSERS[0]!.nativeMessaging.lookupOrder as string[]).push("x");
    }).toThrow(TypeError);
  });

  it("registry targets: chrome and edge writable, chromium and vivaldi read-only, all HKCU-relative", () => {
    expect(COLLECTOR_REGISTRY_TARGETS.map((target) => target.id).sort()).toEqual([...COLLECTOR_REGISTRY_TARGET_IDS].sort());
    const writable = COLLECTOR_REGISTRY_TARGETS.filter((target) => target.writable).map((target) => target.id);
    expect(writable).toEqual(["chrome", "edge"]);
    for (const target of COLLECTOR_REGISTRY_TARGETS) {
      expect(target.subkey).toMatch(/^Software\\[A-Za-z]+(\\[A-Za-z]+)?\\NativeMessagingHosts\\org\.maginalia\.collector$/u);
    }
    expect(COLLECTOR_REGISTRY_TARGETS.find((t) => t.id === "chrome")?.subkey)
      .toBe("Software\\Google\\Chrome\\NativeMessagingHosts\\org.maginalia.collector");
    expect(COLLECTOR_REGISTRY_TARGETS.find((t) => t.id === "edge")?.subkey)
      .toBe("Software\\Microsoft\\Edge\\NativeMessagingHosts\\org.maginalia.collector");
  });

  it("every row references only known targets and owns only writable ones inside its lookup order", () => {
    const writable = new Set(COLLECTOR_REGISTRY_TARGETS.filter((t) => t.writable).map((t) => t.id));
    for (const entry of COLLECTOR_BROWSERS) {
      for (const id of entry.nativeMessaging.lookupOrder) expect(COLLECTOR_REGISTRY_TARGET_IDS).toContain(id);
      for (const id of entry.nativeMessaging.ownTargets) {
        expect(writable.has(id)).toBe(true);
        expect(entry.nativeMessaging.lookupOrder).toContain(id);
      }
      expect(entry.executable.fileName.toLowerCase()).toBe(entry.executable.fileName);
      expect(entry.executable.fileName.endsWith(".exe")).toBe(true);
      expect(entry.extensionsPage.launchArguments.length).toBeGreaterThan(0);
      if (entry.downloadUrl !== null) expect(entry.downloadUrl.startsWith("https://")).toBe(true);
    }
  });

  it("Edge looks up Edge, Chromium, then Chrome (documented) and owns only the Edge key", () => {
    expect(row("edge").nativeMessaging.lookupOrder).toEqual(["edge", "chromium", "chrome"]);
    expect(row("edge").nativeMessaging.ownTargets).toEqual(["edge"]);
    expect(row("chrome").nativeMessaging.lookupOrder).toEqual(["chrome"]);
    expect(row("chrome").nativeMessaging.ownTargets).toEqual(["chrome"]);
  });

  it("every row carries evidence for every core and presentation field", () => {
    for (const entry of COLLECTOR_BROWSERS) {
      for (const field of [...COLLECTOR_CORE_EVIDENCE_FIELDS, ...COLLECTOR_PRESENTATION_EVIDENCE_FIELDS]) {
        expect(["measured", "vendor-doc", "code", "unverified"]).toContain((entry.evidence as Record<string, string>)[field]);
      }
    }
  });
});

describe("collector browser table: verification and release gate", () => {
  it("Vivaldi stays unverified, registers nothing and is never offered", () => {
    const vivaldi = row("vivaldi");
    expect(vivaldi.verification).toBe("unverified");
    expect(vivaldi.nativeMessaging.lookupOrder).toEqual([]);
    expect(vivaldi.nativeMessaging.ownTargets).toEqual([]);
    expect(vivaldi.evidence.lookupOrder).toBe("unverified");
    expect(vivaldi.evidence.ownTargets).toBe("unverified");
    expect(COLLECTOR_REGISTRY_TARGETS.find((t) => t.id === "vivaldi")?.writable).toBe(false);
  });

  it("Edge stays unverified until its stable ProgId is measured", () => {
    expect(row("edge").verification).toBe("unverified");
    expect(row("edge").evidence.progIdPattern).toBe("unverified");
  });

  it("verified rows carry no unverified core evidence (release gate)", () => {
    expect(COLLECTOR_BROWSERS.some((entry) => entry.verification === "verified")).toBe(true);
    expect(collectorBrowserReleaseGateViolations()).toEqual([]);
    for (const entry of COLLECTOR_BROWSERS) {
      if (entry.verification !== "verified") continue;
      for (const field of COLLECTOR_CORE_EVIDENCE_FIELDS) expect(entry.evidence[field]).not.toBe("unverified");
    }
  });

  it("the gate fires when an unverified row is switched to verified without evidence", () => {
    const vivaldiVerified = { ...row("vivaldi"), verification: "verified" } as CollectorBrowserSpec;
    const edgeVerified = { ...row("edge"), verification: "verified" } as CollectorBrowserSpec;
    expect(collectorBrowserReleaseGateViolations([vivaldiVerified])).toEqual([
      "vivaldi.lookupOrder", "vivaldi.ownTargets", "vivaldi.registration", "vivaldi.policyRoot",
    ]);
    expect(collectorBrowserReleaseGateViolations([edgeVerified])).toEqual(["edge.progIdPattern"]);
    expect(collectorBrowserReleaseGateViolations([row("vivaldi"), row("edge")])).toEqual([]);
  });

  it("a verified row missing an evidence entry is a violation", () => {
    const broken = { ...row("chrome"), evidence: { ...row("chrome").evidence, lookupOrder: undefined } } as unknown as CollectorBrowserSpec;
    expect(collectorBrowserReleaseGateViolations([broken])).toEqual(["chrome.lookupOrder"]);
  });

  it("presentation evidence gaps are reported for the later (S8/S10) gate, not hidden", () => {
    expect(collectorBrowserPresentationEvidenceGaps()).toEqual(["chrome.extensionsPage", "chrome.ui", "chrome.downloadUrl"]);
  });
});

describe("classifyDefaultBrowser", () => {
  const cases: ReadonlyArray<readonly [string | null, string]> = [
    [null, "unknown"],
    ["", "unknown"],
    ["   ", "unknown"],
    ["VivaldiHTM", "vivaldi"],
    ["VivaldiHTM.ABC123", "vivaldi"],
    ["MSEdgeHTM", "edge"],
    ["msedgehtm", "edge"],
    ["ChromeHTML", "chrome"],
    ["ChromeHTML.X", "chrome"],
    ["ChromeHTML.ABC123", "chrome"],
    ["MSEdgeBHTML", "other-chromium"],
    ["MSEdgeDHTML", "other-chromium"],
    ["MSEdgeSHTML", "other-chromium"],
    ["ChromeBHTML", "other-chromium"],
    ["ChromeSSHTM", "other-chromium"],
    ["BraveHTML", "other-chromium"],
    ["OperaStable", "other-chromium"],
    ["ChromiumHTM", "other-chromium"],
    ["FirefoxURL-308046B0AF4A39CB", "other"],
    ["FirefoxURL", "other"],
    ["SafariHTML", "other"],
    ["ChromeHTMLevil", "other"],
    ["ChromeHTML.", "other"],
    ["ChromeHTML.a.b", "other"],
    ["VivaldiHTMevil", "other"],
    ["MSEdgeHTM.x", "other"],
    ["XChromeHTML", "other"],
  ];
  for (const [progId, kind] of cases) {
    it(`${JSON.stringify(progId)} -> ${kind}`, () => {
      expect(classifyDefaultBrowser(progId)).toBe(kind);
    });
  }

  it("classifies against a supplied table only", () => {
    expect(classifyDefaultBrowser("VivaldiHTM", [row("chrome")])).toBe("other");
    expect(classifyDefaultBrowser("ChromeHTML", [row("chrome")])).toBe("chrome");
  });

  it("classification does not depend on verification", () => {
    expect(classifyDefaultBrowser("VivaldiHTM")).toBe("vivaldi");
    expect(row("vivaldi").verification).toBe("unverified");
  });
});

describe("recommendCollectorBrowser (all rows verified for logic tests)", () => {
  it("default-supported: the default browser itself", () => {
    expect(recommend({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }))
      .toEqual({ recommended: "vivaldi", reason: "default-supported" });
    expect(recommend({ defaultBrowser: "chrome", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: "chrome", reason: "default-supported" });
  });

  it("default-unsupported: Firefox or similar falls back to Edge", () => {
    expect(recommend({ defaultBrowser: "other", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: "edge", reason: "default-unsupported" });
  });

  it("default-unsupported with Edge missing falls back to the next installed row", () => {
    expect(recommend({ defaultBrowser: "other", detections: { edge: MISSING, chrome: FOUND } }))
      .toEqual({ recommended: "chrome", reason: "default-unsupported" });
  });

  it("default-unverified: another Chromium (Brave etc.)", () => {
    expect(recommend({ defaultBrowser: "other-chromium", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: "edge", reason: "default-unverified" });
  });

  it("default-unverified: a table row that is not verified", () => {
    // Real table: only Chrome is verified, so a Vivaldi default is a known-but-unverified browser.
    expect(recommend({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }, COLLECTOR_BROWSERS))
      .toEqual({ recommended: "chrome", reason: "default-unverified" });
  });

  it("default-not-installed: the default row's executable was not found", () => {
    expect(recommend({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: MISSING } }))
      .toEqual({ recommended: "edge", reason: "default-not-installed" });
  });

  it("default-unknown: default could not be read", () => {
    expect(recommend({ defaultBrowser: "unknown", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: "edge", reason: "default-unknown" });
  });

  it("default-unknown: default row present but its detection failed while another browser is usable", () => {
    expect(recommend({ defaultBrowser: "chrome", detections: { edge: FOUND, chrome: UNKNOWN } }))
      .toEqual({ recommended: "edge", reason: "default-unknown" });
  });

  it("none-installed: nothing usable and detection worked", () => {
    expect(recommend({ defaultBrowser: "other", detections: { edge: MISSING, chrome: MISSING, vivaldi: MISSING } }))
      .toEqual({ recommended: null, reason: "none-installed" });
    expect(recommend({ defaultBrowser: "unknown", detections: { edge: MISSING, chrome: UNKNOWN, vivaldi: MISSING } }))
      .toEqual({ recommended: null, reason: "none-installed" });
  });

  it("detection-failed: every verified row is unknown (including missing entries)", () => {
    expect(recommend({ defaultBrowser: "other", detections: { edge: UNKNOWN, chrome: UNKNOWN, vivaldi: UNKNOWN } }))
      .toEqual({ recommended: null, reason: "detection-failed" });
    expect(recommend({ defaultBrowser: "unknown", detections: {} }))
      .toEqual({ recommended: null, reason: "detection-failed" });
  });

  it("a policy-blocked default is skipped, the next usable row is recommended", () => {
    expect(recommend({ defaultBrowser: "edge", detections: { edge: BLOCKED, chrome: FOUND } }))
      .toEqual({ recommended: "chrome", reason: "default-unsupported" });
    expect(recommend({ defaultBrowser: "other", detections: { edge: BLOCKED, chrome: BLOCKED } }))
      .toEqual({ recommended: null, reason: "none-installed" });
  });

  it("an unverified row is never recommended even when found and the default", () => {
    const real = recommend({ defaultBrowser: "vivaldi", detections: { vivaldi: FOUND, chrome: MISSING, edge: MISSING } }, COLLECTOR_BROWSERS);
    expect(real.recommended).toBeNull();
    expect(real.reason).toBe("none-installed");
    const onlyVivaldi = recommend({ defaultBrowser: "other", detections: { vivaldi: FOUND, chrome: MISSING, edge: MISSING } }, COLLECTOR_BROWSERS);
    expect(onlyVivaldi.recommended).toBeNull();
  });

  it("real table: Chrome is the only recommendable row today", () => {
    expect(recommend({ defaultBrowser: "other", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }, COLLECTOR_BROWSERS))
      .toEqual({ recommended: "chrome", reason: "default-unsupported" });
  });

  it("results are frozen", () => {
    expect(Object.isFrozen(recommend({ defaultBrowser: "other", detections: { edge: FOUND } }))).toBe(true);
  });
});

describe("effectiveRegistration", () => {
  const edgeOrder = row("edge").nativeMessaging.lookupOrder;

  it("Edge uses its own key when present", () => {
    expect(effectiveRegistration(edgeOrder, { edge: "ours", chromium: "absent", chrome: "ours" }))
      .toEqual({ target: "edge", ownership: "ours" });
    expect(effectiveRegistration(edgeOrder, { edge: "foreign", chrome: "ours" }))
      .toEqual({ target: "edge", ownership: "foreign" });
  });

  it("Edge falls back Edge -> Chromium -> Chrome", () => {
    expect(effectiveRegistration(edgeOrder, { edge: "absent", chromium: "foreign", chrome: "ours" }))
      .toEqual({ target: "chromium", ownership: "foreign" });
    expect(effectiveRegistration(edgeOrder, { edge: "absent", chromium: "absent", chrome: "ours" }))
      .toEqual({ target: "chrome", ownership: "ours" });
    expect(effectiveRegistration(edgeOrder, { edge: "absent", chromium: "absent", chrome: "foreign" }))
      .toEqual({ target: "chrome", ownership: "foreign" });
  });

  it("all absent is absent", () => {
    expect(effectiveRegistration(edgeOrder, { edge: "absent", chromium: "absent", chrome: "absent" }))
      .toEqual({ target: null, ownership: "absent" });
  });

  it("an unreadable target stops the walk instead of being skipped", () => {
    expect(effectiveRegistration(edgeOrder, { edge: "unknown", chrome: "ours" }))
      .toEqual({ target: null, ownership: "unknown" });
    expect(effectiveRegistration(edgeOrder, { edge: "absent", chromium: "unknown", chrome: "ours" }))
      .toEqual({ target: null, ownership: "unknown" });
    expect(effectiveRegistration(edgeOrder, { edge: "absent" }))
      .toEqual({ target: null, ownership: "unknown" });
  });

  it("targets after the first present one are not consulted", () => {
    expect(effectiveRegistration(edgeOrder, { edge: "ours", chromium: "unknown" }))
      .toEqual({ target: "edge", ownership: "ours" });
  });

  it("Chrome reads only the Chrome key", () => {
    expect(effectiveRegistration(row("chrome").nativeMessaging.lookupOrder, { edge: "ours", chrome: "absent" }))
      .toEqual({ target: null, ownership: "absent" });
    expect(effectiveRegistration(row("chrome").nativeMessaging.lookupOrder, { chrome: "ours" }))
      .toEqual({ target: "chrome", ownership: "ours" });
  });

  it("an empty lookup order (Vivaldi placeholder) is absent", () => {
    expect(effectiveRegistration([], { chrome: "ours" })).toEqual({ target: null, ownership: "absent" });
  });

  it("results are frozen", () => {
    expect(Object.isFrozen(effectiveRegistration(edgeOrder, { edge: "ours" }))).toBe(true);
  });
});

describe("collector-browser-table.ts source", () => {
  const source = readFileSync(path.join(__dirname, "collector-browser-table.ts"), "utf8");

  it("has no imports, requires or dynamic imports (pure data, safe from any process)", () => {
    expect(source).not.toMatch(/^\s*import\s/mu);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/\brequire\s*\(/u);
    expect(source).not.toMatch(/\bfrom\s+["']/u);
  });

  it("does not touch Node, Electron, process, registry or filesystem APIs", () => {
    expect(source).not.toMatch(/\bprocess\./u);
    expect(source).not.toMatch(/node:|electron|child_process|\bfs\b/iu);
    expect(source).not.toMatch(/\b(?:readFile|writeFile|spawn|exec)\w*\s*\(/u);
  });
});
