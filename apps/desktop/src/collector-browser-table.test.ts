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

/** Same rows with every row forced to "verified" (for logic tests; the evidence is not asserted here). */
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
  it("Vivaldi is verified (owner decision 2026-11-23, spike 2026-11-20): it reads Chromium then Chrome and registers nothing of its own", () => {
    const vivaldi = row("vivaldi");
    expect(vivaldi.verification).toBe("verified");
    expect(vivaldi.nativeMessaging.lookupOrder).toEqual(["chromium", "chrome"]);
    expect(vivaldi.nativeMessaging.ownTargets).toEqual([]);
    expect(vivaldi.nativeMessaging.registration).toBe("when-present");
    // No policy location was measured: the row is never blocked by policy.
    expect(vivaldi.policyRoot).toBeNull();
    expect(vivaldi.downloadUrl).toBeNull();
    expect(vivaldi.evidence.lookupOrder).toBe("measured");
    expect(vivaldi.evidence.ownTargets).toBe("measured");
    // Presentation evidence stays unmeasured: it is not claimed.
    expect(vivaldi.evidence.extensionsPage).toBe("unverified");
    expect(vivaldi.evidence.ui).toBe("unverified");
    expect(vivaldi.evidence.store).toBe("unverified");
    expect(vivaldi.evidence.downloadUrl).toBe("unverified");
  });

  it("no writable registry target is added for Vivaldi (the Vivaldi key is inert) and no row looks it up", () => {
    expect(COLLECTOR_REGISTRY_TARGETS.find((t) => t.id === "vivaldi")?.writable).toBe(false);
    for (const entry of COLLECTOR_BROWSERS) expect(entry.nativeMessaging.lookupOrder).not.toContain("vivaldi");
    // Chrome and Edge are the only rows that own a (writable) key.
    expect(COLLECTOR_BROWSERS.filter((entry) => entry.nativeMessaging.ownTargets.length > 0).map((entry) => entry.id).sort()).toEqual(["chrome", "edge"]);
  });

  it("Edge is verified: its stable ProgId MSEdgeHTM was measured on a real machine", () => {
    expect(row("edge").verification).toBe("verified");
    expect(row("edge").evidence.progIdPattern).toBe("measured");
    expect(row("edge").progIdPattern).toBe("^MSEdgeHTM$");
    // Presentation evidence is not yet complete; the S8/S10 gap gate still lists it.
    expect(row("edge").evidence.downloadUrl).toBe("measured");
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
    const vivaldiNoEvidence = {
      ...row("vivaldi"),
      evidence: { ...row("vivaldi").evidence, lookupOrder: "unverified", ownTargets: "unverified", registration: "unverified", policyRoot: "unverified" },
    } as unknown as CollectorBrowserSpec;
    const edgeNoProgId = { ...row("edge"), evidence: { ...row("edge").evidence, progIdPattern: "unverified" } } as unknown as CollectorBrowserSpec;
    expect(collectorBrowserReleaseGateViolations([vivaldiNoEvidence])).toEqual([
      "vivaldi.lookupOrder", "vivaldi.ownTargets", "vivaldi.registration", "vivaldi.policyRoot",
    ]);
    expect(collectorBrowserReleaseGateViolations([edgeNoProgId])).toEqual(["edge.progIdPattern"]);
    expect(collectorBrowserReleaseGateViolations([row("vivaldi"), row("edge")])).toEqual([]);
  });

  it("a verified row missing an evidence entry is a violation", () => {
    const broken = { ...row("chrome"), evidence: { ...row("chrome").evidence, lookupOrder: undefined } } as unknown as CollectorBrowserSpec;
    expect(collectorBrowserReleaseGateViolations([broken])).toEqual(["chrome.lookupOrder"]);
  });

  it("presentation evidence gaps are reported for the later (S8/S10) gate, not hidden", () => {
    // Edge is verified for the core fields but its presentation evidence (extensions page, UI, store, download URL) is still unmeasured.
    expect(collectorBrowserPresentationEvidenceGaps()).toEqual([
      "edge.extensionsPage", "edge.ui", "edge.store",
      "chrome.extensionsPage", "chrome.ui", "chrome.downloadUrl",
      "vivaldi.extensionsPage", "vivaldi.ui", "vivaldi.store", "vivaldi.downloadUrl",
    ]);
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
    ["IE.HTTP", "other"],
    ["AppXq0fevzme2pys62n3e0fbqa7peapykr8v", "other"],
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
    const vivaldiUnverified = { ...row("vivaldi"), verification: "unverified" } as CollectorBrowserSpec;
    expect(classifyDefaultBrowser("VivaldiHTM", [row("edge"), row("chrome"), vivaldiUnverified])).toBe("vivaldi");
    expect(classifyDefaultBrowser("VivaldiHTM")).toBe("vivaldi");
  });
});

