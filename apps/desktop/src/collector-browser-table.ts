/**
 * Collector browser table (multi-browser design S1, docs/collector-multi-browser-design.md 1-3).
 *
 * Pure data and pure functions only: no imports, no host, registry or filesystem access.
 * The writable registry keys are owned by the native addon's compile-time table (design 3.2);
 * the registry strings below are read/match-side copies and cannot redirect any write.
 *
 * A row whose `verification` is not "verified" is detected and classified but is never
 * recommended and never registered (design 1.1).
 */

// ----- Registry targets (design 1.3) ----------------------------------------------------------

export const COLLECTOR_REGISTRY_TARGET_IDS = ["chrome", "edge", "vivaldi", "chromium"] as const;
export type CollectorRegistryTargetId = (typeof COLLECTOR_REGISTRY_TARGET_IDS)[number];

export interface CollectorRegistryTargetSpec {
  readonly id: CollectorRegistryTargetId;
  /** Always HKCU (64-bit view; HKCU is not redirected). */
  readonly subkey: string;
  /** true: the addon may register/unregister it. false: inspected only, never written. */
  readonly writable: boolean;
}

const HOST_NAME = "org.maginalia.collector";

export const COLLECTOR_REGISTRY_TARGETS: readonly CollectorRegistryTargetSpec[] = deepFreeze([
  { id: "chrome", subkey: `Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, writable: true },
  { id: "edge", subkey: `Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`, writable: true },
  // Read-only: Edge's second lookup location (documented). Lets us tell whether a third-party
  // Chromium registration shadows Edge's fallback to the Chrome key.
  { id: "chromium", subkey: `Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`, writable: false },
  // Unverified: whether Vivaldi reads this key is decided by the spike (design 3.4). Never writable here.
  { id: "vivaldi", subkey: `Software\\Vivaldi\\NativeMessagingHosts\\${HOST_NAME}`, writable: false },
]);

// ----- Browser rows (design 1.2, 1.4) ---------------------------------------------------------

/** Order = fallback recommendation order (design 2.2). */
export const COLLECTOR_BROWSER_IDS = ["edge", "chrome", "vivaldi"] as const;
export type CollectorBrowserId = (typeof COLLECTOR_BROWSER_IDS)[number];

export type CollectorEvidenceKind = "measured" | "vendor-doc" | "code" | "unverified";

/**
 * Fields whose value decides what is detected, recommended or registered. A "verified" row must
 * carry no "unverified" evidence here (release gate, design 1.2).
 */
export const COLLECTOR_CORE_EVIDENCE_FIELDS = [
  "progIdPattern",
  "executable",
  "knownFolders",
  "lookupOrder",
  "ownTargets",
  "registration",
  "policyRoot",
] as const;
export type CollectorCoreEvidenceField = (typeof COLLECTOR_CORE_EVIDENCE_FIELDS)[number];

/**
 * Wizard-presentation fields (extensions page launch, UI labels, store, download URL). They are
 * checked by the separate S8/S10 gate (`collectorBrowserPresentationEvidenceGaps`), not by the
 * verified-row gate: the design itself leaves them for spike screenshots (design 1.4, 9 S10).
 */
export const COLLECTOR_PRESENTATION_EVIDENCE_FIELDS = ["extensionsPage", "ui", "store", "downloadUrl"] as const;
export type CollectorPresentationEvidenceField = (typeof COLLECTOR_PRESENTATION_EVIDENCE_FIELDS)[number];

export type CollectorKnownFolder = "LocalAppData" | "ProgramFiles" | "ProgramFilesX86";

export interface CollectorBrowserSpecBase {
  readonly id: CollectorBrowserId;
  readonly displayName: string;
  /** Default-browser match on the https handler ProgId (anchored, case-insensitive). RegExp source. */
  readonly progIdPattern: string;
  readonly executable: {
    readonly fileName: string;
    readonly appPathsName: string;
    /** `relative` is the folder below the known folder; the exe is `fileName` inside it. */
    readonly knownFolderCandidates: readonly { readonly folder: CollectorKnownFolder; readonly relative: readonly string[] }[];
  };
  readonly nativeMessaging: {
    /** HKCU targets in the order this browser searches them; the first present one wins. */
    readonly lookupOrder: readonly CollectorRegistryTargetId[];
    /** Writable targets MAGINALIA owns for this browser (subset of lookupOrder). */
    readonly ownTargets: readonly CollectorRegistryTargetId[];
    readonly registration: "always" | "when-present";
  };
  /** Policy root under `SOFTWARE\Policies\`, or null when unknown (never blocks). */
  readonly policyRoot: "Google\\Chrome" | "Microsoft\\Edge" | null;
  readonly extensionsPage: {
    readonly displayUrl: string;
    /** Fixed argv for the validated executable. */
    readonly launchArguments: readonly string[];
  };
  readonly ui: {
    readonly developerModeLabel: string;
    readonly developerModeLocation: string;
    readonly loadUnpackedLabel: string;
    readonly reloadLabel: string;
  };
  readonly store: "chrome-web-store" | "edge-add-ons";
  /** https only; a main-process constant. null: no download button. */
  readonly downloadUrl: string | null;
}

type EvidenceRecord<Field extends string, Kind extends CollectorEvidenceKind> = { readonly [F in Field]: Kind };

/** A verified row cannot be written with unverified core evidence: the type rejects it. */
export interface CollectorVerifiedBrowserSpec extends CollectorBrowserSpecBase {
  readonly verification: "verified";
  readonly evidence: EvidenceRecord<CollectorCoreEvidenceField, Exclude<CollectorEvidenceKind, "unverified">> &
    EvidenceRecord<CollectorPresentationEvidenceField, CollectorEvidenceKind>;
}

export interface CollectorUnverifiedBrowserSpec extends CollectorBrowserSpecBase {
  readonly verification: "unverified";
  readonly evidence: EvidenceRecord<CollectorCoreEvidenceField | CollectorPresentationEvidenceField, CollectorEvidenceKind>;
}

export type CollectorBrowserSpec = CollectorVerifiedBrowserSpec | CollectorUnverifiedBrowserSpec;

export function isCollectorBrowserVerified(spec: CollectorBrowserSpec): spec is CollectorVerifiedBrowserSpec {
  return spec.verification === "verified";
}

const CHROME_ROW: CollectorVerifiedBrowserSpec = {
  id: "chrome",
  displayName: "Google Chrome",
  verification: "verified",
  // Design 1.4: suffixed ProgIds only (ChromeHTML.<alnum>); Beta/Dev/Canary never match.
  progIdPattern: "^ChromeHTML(\\.[A-Za-z0-9]+)?$",
  executable: {
    fileName: "chrome.exe",
    appPathsName: "chrome.exe",
    knownFolderCandidates: [
      { folder: "LocalAppData", relative: ["Google", "Chrome", "Application"] },
      { folder: "ProgramFiles", relative: ["Google", "Chrome", "Application"] },
      { folder: "ProgramFilesX86", relative: ["Google", "Chrome", "Application"] },
    ],
  },
  nativeMessaging: { lookupOrder: ["chrome"], ownTargets: ["chrome"], registration: "always" },
  policyRoot: "Google\\Chrome",
  extensionsPage: { displayUrl: "chrome://extensions", launchArguments: ["chrome://extensions/"] },
  ui: {
    developerModeLabel: "デベロッパー モード",
    developerModeLocation: "画面の右上",
    loadUnpackedLabel: "パッケージ化されていない拡張機能を読み込む",
    reloadLabel: "更新",
  },
  store: "chrome-web-store",
  downloadUrl: "https://www.google.com/chrome/",
  evidence: {
    progIdPattern: "code",
    executable: "measured",
    knownFolders: "code",
    lookupOrder: "vendor-doc",
    ownTargets: "code",
    registration: "vendor-doc",
    policyRoot: "code",
    extensionsPage: "unverified",
    ui: "unverified",
    store: "code",
    downloadUrl: "unverified",
  },
};

// Edge stays "unverified" until spike Phase 1 confirms its stable ProgId (design 1.4: "verified 予定").
// Flipping it to "verified" is a one-line change plus `progIdPattern: "measured"`; the gate enforces that.
const EDGE_ROW: CollectorUnverifiedBrowserSpec = {
  id: "edge",
  displayName: "Microsoft Edge",
  verification: "unverified",
  progIdPattern: "^MSEdgeHTM$",
  executable: {
    fileName: "msedge.exe",
    appPathsName: "msedge.exe",
    knownFolderCandidates: [
      { folder: "ProgramFilesX86", relative: ["Microsoft", "Edge", "Application"] },
      { folder: "ProgramFiles", relative: ["Microsoft", "Edge", "Application"] },
    ],
  },
  nativeMessaging: { lookupOrder: ["edge", "chromium", "chrome"], ownTargets: ["edge"], registration: "always" },
  policyRoot: "Microsoft\\Edge",
  extensionsPage: { displayUrl: "edge://extensions", launchArguments: ["edge://extensions/"] },
  ui: {
    developerModeLabel: "開発者モード",
    developerModeLocation: "画面左のメニューの下部",
    loadUnpackedLabel: "展開して読み込み",
    reloadLabel: "再読み込み",
  },
  store: "edge-add-ons",
  downloadUrl: "https://www.microsoft.com/edge/download",
  evidence: {
    progIdPattern: "unverified",
    executable: "measured",
    knownFolders: "measured",
    lookupOrder: "vendor-doc",
    ownTargets: "vendor-doc",
    registration: "vendor-doc",
    policyRoot: "vendor-doc",
    extensionsPage: "unverified",
    ui: "unverified",
    store: "unverified",
    downloadUrl: "unverified",
  },
};

// Vivaldi: where (and whether) it looks up Native Messaging hosts is unverified (spike). Empty
// lookupOrder/ownTargets are placeholders; nothing is registered or recommended for this row.
const VIVALDI_ROW: CollectorUnverifiedBrowserSpec = {
  id: "vivaldi",
  displayName: "Vivaldi",
  verification: "unverified",
  progIdPattern: "^VivaldiHTM(\\.[A-Za-z0-9]+)?$",
  executable: {
    fileName: "vivaldi.exe",
    appPathsName: "vivaldi.exe",
    knownFolderCandidates: [
      { folder: "LocalAppData", relative: ["Vivaldi", "Application"] },
      { folder: "ProgramFiles", relative: ["Vivaldi", "Application"] },
    ],
  },
  nativeMessaging: { lookupOrder: [], ownTargets: [], registration: "when-present" },
  policyRoot: null,
  extensionsPage: { displayUrl: "vivaldi://extensions", launchArguments: ["vivaldi://extensions/"] },
  ui: {
    developerModeLabel: "デベロッパー モード",
    developerModeLocation: "画面の右上",
    loadUnpackedLabel: "パッケージ化されていない拡張機能を読み込む",
    reloadLabel: "更新",
  },
  store: "chrome-web-store",
  downloadUrl: null,
  evidence: {
    progIdPattern: "measured",
    executable: "measured",
    knownFolders: "measured",
    lookupOrder: "unverified",
    ownTargets: "unverified",
    registration: "unverified",
    policyRoot: "unverified",
    extensionsPage: "unverified",
    ui: "unverified",
    store: "unverified",
    downloadUrl: "unverified",
  },
};

/** Table order follows `COLLECTOR_BROWSER_IDS`. */
export const COLLECTOR_BROWSERS: readonly CollectorBrowserSpec[] = deepFreeze([EDGE_ROW, CHROME_ROW, VIVALDI_ROW]);

// ----- Release gates (pure; tests and later slices call them) -----------------------------------

/**
 * Verified rows must carry no "unverified" evidence on a core field. Returns one string per
 * violation (`<browser>.<field>`). Types already forbid it at compile time; this guards casts and
 * future edits.
 */
export function collectorBrowserReleaseGateViolations(table: readonly CollectorBrowserSpec[] = COLLECTOR_BROWSERS): readonly string[] {
  const violations: string[] = [];
  for (const row of table) {
    if (row.verification !== "verified") continue;
    const evidence: Readonly<Record<string, CollectorEvidenceKind | undefined>> = row.evidence;
    for (const field of COLLECTOR_CORE_EVIDENCE_FIELDS) {
      const kind = evidence[field];
      if (kind === undefined || kind === "unverified") violations.push(`${row.id}.${field}`);
    }
  }
  return Object.freeze(violations);
}

/**
 * S8/S10 gate: presentation fields of verified rows that are not yet "measured"/documented.
 * Not enforced as failing in S1; the S10 slice must drive this to empty before release.
 */
export function collectorBrowserPresentationEvidenceGaps(table: readonly CollectorBrowserSpec[] = COLLECTOR_BROWSERS): readonly string[] {
  const gaps: string[] = [];
  for (const row of table) {
    if (row.verification !== "verified") continue;
    const evidence: Readonly<Record<string, CollectorEvidenceKind | undefined>> = row.evidence;
    for (const field of COLLECTOR_PRESENTATION_EVIDENCE_FIELDS) {
      const kind = evidence[field];
      if (kind === undefined || kind === "unverified") gaps.push(`${row.id}.${field}`);
    }
  }
  return Object.freeze(gaps);
}

// ----- Default browser classification (design 2.1) ----------------------------------------------

/** Table rows, plus "other-chromium" (known but unverified Chromium), "other", "unknown". */
export type CollectorDefaultBrowserKind = CollectorBrowserId | "other-chromium" | "other" | "unknown";

// Known Chromium-family ProgIds that are not table rows (Brave, Opera, Arc, Yandex, Chromium,
// Chrome Beta/Dev/Canary, Edge Beta/Dev/Canary). Anchored prefixes; a table row is tested first.
const OTHER_CHROMIUM_PROGID =
  /^(?:BraveHTML|BraveFile|OperaStable|Opera|ChromiumHTM|ArcHTML|ChromeBHTML|ChromeDHTML|ChromeSSHTM|YandexHTML|CocCocHTML|MSEdge[A-Z]HTML?|MSEdgeHTML)(?:\.[A-Za-z0-9]+)?$/iu;

/** Classifies the https handler ProgId against the table. Never throws. */
export function classifyDefaultBrowser(
  progId: string | null | undefined,
  table: readonly CollectorBrowserSpec[] = COLLECTOR_BROWSERS,
): CollectorDefaultBrowserKind {
  if (typeof progId !== "string" || progId.trim() === "") return "unknown";
  for (const row of table) {
    if (new RegExp(row.progIdPattern, "iu").test(progId)) return row.id;
  }
  if (OTHER_CHROMIUM_PROGID.test(progId)) return "other-chromium";
  return "other";
}

// ----- Recommendation (design 2.2, 2.3) ---------------------------------------------------------

export type CollectorBrowserInstalled = "found" | "not-found" | "unknown";

export interface CollectorBrowserDetection {
  readonly installed: CollectorBrowserInstalled;
  /** true: an organization policy blocks this browser's per-user hosts (design 4.4). */
  readonly policyBlocked: boolean;
}

export type CollectorRecommendationReason =
  | "default-supported"
  | "default-unsupported"
  | "default-unverified"
  | "default-not-installed"
  | "default-unknown"
  | "none-installed"
  | "detection-failed";

export interface CollectorBrowserRecommendation {
  readonly recommended: CollectorBrowserId | null;
  readonly reason: CollectorRecommendationReason;
}

export interface CollectorRecommendationInput {
  readonly defaultBrowser: CollectorDefaultBrowserKind;
  /** A missing entry is treated as `unknown` and not blocked. */
  readonly detections: Readonly<Partial<Record<CollectorBrowserId, CollectorBrowserDetection>>>;
}

/**
 * Chooses the recommended browser and the reason that selects the wizard copy.
 * Only verified, found, non-blocked rows can be recommended. Pure and total.
 */
export function recommendCollectorBrowser(
  input: CollectorRecommendationInput,
  table: readonly CollectorBrowserSpec[] = COLLECTOR_BROWSERS,
): CollectorBrowserRecommendation {
  const detectionOf = (id: CollectorBrowserId): CollectorBrowserDetection =>
    input.detections[id] ?? { installed: "unknown", policyBlocked: false };
  const usable = (row: CollectorBrowserSpec): boolean => {
    const detection = detectionOf(row.id);
    return row.verification === "verified" && detection.installed === "found" && !detection.policyBlocked;
  };
  const rowFor = (id: CollectorDefaultBrowserKind): CollectorBrowserSpec | undefined => table.find((row) => row.id === id);

  const defaultRow = rowFor(input.defaultBrowser);
  if (defaultRow !== undefined && usable(defaultRow)) {
    return Object.freeze({ recommended: defaultRow.id, reason: "default-supported" as const });
  }

  // Fallback: first usable row in table order (Edge -> Chrome -> Vivaldi, owner decision 2).
  const fallback = table.find(usable);
  if (fallback === undefined) {
    const verifiedRows = table.filter((row) => row.verification === "verified");
    const allUnknown = verifiedRows.length > 0 && verifiedRows.every((row) => detectionOf(row.id).installed === "unknown");
    return Object.freeze({ recommended: null, reason: allUnknown ? ("detection-failed" as const) : ("none-installed" as const) });
  }

  return Object.freeze({ recommended: fallback.id, reason: defaultReason(input.defaultBrowser, defaultRow, detectionOf) });
}

function defaultReason(
  defaultBrowser: CollectorDefaultBrowserKind,
  defaultRow: CollectorBrowserSpec | undefined,
  detectionOf: (id: CollectorBrowserId) => CollectorBrowserDetection,
): CollectorRecommendationReason {
  if (defaultBrowser === "unknown") return "default-unknown";
  if (defaultBrowser === "other") return "default-unsupported";
  if (defaultBrowser === "other-chromium") return "default-unverified";
  if (defaultRow === undefined) return "default-unsupported";
  if (defaultRow.verification !== "verified") return "default-unverified";
  const detection = detectionOf(defaultRow.id);
  if (detection.installed === "not-found") return "default-not-installed";
  if (detection.installed === "unknown") return "default-unknown"; // present as the default but not confirmed
  return "default-unsupported"; // supported and installed, but blocked by organization policy
}

// ----- Effective registration (design 3.1-3.3, 4.2) ---------------------------------------------

export type CollectorTargetOwnership = "absent" | "ours" | "foreign" | "unknown";

export type CollectorEffectiveRegistration =
  | { readonly target: CollectorRegistryTargetId; readonly ownership: "ours" | "foreign" }
  | { readonly target: null; readonly ownership: "absent" | "unknown" };

/**
 * What a browser will actually use: the first target of `lookupOrder` that is present.
 * `absent` targets are skipped (Edge falls back Edge -> Chromium -> Chrome). An `unknown` target
 * (unreadable) stops the walk with `unknown`: skipping it could name the wrong registration.
 * A target missing from `ownerships` is `unknown`. An empty order yields `absent`.
 */
export function effectiveRegistration(
  lookupOrder: readonly CollectorRegistryTargetId[],
  ownerships: Readonly<Partial<Record<CollectorRegistryTargetId, CollectorTargetOwnership>>>,
): CollectorEffectiveRegistration {
  for (const target of lookupOrder) {
    const ownership = ownerships[target] ?? "unknown";
    if (ownership === "absent") continue;
    if (ownership === "unknown") return Object.freeze({ target: null, ownership: "unknown" as const });
    return Object.freeze({ target, ownership });
  }
  return Object.freeze({ target: null, ownership: "absent" as const });
}

// ----- helpers ----------------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