describe("recommendCollectorBrowser (all rows verified for logic tests)", () => {
  it("default-supported: the default browser itself, and only the default browser", () => {
    expect(recommend({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }))
      .toEqual({ recommended: "vivaldi", reason: "default-supported" });
    expect(recommend({ defaultBrowser: "chrome", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: "chrome", reason: "default-supported" });
    expect(recommend({ defaultBrowser: "edge", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }))
      .toEqual({ recommended: "edge", reason: "default-supported" });
  });

  it("default-not-chromium: Firefox or similar recommends nothing, even when other browsers are usable", () => {
    expect(recommend({ defaultBrowser: "other", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: null, reason: "default-not-chromium" });
    expect(recommend({ defaultBrowser: "other", detections: { edge: MISSING, chrome: FOUND } }))
      .toEqual({ recommended: null, reason: "default-not-chromium" });
  });

  it("default-not-chromium: ProgIds of non-Chromium browsers classify as other and recommend nothing", () => {
    for (const progId of ["FirefoxURL-308046B0AF4A39CB", "IE.HTTP", "SafariHTML", "AppXq0fevzme2pys62n3e0fbqa7peapykr8v"]) {
      const kind = classifyDefaultBrowser(progId);
      expect(kind).toBe("other");
      expect(recommend({ defaultBrowser: kind, detections: { edge: FOUND, chrome: FOUND } }))
        .toEqual({ recommended: null, reason: "default-not-chromium" });
    }
  });

  it("default-unverified: another Chromium (Brave etc.) recommends nothing", () => {
    expect(recommend({ defaultBrowser: "other-chromium", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: null, reason: "default-unverified" });
  });

  it("default-unverified: a table row that is not verified is never recommended, even when found and the default", () => {
    const vivaldiUnverified = allVerifiedTable().map((entry) => (entry.id === "vivaldi" ? ({ ...entry, verification: "unverified" } as CollectorBrowserSpec) : entry));
    expect(recommend({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }, vivaldiUnverified))
      .toEqual({ recommended: null, reason: "default-unverified" });
    expect(recommend({ defaultBrowser: "vivaldi", detections: { edge: MISSING, chrome: MISSING, vivaldi: FOUND } }, vivaldiUnverified))
      .toEqual({ recommended: null, reason: "none-installed" });
  });

  it("default-not-installed: the default row's executable was not found; nothing else is recommended", () => {
    expect(recommend({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: MISSING } }))
      .toEqual({ recommended: null, reason: "default-not-installed" });
  });

  it("default-unknown: default could not be read; nothing is recommended", () => {
    expect(recommend({ defaultBrowser: "unknown", detections: { edge: FOUND, chrome: FOUND } }))
      .toEqual({ recommended: null, reason: "default-unknown" });
  });

  it("default-unknown: default row present but its detection failed while another browser is usable", () => {
    expect(recommend({ defaultBrowser: "chrome", detections: { edge: FOUND, chrome: UNKNOWN } }))
      .toEqual({ recommended: null, reason: "default-unknown" });
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

  it("a policy-blocked default is not recommended and nothing else is either (the reason stays default-unsupported)", () => {
    expect(recommend({ defaultBrowser: "edge", detections: { edge: BLOCKED, chrome: FOUND } }))
      .toEqual({ recommended: null, reason: "default-unsupported" });
    expect(recommend({ defaultBrowser: "other", detections: { edge: BLOCKED, chrome: BLOCKED } }))
      .toEqual({ recommended: null, reason: "none-installed" });
  });

  describe("real table (Edge, Chrome and Vivaldi are all verified): the recommendation for each default", () => {
    const real = (input: CollectorRecommendationInput) => recommend(input, COLLECTOR_BROWSERS);

    it("a Vivaldi default that is installed is recommended; table order plays no part", () => {
      expect(real({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }))
        .toEqual({ recommended: "vivaldi", reason: "default-supported" });
      expect(real({ defaultBrowser: "vivaldi", detections: { edge: MISSING, chrome: MISSING, vivaldi: FOUND } }))
        .toEqual({ recommended: "vivaldi", reason: "default-supported" });
    });

    it("a Vivaldi default that is not installed recommends nothing (default-not-installed)", () => {
      expect(real({ defaultBrowser: "vivaldi", detections: { edge: FOUND, chrome: FOUND, vivaldi: MISSING } }))
        .toEqual({ recommended: null, reason: "default-not-installed" });
    });

    it("a non-Chromium or unknown default recommends nothing, even with Edge, Chrome and Vivaldi installed", () => {
      expect(real({ defaultBrowser: "other", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }))
        .toEqual({ recommended: null, reason: "default-not-chromium" });
      expect(real({ defaultBrowser: "unknown", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }))
        .toEqual({ recommended: null, reason: "default-unknown" });
      expect(real({ defaultBrowser: "other-chromium", detections: { edge: FOUND, chrome: FOUND, vivaldi: FOUND } }))
        .toEqual({ recommended: null, reason: "default-unverified" });
    });

    it("Edge as the default browser, installed: recommended as default-supported", () => {
      expect(real({ defaultBrowser: "edge", detections: { edge: FOUND, chrome: FOUND } }))
        .toEqual({ recommended: "edge", reason: "default-supported" });
      expect(real({ defaultBrowser: "edge", detections: { edge: FOUND } }))
        .toEqual({ recommended: "edge", reason: "default-supported" });
    });

    it("Chrome as the default browser with Edge also installed: Chrome, default-supported (the default wins over table order)", () => {
      expect(real({ defaultBrowser: "chrome", detections: { edge: FOUND, chrome: FOUND } }))
        .toEqual({ recommended: "chrome", reason: "default-supported" });
    });

    it("Edge is the default but not installed, only Chrome is: nothing is recommended (default-not-installed)", () => {
      expect(real({ defaultBrowser: "edge", detections: { edge: MISSING, chrome: FOUND } }))
        .toEqual({ recommended: null, reason: "default-not-installed" });
    });

    it("Edge is the default but its detection failed, Chrome is installed: nothing is recommended (default-unknown)", () => {
      expect(real({ defaultBrowser: "edge", detections: { edge: UNKNOWN, chrome: FOUND } }))
        .toEqual({ recommended: null, reason: "default-unknown" });
    });

    it("Edge is the default but blocked by policy: nothing is recommended (default-unsupported)", () => {
      expect(real({ defaultBrowser: "edge", detections: { edge: BLOCKED, chrome: FOUND } }))
        .toEqual({ recommended: null, reason: "default-unsupported" });
    });

    it("only Chrome is installed and the default is unknown: nothing is recommended (default-unknown)", () => {
      expect(real({ defaultBrowser: "unknown", detections: { edge: MISSING, chrome: FOUND } }))
        .toEqual({ recommended: null, reason: "default-unknown" });
    });

    it("Edge is the default and neither Edge nor Chrome is installed: nothing is recommended", () => {
      expect(real({ defaultBrowser: "edge", detections: { edge: MISSING, chrome: MISSING } }))
        .toEqual({ recommended: null, reason: "none-installed" });
    });

    it("every verified row's detection failed: detection-failed (Edge and Vivaldi count as verified rows)", () => {
      expect(real({ defaultBrowser: "edge", detections: { edge: UNKNOWN, chrome: UNKNOWN, vivaldi: UNKNOWN } }))
        .toEqual({ recommended: null, reason: "detection-failed" });
      // A detection that worked for Edge (missing) while Chrome failed is not "every row unknown".
      expect(real({ defaultBrowser: "edge", detections: { edge: MISSING, chrome: UNKNOWN } }))
        .toEqual({ recommended: null, reason: "none-installed" });
    });

    it("a usable Vivaldi that is not the default keeps the reason of the default (not none-installed) and recommends nothing", () => {
      expect(real({ defaultBrowser: "other", detections: { edge: MISSING, chrome: MISSING, vivaldi: FOUND } }))
        .toEqual({ recommended: null, reason: "default-not-chromium" });
    });
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

  it("an empty lookup order is absent", () => {
    expect(effectiveRegistration([], { chrome: "ours" })).toEqual({ target: null, ownership: "absent" });
  });

  it("Vivaldi reads Chromium before Chrome (spike 2026-11-20: K1/K3/K6/K7) and never its own key", () => {
    const vivaldiOrder = row("vivaldi").nativeMessaging.lookupOrder;
    // Chrome key alone: ours (what the always-registered Chrome key gives Vivaldi).
    expect(effectiveRegistration(vivaldiOrder, { chromium: "absent", chrome: "ours" })).toEqual({ target: "chrome", ownership: "ours" });
    // K7: a Chromium key shadows the Chrome key, ours or not.
    expect(effectiveRegistration(vivaldiOrder, { chromium: "foreign", chrome: "ours" })).toEqual({ target: "chromium", ownership: "foreign" });
    // K6: a Vivaldi key is ignored.
    expect(effectiveRegistration(vivaldiOrder, { vivaldi: "foreign", chromium: "absent", chrome: "ours" })).toEqual({ target: "chrome", ownership: "ours" });
    expect(effectiveRegistration(vivaldiOrder, { chromium: "absent", chrome: "absent" })).toEqual({ target: null, ownership: "absent" });
    expect(effectiveRegistration(vivaldiOrder, { chromium: "unknown", chrome: "ours" })).toEqual({ target: null, ownership: "unknown" });
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
