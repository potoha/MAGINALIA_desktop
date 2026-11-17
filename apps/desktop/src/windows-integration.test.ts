/**
 * Evidence for the Windows integration addon wrapper, the `CollectorRegistryAdapter`
 * seam and the addon's staging checks (Collector wizard design, WP-3).
 *
 * Safety rules for this file:
 *
 * - The PRODUCT addon is only ever called through its read-only functions here.
 *   `registerCollectorHost` / `unregisterCollectorHost` /
 *   `replaceForeignCollectorHostRegistration` of the product binary are called ONLY with
 *   arguments the addon must reject before it touches the registry (unknown, read-only or
 *   malformed target ids, wrong argument counts); never with `chrome` or `edge`.
 * - Register/unregister are exercised natively only through the separate test-seam
 *   build (`windows_integration_test.node`), which targets private temp subkeys under
 *   `HKCU\Software\MAGINALIA-Tests\<random>\<target>` that are removed afterwards. That suite WRITES
 *   to the real HKCU (private subkey only), so it is OPT-IN: it runs only when
 *   `MAGINALIA_RUN_REGISTRY_SEAM_TESTS=1` (see `npm run test:windows-integration-registry`).
 *   A normal `npm test` and CI never write the registry. The seam is proven absent from the
 *   product binary by default-on, read-only tests below.
 * - When the addon binaries are absent (no C++ toolchain) or the host is not Windows, the
 *   native suites are skipped; `npm run build:native` is the evidence path.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCollectorRegistryAdapterOver,
  type CollectorRegistryAdapter,
} from "./collector-registry-adapter.js";
import {
  EMPTY_CHROME_POLICIES_FOR_HIVE,
  FakeCollectorRegistryAdapter,
} from "./collector-registry-adapter.test-helper.js";
import { COLLECTOR_REGISTRY_TARGETS, type CollectorRegistryTargetId } from "./collector-browser-table.js";
import {
  COLLECTOR_HOST_REGISTRY_SUBKEY,
  WINDOWS_INTEGRATION_API_VERSION,
  WINDOWS_INTEGRATION_NATIVE_EXPORTS,
  WindowsIntegrationError,
  collectorManifestPathFor,
  createWindowsIntegration,
  loadWindowsIntegrationFrom,
  resolveWindowsIntegrationAddonCandidates,
  type WindowsIntegration,
  type WindowsIntegrationNative,
} from "./windows-integration.js";

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const buildDirectory = path.join(desktopRoot, "native", "windows-integration", "build", "Release");
const productAddonPath = path.join(buildDirectory, "windows_integration.node");
const testAddonPath = path.join(buildDirectory, "windows_integration_test.node");
const nativeAvailable = process.platform === "win32" && existsSync(productAddonPath) && existsSync(testAddonPath);
const nativeDescribe = nativeAvailable ? describe : describe.skip;
const registrySeamEnabled = nativeAvailable && process.env["MAGINALIA_RUN_REGISTRY_SEAM_TESTS"] === "1";
const registrySeamDescribe = registrySeamEnabled ? describe : describe.skip;

interface AddonScript {
  readonly PRODUCT_JS_EXPORTS: readonly string[];
  readonly PRODUCT_NATIVE_EXPORTS: readonly string[];
  listNativeExports(bytes: Buffer): string[];
  findTestSeamMarkers(bytes: Buffer): string[];
  assertProductBinary(bytes: Buffer): void;
  stageWindowsIntegrationAddon(options: { desktopRoot: string; repositoryRoot: string; runtimeRoot: string }): Promise<{
    napiVersion: number; crt: string; sha256: string; bytes: number; addonApiVersion: number | null;
  }>;
}

async function loadAddonScript(): Promise<AddonScript> {
  const url = pathToFileURL(path.join(desktopRoot, "scripts", "windows-integration-addon.mjs")).href;
  return (await import(/* @vite-ignore */ url)) as AddonScript;
}

// ----- Fake native module (records every call) ---------------------------------------------

interface FakeNativeOptions {
  readonly values?: Record<string, unknown>;
  readonly names?: Record<string, string[] | null>;
  readonly folders?: Record<string, unknown>;
  readonly registerResult?: unknown;
  readonly inspectResult?: unknown;
  readonly apiVersion?: number;
  /** What `listCollectorHostTargets` returns. Default: the addon's table (chrome, edge writable; chromium read-only). */
  readonly targets?: unknown;
  readonly throwWith?: { readonly code?: string; readonly message: string };
}

const ADDON_TABLE = [
  { id: "chrome", subkey: "Software\\Google\\Chrome\\NativeMessagingHosts\\org.maginalia.collector", writable: true },
  { id: "edge", subkey: "Software\\Microsoft\\Edge\\NativeMessagingHosts\\org.maginalia.collector", writable: true },
  { id: "chromium", subkey: "Software\\Chromium\\NativeMessagingHosts\\org.maginalia.collector", writable: false },
];

function fakeNative(options: FakeNativeOptions = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const maybeThrow = () => {
    if (options.throwWith !== undefined) {
      throw Object.assign(new Error(options.throwWith.message), options.throwWith.code === undefined ? {} : { code: options.throwWith.code });
    }
  };
  const native: WindowsIntegrationNative = {
    apiVersion: options.apiVersion ?? 2,
    // Read at construction by the wrapper; deliberately not recorded in `calls` and never throws.
    listCollectorHostTargets: () => options.targets ?? ADDON_TABLE,
    getKnownFolderPath: (...args: unknown[]) => {
      calls.push({ name: "getKnownFolderPath", args });
      maybeThrow();
      return (options.folders ?? { UserProgramFiles: "C:\\Users\\tester\\AppData\\Local\\Programs" })[String(args[0])];
    },
    readRegistryValue: (...args: unknown[]) => {
      calls.push({ name: "readRegistryValue", args });
      maybeThrow();
      const found = (options.values ?? {})[`${String(args[0])}|${String(args[3])}|${String(args[1])}|${String(args[2])}`];
      return found === undefined ? null : found;
    },
    readRegistryValueNames: (...args: unknown[]) => {
      calls.push({ name: "readRegistryValueNames", args });
      maybeThrow();
      const found = (options.names ?? {})[`${String(args[0])}|${String(args[2])}|${String(args[1])}`];
      return found === undefined ? null : found;
    },
    inspectCollectorHostRegistration: (...args: unknown[]) => {
      calls.push({ name: "inspectCollectorHostRegistration", args });
      maybeThrow();
      return options.inspectResult ?? { status: "absent", errorCode: 0 };
    },
    registerCollectorHost: (...args: unknown[]) => {
      calls.push({ name: "registerCollectorHost", args });
      maybeThrow();
      return options.registerResult ?? { status: "ok", errorCode: 0 };
    },
    unregisterCollectorHost: (...args: unknown[]) => {
      calls.push({ name: "unregisterCollectorHost", args });
      maybeThrow();
      return options.registerResult ?? { status: "ok", errorCode: 0 };
    },
    replaceForeignCollectorHostRegistration: (...args: unknown[]) => {
      calls.push({ name: "replaceForeignCollectorHostRegistration", args });
      maybeThrow();
      return options.registerResult ?? { status: "ok", errorCode: 0 };
    },
  };
  return { native, calls };
}

describe("wrapper: surface and argument validation", () => {
  it("exposes only the documented functions and no generic registry write or delete", () => {
    const wrapper = createWindowsIntegration(fakeNative().native);
    expect(Object.keys(wrapper).sort()).toEqual([
      "getKnownFolderPath",
      "inspectCollectorHostRegistration",
      "listCollectorHostTargets",
      "readRegistryValue",
      "readRegistryValueNames",
      "registerCollectorHost",
      "replaceForeignCollectorHostRegistration",
      "unregisterCollectorHost",
    ]);
    expect(Object.isFrozen(wrapper)).toBe(true);
    // Source-level guard: the module's own exported names contain no generic mutator.
    const source = readFileSync(path.join(__dirname, "windows-integration.ts"), "utf8");
    const exported = [...source.matchAll(/^export (?:async )?(?:function|const|class|interface|type) (\w+)/gmu)].map((match) => match[1] ?? "");
    expect(exported.filter((name) => /^(write|set|delete|remove)/iu.test(name))).toEqual([]);
  });

  it("register, unregister and replace take exactly one writable target id and pass only that id to the addon", () => {
    const { native, calls } = fakeNative();
    const wrapper = createWindowsIntegration(native);
    for (const target of ["chrome", "edge"] as const) {
      expect(wrapper.registerCollectorHost(target)).toBe("ok");
      expect(wrapper.unregisterCollectorHost(target)).toBe("ok");
      expect(wrapper.replaceForeignCollectorHostRegistration(target)).toBe("ok");
    }
    expect(calls.map((call) => call.name)).toEqual([
      "registerCollectorHost", "unregisterCollectorHost", "replaceForeignCollectorHostRegistration",
      "registerCollectorHost", "unregisterCollectorHost", "replaceForeignCollectorHostRegistration",
    ]);
    expect(calls.map((call) => call.args)).toEqual([["chrome"], ["chrome"], ["chrome"], ["edge"], ["edge"], ["edge"]]);

    // A caller that bypasses the type system still cannot hand anything but a writable id to the writer.
    const loose = wrapper as unknown as Record<string, (...args: unknown[]) => unknown>;
    const bad: unknown[][] = [
      [], ["chromium"], ["vivaldi"], ["Chrome"], ["chrome "], ["chrome\0"], [""], ["C:\\evil\\manifest.json"],
      ["Software\\Google\\Chrome"], [{ path: "x" }], [null], [undefined], [1], ["chrome", "edge"], ["chrome", "x"],
      [["chrome"]], [new String("chrome")],
    ];
    for (const name of ["registerCollectorHost", "unregisterCollectorHost", "replaceForeignCollectorHostRegistration"]) {
      for (const args of bad) {
        expect(() => loose[name]?.(...args), `${name}(${JSON.stringify(args)})`).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
      }
    }
    expect(calls).toHaveLength(6);   // nothing above reached the addon
  });

  it("a target the addon reports read-only or absent is refused by the wrapper even if the TS enumeration knows it", () => {
    // Addon table without edge; chromium read-only: writers only accept chrome.
    const narrow = [ADDON_TABLE[0], ADDON_TABLE[2]];
    const { native, calls } = fakeNative({ targets: narrow });
    const wrapper = createWindowsIntegration(native);
    expect(wrapper.registerCollectorHost("chrome")).toBe("ok");
    expect(() => wrapper.registerCollectorHost("edge")).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    expect(() => wrapper.inspectCollectorHostRegistration("edge")).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    expect(wrapper.inspectCollectorHostRegistration("chromium")).toBe("absent");
    expect(() => wrapper.unregisterCollectorHost("chromium")).toThrow(WindowsIntegrationError);
    // Vivaldi is in the TS enumeration but not in the addon table (design 3.4): inspect is refused too.
    expect(() => wrapper.inspectCollectorHostRegistration("vivaldi")).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    expect(calls.map((call) => call.args)).toEqual([["chrome"], ["chromium"]]);
  });

  it("inspect takes exactly one table target id", () => {
    const { native, calls } = fakeNative();
    const wrapper = createWindowsIntegration(native);
    const loose = wrapper as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const args of [[], ["Edge"], ["chrome", "edge"], [""], [5], [{}]] as unknown[][]) {
      expect(() => loose["inspectCollectorHostRegistration"]?.(...args)).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    }
    expect(calls).toEqual([]);
    for (const target of ["chrome", "edge", "chromium"] as const) wrapper.inspectCollectorHostRegistration(target);
    expect(calls.map((call) => call.args)).toEqual([["chrome"], ["edge"], ["chromium"]]);
  });

  it("refuses an addon with another apiVersion or a table that disagrees with the TS table", () => {
    const unavailable = (options: FakeNativeOptions) => {
      try {
        createWindowsIntegration(fakeNative(options).native);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WindowsIntegrationError);
        return (error as WindowsIntegrationError).code;
      }
      return "no error";
    };
    expect(unavailable({ apiVersion: 1 })).toBe("windows-integration-unavailable");
    expect(unavailable({ apiVersion: 3 })).toBe("windows-integration-unavailable");
    expect(unavailable({})).toBe("no error");
    expect(unavailable({ targets: "not-a-list" })).toBe("windows-integration-unavailable");
    expect(unavailable({ targets: [{ id: "brave", subkey: "x", writable: true }] })).toBe("windows-integration-unavailable");
    expect(unavailable({ targets: [ADDON_TABLE[0], ADDON_TABLE[0]] })).toBe("windows-integration-unavailable");
    expect(unavailable({ targets: [{ ...ADDON_TABLE[0], writable: "yes" }] })).toBe("windows-integration-unavailable");
    // The TS table says chromium is read-only; an addon that makes it writable is not trusted.
    expect(unavailable({ targets: [{ ...ADDON_TABLE[2], writable: true }] })).toBe("windows-integration-unavailable");
    expect(unavailable({ targets: [] })).toBe("no error");
  });

  it("validates known folder ids and requires a local absolute path back", () => {
    const wrapper = createWindowsIntegration(fakeNative({ folders: { LocalAppData: "C:\\Users\\t\\AppData\\Local", ProgramFiles: "\\\\server\\share" } }).native);
    expect(wrapper.getKnownFolderPath("LocalAppData")).toBe("C:\\Users\\t\\AppData\\Local");
    expect(() => wrapper.getKnownFolderPath("Desktop" as never)).toThrow(/known folder id/u);
    expect(() => wrapper.getKnownFolderPath("../x" as never)).toThrow(WindowsIntegrationError);
    expect(() => wrapper.getKnownFolderPath("ProgramFiles")).toThrow(expect.objectContaining({ code: "windows-integration-known-folder-unavailable" }));
    expect(() => wrapper.getKnownFolderPath("ProgramFilesX86")).toThrow(WindowsIntegrationError);
  });

  it("validates registry read arguments before the addon sees them", () => {
    const { native, calls } = fakeNative();
    const wrapper = createWindowsIntegration(native);
    expect(() => wrapper.readRegistryValue("HKCR" as never, "Software", "", "64")).toThrow(/hive/u);
    expect(() => wrapper.readRegistryValue("HKCU", "", "", "64")).toThrow(/subkey/u);
    expect(() => wrapper.readRegistryValue("HKCU", "a\0b", "", "64")).toThrow(/subkey/u);
    expect(() => wrapper.readRegistryValue("HKCU", "x".repeat(1025), "", "64")).toThrow(/subkey/u);
    expect(() => wrapper.readRegistryValue("HKCU", "Software", "n\0", "64")).toThrow(/value name/u);
    expect(() => wrapper.readRegistryValue("HKCU", "Software", "", "128" as never)).toThrow(/view/u);
    expect(() => wrapper.readRegistryValue("HKCU", 5 as never, "", "64")).toThrow(WindowsIntegrationError);
    expect(() => wrapper.readRegistryValueNames("HKLM", "", "64")).toThrow(WindowsIntegrationError);
    expect(calls).toEqual([]);
  });

  it("returns typed values and rejects malformed addon results", () => {
    const key = (hive: string, view: string, subkey: string, name: string) => `${hive}|${view}|${subkey}|${name}`;
    const wrapper = createWindowsIntegration(fakeNative({
      values: {
        [key("HKCU", "64", "S", "text")]: { type: "sz", value: "日本語のパス" },
        [key("HKCU", "64", "S", "dword")]: { type: "dword", value: 2 },
        [key("HKCU", "64", "S", "blob")]: { type: "other", value: null },
        [key("HKCU", "64", "S", "bad")]: { type: "sz", value: 5 },
        [key("HKCU", "64", "S", "negative")]: { type: "dword", value: -1 },
      },
      names: { "HKLM|64|S": ["1", "2"], "HKLM|64|BAD": ["1", 2 as never] },
    }).native);
    expect(wrapper.readRegistryValue("HKCU", "S", "text", "64")).toEqual({ type: "sz", value: "日本語のパス" });
    expect(wrapper.readRegistryValue("HKCU", "S", "dword", "64")).toEqual({ type: "dword", value: 2 });
    expect(wrapper.readRegistryValue("HKCU", "S", "blob", "64")).toEqual({ type: "other", value: null });
    expect(wrapper.readRegistryValue("HKCU", "S", "missing", "64")).toBeNull();
    expect(() => wrapper.readRegistryValue("HKCU", "S", "bad", "64")).toThrow(expect.objectContaining({ code: "windows-integration-failed" }));
    expect(() => wrapper.readRegistryValue("HKCU", "S", "negative", "64")).toThrow(WindowsIntegrationError);
    expect(wrapper.readRegistryValueNames("HKLM", "S", "64")).toEqual(["1", "2"]);
    expect(wrapper.readRegistryValueNames("HKLM", "NOPE", "64")).toBeNull();
    expect(() => wrapper.readRegistryValueNames("HKLM", "BAD", "64")).toThrow(WindowsIntegrationError);
  });

  it("inspectCollectorHostRegistration relays only the native verdict for the given target", () => {
    for (const status of ["absent", "ours", "foreign"] as const) {
      const { native, calls } = fakeNative({ inspectResult: { status, errorCode: 0 } });
      const wrapper = createWindowsIntegration(native);
      expect(wrapper.inspectCollectorHostRegistration("chrome")).toBe(status);
      expect(wrapper.inspectCollectorHostRegistration("edge")).toBe(status);
      expect(calls.map((call) => call.args)).toEqual([["chrome"], ["edge"]]);
      expect(() => (wrapper as unknown as Record<string, (...a: unknown[]) => unknown>)["inspectCollectorHostRegistration"]?.("x")).toThrow(/target id/u);
    }
    expect(() => createWindowsIntegration(fakeNative({ inspectResult: { status: "access-denied", errorCode: 5 } }).native).inspectCollectorHostRegistration("chrome"))
      .toThrow(expect.objectContaining({ code: "windows-integration-access-denied" }));
    expect(() => createWindowsIntegration(fakeNative({ inspectResult: { status: "failed", errorCode: 1 } }).native).inspectCollectorHostRegistration("chrome"))
      .toThrow(expect.objectContaining({ code: "windows-integration-failed" }));
    expect(() => createWindowsIntegration(fakeNative({ inspectResult: { status: "value" } }).native).inspectCollectorHostRegistration("chrome")).toThrow(WindowsIntegrationError);
  });

  it("keeps absolute paths out of the error message and out of serialised output", () => {
    const secret = "C:\\Users\\山田太郎\\AppData\\Local\\secret.node";
    const wrapper = createWindowsIntegration(fakeNative({ throwWith: { code: "registry-read-failed", message: `failed near ${secret}` } }).native);
    let thrown: unknown;
    try { wrapper.readRegistryValue("HKCU", "S", "n", "64"); } catch (error: unknown) { thrown = error; }
    expect(thrown).toBeInstanceOf(WindowsIntegrationError);
    const error = thrown as WindowsIntegrationError;
    expect(error.message).not.toMatch(/[A-Za-z]:\\/u);
    expect(error.detail).toContain(secret);              // available for local diagnostics only
    expect(JSON.stringify(error)).not.toContain("山田");   // detail is not enumerable
    expect(JSON.stringify({ ...error })).not.toContain("山田");
    expect(Object.keys(error)).not.toContain("detail");

    try {
      loadWindowsIntegrationFrom({ mode: "development", candidates: [secret] }, undefined, { isTrustedFile: () => true, requireNative: () => { throw new Error(`cannot open ${secret}`); } });
    } catch (loadError: unknown) {
      expect((loadError as Error).message).not.toMatch(/[A-Za-z]:\\/u);
      expect(JSON.stringify(loadError)).not.toContain("山田");
    }
  });

  it("maps register/unregister results and rejects unknown statuses", () => {
    for (const status of ["ok", "foreign", "access-denied", "failed"] as const) {
      expect(createWindowsIntegration(fakeNative({ registerResult: { status, errorCode: 5 } }).native).registerCollectorHost("chrome")).toBe(status);
    }
    expect(createWindowsIntegration(fakeNative({ registerResult: { status: "not-registered" } }).native).unregisterCollectorHost("chrome")).toBe("not-registered");
    // `not-registered` is not a valid register outcome; unknown strings and non-objects fail closed.
    expect(() => createWindowsIntegration(fakeNative({ registerResult: { status: "not-registered" } }).native).registerCollectorHost("chrome")).toThrow(WindowsIntegrationError);
    expect(() => createWindowsIntegration(fakeNative({ registerResult: { status: "deleted-everything" } }).native).unregisterCollectorHost("chrome")).toThrow(WindowsIntegrationError);
    expect(() => createWindowsIntegration(fakeNative({ registerResult: "ok" }).native).registerCollectorHost("chrome")).toThrow(WindowsIntegrationError);
    expect(() => createWindowsIntegration(fakeNative({ registerResult: 42 }).native).replaceForeignCollectorHostRegistration("chrome")).toThrow(WindowsIntegrationError);
  });

  it("maps addon exceptions to typed error codes and keeps the native message as detail", () => {
    const cases: ReadonlyArray<readonly [string | undefined, string]> = [
      ["registry-access-denied", "windows-integration-access-denied"],
      ["known-folder-unavailable", "windows-integration-known-folder-unavailable"],
      ["invalid-argument", "windows-integration-invalid-argument"],
      ["registry-read-failed", "windows-integration-failed"],
      [undefined, "windows-integration-failed"],
    ];
    for (const [nativeCode, expected] of cases) {
      const wrapper = createWindowsIntegration(fakeNative({ throwWith: { message: "native detail", ...(nativeCode === undefined ? {} : { code: nativeCode }) } }).native);
      for (const attempt of [
        () => wrapper.readRegistryValue("HKCU", "S", "n", "64"),
        () => wrapper.readRegistryValueNames("HKCU", "S", "64"),
        () => wrapper.registerCollectorHost("chrome"),
        () => wrapper.unregisterCollectorHost("chrome"),
      ]) {
        try {
          attempt();
          throw new Error("expected a throw");
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(WindowsIntegrationError);
          expect((error as WindowsIntegrationError).code).toBe(expected);
          expect((error as WindowsIntegrationError).detail).toBe("native detail");
        }
      }
    }
  });
});

describe("loader: addon location is code, not configuration", () => {
  const resources = path.join(path.parse(process.cwd()).root, "Program Files", "MAGINALIA", "resources");
  const moduleDirectory = path.join(path.parse(process.cwd()).root, "work", "apps", "desktop", "dist", "main");

  it("packaged mode has exactly one candidate under resources and ignores everything else", () => {
    expect(resolveWindowsIntegrationAddonCandidates({ resourcesPath: resources, defaultApp: undefined, moduleDirectory })).toEqual({
      mode: "packaged",
      candidates: [path.join(resources, "windows-integration", "windows_integration.node")],
    });
    expect(resolveWindowsIntegrationAddonCandidates({ resourcesPath: resources, defaultApp: false })).toEqual({
      mode: "packaged",
      candidates: [path.join(resources, "windows-integration", "windows_integration.node")],
    });
  });

  it("development mode has exactly the compiled-layout build output and no env or cwd candidate", () => {
    const expected = path.join(path.parse(process.cwd()).root, "work", "apps", "desktop", "native", "windows-integration", "build", "Release", "windows_integration.node");
    expect(resolveWindowsIntegrationAddonCandidates({ moduleDirectory })).toEqual({ mode: "development", candidates: [expected] });
    // `electron <script>` (defaultApp) is development even though resourcesPath is set.
    expect(resolveWindowsIntegrationAddonCandidates({ resourcesPath: resources, defaultApp: true, moduleDirectory })).toEqual({ mode: "development", candidates: [expected] });
    expect(resolveWindowsIntegrationAddonCandidates({})).toEqual({ mode: "development", candidates: [] });
  });

  it("ignores the shelf-mutex environment override", () => {
    const previous = process.env["MAGINALIA_SHELF_MUTEX_PATH"];
    process.env["MAGINALIA_SHELF_MUTEX_PATH"] = path.join(os.tmpdir(), "evil.node");
    try {
      expect(resolveWindowsIntegrationAddonCandidates({ moduleDirectory }).candidates.some((candidate) => candidate.includes("evil"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["MAGINALIA_SHELF_MUTEX_PATH"];
      else process.env["MAGINALIA_SHELF_MUTEX_PATH"] = previous;
    }
  });

  it("loads a complete addon, and reports unavailable for missing, broken or partial ones", () => {
    const complete = fakeNative().native;
    const resolution = { mode: "development", candidates: ["C:\\x\\windows_integration.node"] } as const;
    expect(typeof loadWindowsIntegrationFrom(resolution, undefined, { isTrustedFile: () => true, requireNative: () => complete }).registerCollectorHost).toBe("function");

    const unavailable = (deps: Parameters<typeof loadWindowsIntegrationFrom>[2]) => {
      try {
        loadWindowsIntegrationFrom(resolution, undefined, deps);
        throw new Error("expected a throw");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WindowsIntegrationError);
        expect((error as WindowsIntegrationError).code).toBe("windows-integration-unavailable");
        return (error as WindowsIntegrationError).detail ?? "";
      }
    };
    const trusted = { isTrustedFile: () => true };
    expect(unavailable({ ...trusted, requireNative: () => { throw new Error("module not found"); } })).toMatch(/module not found/u);
    expect(unavailable({ ...trusted, requireNative: () => ({ apiVersion: 2, getKnownFolderPath: () => "" }) })).toMatch(/missing .*registerCollectorHost/u);
    expect(unavailable({ ...trusted, requireNative: () => null })).toMatch(/not a Windows integration addon/u);
    // An apiVersion 1 addon (no target argument) is never wrapped: it would ignore the target.
    expect(unavailable({ ...trusted, requireNative: () => fakeNative({ apiVersion: 1 }).native })).toMatch(/apiVersion/u);
    expect(unavailable({ ...trusted, requireNative: () => fakeNative({ targets: "nope" }).native })).toMatch(/target table/u);
    // Development mode also requires a regular file at the exact path (no link, no missing file).
    let loaded = false;
    expect(unavailable({ requireNative: () => { loaded = true; return complete; } })).toMatch(/not a regular file/u);
    expect(loaded).toBe(false);
    expect(() => loadWindowsIntegrationFrom({ mode: "development", candidates: [] }, undefined)).toThrow(WindowsIntegrationError);
  });

  it("packaged mode refuses an untrusted candidate without loading it", () => {
    let loaded = false;
    const packaged = { mode: "packaged", candidates: [path.join(resources, "windows-integration", "windows_integration.node")] } as const;
    let thrown: unknown;
    try {
      loadWindowsIntegrationFrom(packaged, resources, {
        isTrustedFile: () => false,
        requireNative: () => { loaded = true; return fakeNative().native; },
      });
    } catch (error: unknown) { thrown = error; }
    expect(thrown).toBeInstanceOf(WindowsIntegrationError);
    expect((thrown as WindowsIntegrationError).code).toBe("windows-integration-unavailable");
    expect((thrown as WindowsIntegrationError).detail).toMatch(/not a regular file/u);
    expect(loaded).toBe(false);
    expect(typeof loadWindowsIntegrationFrom(packaged, resources, {
      isTrustedFile: () => true,
      requireNative: () => fakeNative().native,
    }).unregisterCollectorHost).toBe("function");
  });
});

describe("source scan: no environment, cwd, argv or Electron path reads", () => {
  // Matches code, not prose: the files avoid these tokens in comments too.
  const forbidden = [/process\s*\.\s*env\b/u, /process\s*\.\s*cwd\b/u, /process\s*\.\s*argv\b/u, /\bapp\s*\.\s*getPath\b/u, /\bprocess\s*\[\s*["']env["']\s*\]/u];
  for (const file of ["windows-integration.ts", "collector-registry-adapter.ts"]) {
    it(`${file} reads none of them`, () => {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      for (const pattern of forbidden) expect(source).not.toMatch(pattern);
    });
  }

  it("the addon source calls no environment, cwd or generic registry-write API", () => {
    const source = readFileSync(path.join(desktopRoot, "native", "windows-integration", "src", "windows_integration.cc"), "utf8");
    for (const token of ["getenv", "GetEnvironmentVariable", "ExpandEnvironmentStrings", "GetCurrentDirectory", "GetCommandLine", "RegSetKeyValue", "RegDeleteValue", "RegDeleteKeyValue", "RegCopyTree", "RegRestoreKey", "RegLoadKey"]) {
      expect(source).not.toContain(token);
    }
    // Every write call targets HostKeyPath(); none takes a caller-supplied key.
    const writes = [...source.matchAll(/\b(RegCreateKeyExW|RegSetValueExW|RegDeleteKeyExW|RegDeleteTreeW)\(([^;]*?);/gu)];
    expect(writes.length).toBeGreaterThan(0);
    const productSource = source.replace(/\/\/ ----- Test-only seam[\s\S]*?#endif  \/\/ MAGINALIA_WI_TEST_SEAM/u, "");
    const productWrites = [...productSource.matchAll(/\b(RegCreateKeyExW|RegDeleteKeyExW)\(([^;]*?);/gu)];
    expect(productWrites.length).toBe(2);
    for (const write of productWrites) expect(write[2]).toContain("HostKeyPath(target)");
    expect(productSource).not.toContain("RegDeleteTreeW");
    // The product key comes only from the compile-time table; the three writers parse their
    // argument with ParseTarget(..., requireWritable = true) before doing anything else.
    expect(productSource).toMatch(/return std::wstring\(kTargets\[index\]\.subkey\);/u);
    for (const name of ["registerCollectorHost", "replaceForeignCollectorHostRegistration", "unregisterCollectorHost"]) {
      expect(productSource).toContain(`ParseTarget(env, info, "${name}", true, &target)`);
    }
    expect(productSource).toContain(`ParseTarget(env, info, "inspectCollectorHostRegistration", false, &target)`);
    expect(productSource).not.toMatch(/GetUtf8\(env, argv\[0\], &target\)[^;]*\bHostKeyPath/u);

    // Known folders are computed, not verified (a fresh profile has no `Programs` folder yet).
    expect(source).toContain("KF_FLAG_DONT_VERIFY");
    expect(source).not.toContain("KF_FLAG_DEFAULT");

    // Every RegOpenKeyExW is read-only: KEY_QUERY_VALUE family only, no write/delete/create bits.
    const opens = [...source.matchAll(/\bRegOpenKeyExW\(([^;]*?);/gu)];
    expect(opens.length).toBeGreaterThan(0);
    for (const open of opens) {
      expect(open[1]).toContain("KEY_QUERY_VALUE");
      expect(open[1]).not.toMatch(/KEY_SET_VALUE|KEY_WRITE|KEY_ALL_ACCESS|KEY_CREATE|DELETE|WRITE_DAC|WRITE_OWNER/u);
    }
  });

  it("the addon's compile-time target table (kTargets) matches the TS table: same writable set, same keys (design 3.2)", () => {
    const source = readFileSync(path.join(desktopRoot, "native", "windows-integration", "src", "windows_integration.cc"), "utf8");
    const block = /constexpr Target kTargets\[\] = \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? "";
    const rows = [...block.matchAll(/\{"(\w+)", L"([^"]+)", (true|false)\}/gu)].map((match) => ({
      id: match[1] ?? "",
      subkey: (match[2] ?? "").replace(/\\\\/gu, "\\"),
      writable: match[3] === "true",
    }));
    expect(rows.map((row) => row.id)).toEqual(["chrome", "edge", "chromium"]);
    for (const row of rows) {
      const ts = COLLECTOR_REGISTRY_TARGETS.find((target) => target.id === row.id);
      expect(ts, row.id).toBeDefined();
      expect(row.subkey, row.id).toBe(ts?.subkey);
      expect(row.writable, row.id).toBe(ts?.writable);
    }
    const tsWritable = COLLECTOR_REGISTRY_TARGETS.filter((target) => target.writable).map((target) => target.id).sort();
    expect(rows.filter((row) => row.writable).map((row) => row.id).sort()).toEqual(tsWritable);
    expect(tsWritable).toEqual(["chrome", "edge"]);
    // Vivaldi stays out of the C++ table until the spike decides (design 3.4); it is read-only in the TS table.
    expect(rows.some((row) => row.id === "vivaldi")).toBe(false);
    expect(COLLECTOR_REGISTRY_TARGETS.find((target) => target.id === "vivaldi")?.writable).toBe(false);
    // Every row writes below HKCU\Software\<vendor>\...\NativeMessagingHosts\org.maginalia.collector.
    for (const row of rows) expect(row.subkey).toMatch(/^Software\\[A-Za-z]+(\\[A-Za-z]+)?\\NativeMessagingHosts\\org\.maginalia\.collector$/u);
  });
});

// ----- Adapter over a fake native registry --------------------------------------------------

describe("product adapter over a fake native module", () => {
  const policyBase = "SOFTWARE\\Policies\\Google\\Chrome";

  function adapterFor(options: FakeNativeOptions): CollectorRegistryAdapter {
    return createCollectorRegistryAdapterOver(createWindowsIntegration(fakeNative(options).native));
  }

  it("relays the native ownership verdict without re-classifying it in JavaScript", () => {
    for (const status of ["absent", "ours", "foreign"] as const) {
      expect(adapterFor({ inspectResult: { status, errorCode: 0 } }).readCollectorHostRegistration("chrome")).toBe(status);
    }
    // The adapter never reads the key's value itself (no JS case folding or empty-string rule).
    const { native, calls } = fakeNative({ inspectResult: { status: "ours", errorCode: 0 } });
    const adapter = createCollectorRegistryAdapterOver(createWindowsIntegration(native));
    adapter.readCollectorHostRegistration("chrome");
    adapter.readCollectorHostRegistration("edge");
    expect(calls.map((call) => call.name)).toEqual(["inspectCollectorHostRegistration", "inspectCollectorHostRegistration"]);
    expect(calls.map((call) => call.args)).toEqual([["chrome"], ["edge"]]);
  });

  it("reads policy facts for the Edge root from its own subkey, and rejects roots outside the enumeration", () => {
    const edgeBase = "SOFTWARE\\Policies\\Microsoft\\Edge";
    const adapter = adapterFor({
      values: {
        [`HKLM|64|${edgeBase}|NativeMessagingUserLevelHosts`]: { type: "dword", value: 0 },
        [`HKLM|64|${edgeBase}\\NativeMessagingBlocklist|1`]: { type: "sz", value: "*" },
        [`HKLM|64|${policyBase}|NativeMessagingUserLevelHosts`]: { type: "dword", value: 1 },
      },
      names: { [`HKLM|64|${edgeBase}\\NativeMessagingBlocklist`]: ["1"] },
    });
    const edge = adapter.readBrowserPolicies("Microsoft\\Edge");
    expect(edge.hklm.nativeMessagingUserLevelHosts).toBe(0);
    expect(edge.hklm.nativeMessagingBlocklist).toEqual(["*"]);
    expect(edge.hkcu.nativeMessagingUserLevelHosts).toBeNull();
    expect(adapter.readBrowserPolicies("Google\\Chrome").hklm.nativeMessagingUserLevelHosts).toBe(1);
    const { native, calls } = fakeNative();
    const guarded = createCollectorRegistryAdapterOver(createWindowsIntegration(native));
    for (const root of ["Google\\Chrome\\..", "", "Vivaldi", "google\\chrome", "..\\Run", 7]) {
      expect(() => guarded.readBrowserPolicies(root as never), String(root)).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    }
    expect(calls).toEqual([]);
  });

  it("reads App Paths for any bare .exe name (HKCU, HKLM 64, HKLM 32) and rejects names with separators", () => {
    const name = "vivaldi.exe";
    const adapter = adapterFor({
      values: {
        [`HKCU|64|Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}|`]: { type: "sz", value: "C:\\Users\\t\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe" },
        [`HKLM|64|SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}|`]: { type: "sz", value: "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe" },
        [`HKLM|32|SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}|`]: { type: "sz", value: "" },
      },
    });
    expect(adapter.readBrowserAppPaths(name)).toEqual([
      { source: "hkcu", value: "C:\\Users\\t\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe" },
      { source: "hklm-64", value: "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe" },
    ]);
    expect(adapter.readBrowserAppPaths("msedge.exe")).toEqual([]);
    const { native, calls } = fakeNative();
    const guarded = createCollectorRegistryAdapterOver(createWindowsIntegration(native));
    for (const bad of ["", "chrome", "chrome.exe\\..\\x", "..\\chrome.exe", "a/b.exe", "a\0.exe", ".exe", "x".repeat(70) + ".exe", 5]) {
      expect(() => guarded.readBrowserAppPaths(bad as never), String(bad)).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    }
    expect(calls).toEqual([]);
  });

  it("reads the default https ProgId from UserChoiceLatest first, then UserChoice", () => {
    const base = "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\";
    expect(adapterFor({ values: { [`HKCU|default|${base}UserChoice|ProgId`]: { type: "sz", value: "VivaldiHTM" } } }).readDefaultBrowserProgId()).toBe("VivaldiHTM");
    expect(adapterFor({
      values: {
        [`HKCU|default|${base}UserChoice|ProgId`]: { type: "sz", value: "VivaldiHTM" },
        [`HKCU|default|${base}UserChoiceLatest|ProgId`]: { type: "sz", value: "MSEdgeHTM" },
      },
    }).readDefaultBrowserProgId()).toBe("MSEdgeHTM");
    // An unusable newer value falls back to the older key.
    expect(adapterFor({
      values: {
        [`HKCU|default|${base}UserChoice|ProgId`]: { type: "sz", value: "ChromeHTML" },
        [`HKCU|default|${base}UserChoiceLatest|ProgId`]: { type: "sz", value: "" },
      },
    }).readDefaultBrowserProgId()).toBe("ChromeHTML");
  });

  it("reads a ProgId's open command raw (HKCU then HKLM), and treats a ProgId that is not a plain name as no command", () => {
    const adapter = adapterFor({
      values: {
        "HKCU|64|Software\\Classes\\VivaldiHTM.ABC123\\shell\\open\\command|": { type: "sz", value: "\"C:\\Users\\t\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe\" -- \"%1\"" },
        "HKLM|64|SOFTWARE\\Classes\\ChromeHTML\\shell\\open\\command|": { type: "expand-sz", value: "\"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\" -- \"%1\"" },
      },
    });
    expect(adapter.readProgIdOpenCommand("VivaldiHTM.ABC123")).toBe("\"C:\\Users\\t\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe\" -- \"%1\"");
    expect(adapter.readProgIdOpenCommand("ChromeHTML")).toBe("\"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\" -- \"%1\"");   // never expanded
    expect(adapter.readProgIdOpenCommand("MSEdgeHTM")).toBeNull();
    const { native, calls } = fakeNative();
    const guarded = createCollectorRegistryAdapterOver(createWindowsIntegration(native));
    for (const bad of ["", "Foo\\Bar", "Foo/Bar", "..\\x", "a b", "a\0b", ".hidden", "x".repeat(300), 5]) {
      expect(guarded.readProgIdOpenCommand(bad as never), String(bad)).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("collects policy facts per hive, with list entries in numeric order", () => {
    const adapter = adapterFor({
      values: {
        [`HKLM|64|${policyBase}|NativeMessagingUserLevelHosts`]: { type: "dword", value: 0 },
        [`HKCU|64|${policyBase}|DeveloperToolsAvailability`]: { type: "dword", value: 2 },
        [`HKLM|64|${policyBase}\\NativeMessagingBlocklist|1`]: { type: "sz", value: "com.other" },
        [`HKLM|64|${policyBase}\\NativeMessagingBlocklist|2`]: { type: "sz", value: "*" },
        [`HKLM|64|${policyBase}\\NativeMessagingBlocklist|10`]: { type: "sz", value: "org.maginalia.collector" },
        [`HKLM|64|${policyBase}\\NativeMessagingBlocklist|junk`]: { type: "dword", value: 1 },
      },
      names: { [`HKLM|64|${policyBase}\\NativeMessagingBlocklist`]: ["10", "2", "1", "junk"], [`HKCU|64|${policyBase}\\NativeMessagingAllowlist`]: [] },
    });
    const snapshot = adapter.readChromePolicies();
    expect(snapshot.hklm.nativeMessagingUserLevelHosts).toBe(0);
    expect(snapshot.hklm.nativeMessagingBlocklist).toEqual(["com.other", "*", "org.maginalia.collector"]);
    expect(snapshot.hkcu.developerToolsAvailability).toBe(2);
    expect(snapshot.hkcu.nativeMessagingAllowlist).toEqual([]);
    expect(snapshot.hkcu.nativeMessagingBlocklist).toBeNull();
    expect(snapshot.hkcu.nativeMessagingUserLevelHosts).toBeNull();
    expect(snapshot.hklm.extensionInstallAllowlist).toBeNull();
  });

  it("reads Chrome App Paths from HKCU then both HKLM views, and the default browser ProgId", () => {
    const hklm = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
    const hkcu = "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
    const adapter = adapterFor({
      values: {
        [`HKCU|64|${hkcu}|`]: { type: "sz", value: "C:\\Users\\t\\chrome.exe" },
        [`HKLM|32|${hklm}|`]: { type: "sz", value: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
        [`HKLM|64|${hklm}|`]: { type: "dword", value: 1 },
        "HKCU|default|Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice|ProgId": { type: "sz", value: "ChromeHTML" },
      },
    });
    expect(adapter.readChromeAppPaths()).toEqual([
      { source: "hkcu", value: "C:\\Users\\t\\chrome.exe" },
      { source: "hklm-32", value: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
    ]);
    expect(adapter.readDefaultBrowserProgId()).toBe("ChromeHTML");
    expect(adapterFor({}).readDefaultBrowserProgId()).toBeNull();
    expect(adapterFor({}).readChromeAppPaths()).toEqual([]);
  });

  it("delegates the three mutators with exactly the target id, and refuses read-only or unknown targets", () => {
    const { native, calls } = fakeNative();
    const adapter = createCollectorRegistryAdapterOver(createWindowsIntegration(native));
    expect(adapter.registerCollectorHost("edge")).toBe("ok");
    expect(adapter.unregisterCollectorHost("edge")).toBe("ok");
    expect(adapter.replaceForeignCollectorHostRegistration("chrome")).toBe("ok");
    expect(calls.map((call) => call.args)).toEqual([["edge"], ["edge"], ["chrome"]]);
    for (const target of ["chromium", "vivaldi"] as const) {
      expect(() => adapter.registerCollectorHost(target)).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
      expect(() => adapter.unregisterCollectorHost(target)).toThrow(WindowsIntegrationError);
      expect(() => adapter.replaceForeignCollectorHostRegistration(target)).toThrow(WindowsIntegrationError);
    }
    expect(calls).toHaveLength(3);
    expect(Object.keys(adapter).sort()).toEqual([
      "getKnownFolderPath",
      "readBrowserAppPaths",
      "readBrowserPolicies",
      "readChromeAppPaths",
      "readChromePolicies",
      "readCollectorHostRegistration",
      "readDefaultBrowserProgId",
      "readProgIdOpenCommand",
      "registerCollectorHost",
      "replaceForeignCollectorHostRegistration",
      "unregisterCollectorHost",
    ]);
  });
});

describe("FakeCollectorRegistryAdapter (test helper)", () => {
  it("models the addon's ownership classes: register never overwrites foreign, unregister is value-matched", () => {
    const fake = new FakeCollectorRegistryAdapter();
    expect(collectorManifestPathFor(fake.knownFolders.UserProgramFiles)).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\MAGINALIA Collector\\org.maginalia.collector.json");
    expect(fake.readCollectorHostRegistration()).toBe("absent");
    expect(fake.unregisterCollectorHost()).toBe("not-registered");
    expect(fake.registerCollectorHost()).toBe("ok");
    expect(fake.readCollectorHostRegistration()).toBe("ours");
    expect(fake.registerCollectorHost()).toBe("ok");

    fake.registration = "foreign";
    expect(fake.registerCollectorHost()).toBe("foreign");
    expect(fake.unregisterCollectorHost()).toBe("foreign");
    expect(fake.readCollectorHostRegistration()).toBe("foreign");
    expect(fake.replaceForeignCollectorHostRegistration()).toBe("ok");
    expect(fake.readCollectorHostRegistration()).toBe("ours");
    expect(fake.unregisterCollectorHost()).toBe("ok");
    expect(fake.readCollectorHostRegistration()).toBe("absent");
    // An empty or valueless default is `absent` in the addon too, so register repairs it.
    fake.registration = "absent";
    expect(fake.registerCollectorHost()).toBe("ok");
  });

  it("keeps ownership per target and mirrors the wrapper's refusals (read-only and out-of-table targets)", () => {
    const fake = new FakeCollectorRegistryAdapter();
    expect(fake.registerCollectorHost("edge")).toBe("ok");
    expect(fake.readCollectorHostRegistration("edge")).toBe("ours");
    expect(fake.readCollectorHostRegistration("chrome")).toBe("absent");
    fake.registrations.chromium = "foreign";
    expect(fake.readCollectorHostRegistration("chromium")).toBe("foreign");
    expect(() => fake.registerCollectorHost("chromium")).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    expect(() => fake.unregisterCollectorHost("vivaldi")).toThrow(WindowsIntegrationError);
    expect(() => fake.readCollectorHostRegistration("vivaldi")).toThrow(WindowsIntegrationError);
    fake.registrations.chrome = "foreign";
    expect(fake.replaceForeignCollectorHostRegistration("chrome")).toBe("ok");
    expect(fake.unregisterCollectorHost("edge")).toBe("ok");
    expect(fake.readCollectorHostRegistration("edge")).toBe("absent");
    expect(fake.targetCalls.filter((entry) => entry.call === "registerCollectorHost")).toEqual([
      { call: "registerCollectorHost", target: "edge" },
      { call: "registerCollectorHost", target: "chromium" },
    ]);
    // New read-only facts.
    fake.progIdOpenCommands["VivaldiHTM"] = "cmd";
    fake.appPathsByName["vivaldi.exe"] = [{ source: "hkcu", value: "C:\\v\\vivaldi.exe" }];
    expect(fake.readProgIdOpenCommand("VivaldiHTM")).toBe("cmd");
    expect(fake.readProgIdOpenCommand("Other")).toBeNull();
    expect(fake.readBrowserAppPaths("vivaldi.exe")).toEqual([{ source: "hkcu", value: "C:\\v\\vivaldi.exe" }]);
    expect(fake.readBrowserAppPaths("msedge.exe")).toEqual([]);
  });

  it("supports fault injection and forced outcomes for state-machine tests", () => {
    const fake = new FakeCollectorRegistryAdapter();
    fake.failNext.readChromePolicies = new Error("boom");
    expect(() => fake.readChromePolicies()).toThrow("boom");
    expect(fake.readChromePolicies().hkcu).toEqual(EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"));
    fake.nextRegisterOutcome = "access-denied";
    expect(fake.registerCollectorHost()).toBe("access-denied");
    expect(fake.readCollectorHostRegistration()).toBe("absent");
    expect(fake.calls).toContain("registerCollectorHost");
  });
});

// ----- Native: harmless reads on the PRODUCT addon ------------------------------------------

nativeDescribe("native product addon: read-only", () => {
  const requireNative = createRequire(import.meta.url);
  const integration: WindowsIntegration = createWindowsIntegration(requireNative(productAddonPath) as WindowsIntegrationNative);

  it("exports exactly the product API", () => {
    const native = requireNative(productAddonPath) as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(native).sort()).toEqual([...WINDOWS_INTEGRATION_NATIVE_EXPORTS].sort());
    expect(native["apiVersion"]).toBe(WINDOWS_INTEGRATION_API_VERSION);
    expect(native["apiVersion"]).toBe(2);
  });

  it("its target table equals the TS table: same writable set, same keys, vivaldi absent (design 3.2)", () => {
    const listed = integration.listCollectorHostTargets();
    expect(listed.map((row) => row.id)).toEqual(["chrome", "edge", "chromium"]);
    expect(listed.filter((row) => row.writable).map((row) => row.id).sort()).toEqual(
      COLLECTOR_REGISTRY_TARGETS.filter((target) => target.writable).map((target) => target.id).sort(),
    );
    for (const row of listed) {
      const ts = COLLECTOR_REGISTRY_TARGETS.find((target) => target.id === row.id);
      expect(ts, row.id).toBeDefined();
      expect(row.subkey, row.id).toBe(ts?.subkey);
      expect(row.writable, row.id).toBe(ts?.writable);
    }
    // Every TS target the addon does not list is read-only in the TS table (vivaldi until the spike).
    for (const target of COLLECTOR_REGISTRY_TARGETS) {
      if (!listed.some((row) => row.id === target.id)) expect(target.writable, target.id).toBe(false);
    }
    expect(listed.find((row) => row.id === "chrome")?.subkey).toBe(COLLECTOR_HOST_REGISTRY_SUBKEY);
  });

  it("writers and inspect reject unknown, read-only and malformed targets before touching the registry", () => {
    // Only arguments the addon must refuse are passed to the PRODUCT writers (never chrome or edge).
    const native = requireNative(productAddonPath) as Record<string, (...args: unknown[]) => unknown>;
    const badTargets: unknown[][] = [
      [], ["chromium"], ["vivaldi"], ["Chrome"], ["EDGE"], ["chrome "], [" chrome"], ["chrome\0"], [""], ["../chrome"],
      ["HKCU"], ["Software\\Google\\Chrome\\NativeMessagingHosts\\org.maginalia.collector"], [1], [null], [{}], [["chrome"]],
      ["vivaldi", "x"], ["chromium", "chromium"],
    ];
    for (const name of ["registerCollectorHost", "unregisterCollectorHost", "replaceForeignCollectorHostRegistration"]) {
      for (const args of badTargets) {
        expect(() => native[name]?.(...args), `${name}(${JSON.stringify(args)})`).toThrow(/expects one writable target id/u);
      }
    }
    // Inspect (read-only) accepts the three table rows and rejects the rest, including vivaldi.
    for (const args of [[], ["vivaldi"], ["Chrome"], ["chrome\0"], [""], [1], ["chrome", "edge"]] as unknown[][]) {
      expect(() => native["inspectCollectorHostRegistration"]?.(...args), JSON.stringify(args)).toThrow(/expects one target id/u);
    }
    for (const target of ["chrome", "edge", "chromium"]) {
      expect(["absent", "ours", "foreign"]).toContain((native["inspectCollectorHostRegistration"]?.(target) as { status: string }).status);
    }
    expect(() => native["listCollectorHostTargets"]?.()).not.toThrow();
  });

  it("resolves the four known folders to local absolute paths", () => {
    for (const id of ["UserProgramFiles", "LocalAppData", "ProgramFiles", "ProgramFilesX86"] as const) {
      const value = integration.getKnownFolderPath(id);
      expect(value).toMatch(/^[A-Za-z]:\\/u);
    }
    expect(integration.getKnownFolderPath("UserProgramFiles").toLowerCase()).toContain("programs");
    expect(integration.getKnownFolderPath("ProgramFiles").toLowerCase()).toContain("program files");
    expect(() => integration.getKnownFolderPath("Desktop" as never)).toThrow(WindowsIntegrationError);
  });

  it("reads a harmless HKLM string value as UTF-16 and a missing value or key as null", () => {
    const product = integration.readRegistryValue("HKLM", "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "ProductName", "64");
    expect(product?.type).toBe("sz");
    expect(typeof product?.value === "string" && product.value.length > 0).toBe(true);
    expect(integration.readRegistryValue("HKLM", "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "NoSuchValue-" + randomUUID(), "64")).toBeNull();
    expect(integration.readRegistryValue("HKCU", "Software\\MAGINALIA-NoSuchKey-" + randomUUID(), "", "default")).toBeNull();
    expect(integration.readRegistryValueNames("HKCU", "Software\\MAGINALIA-NoSuchKey-" + randomUUID(), "default")).toBeNull();
    const names = integration.readRegistryValueNames("HKLM", "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "64");
    expect(names).toContain("ProductName");
  });

  it("reads a DWORD value without expanding anything", () => {
    const value = integration.readRegistryValue("HKLM", "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "CurrentMajorVersionNumber", "64");
    expect(value?.type).toBe("dword");
    expect(typeof value?.value === "number" && value.value >= 10).toBe(true);
  });

  it("rejects bad native arguments instead of guessing", () => {
    const native = requireNative(productAddonPath) as Record<string, (...args: unknown[]) => unknown>;
    expect(() => native["readRegistryValue"]?.("HKCR", "Software", "", "64")).toThrow(/readRegistryValue expects/u);
    expect(() => native["readRegistryValue"]?.("HKCU", "Software", "", "64", "extra")).toThrow(/expects/u);
    expect(() => native["getKnownFolderPath"]?.("../../evil")).toThrow(/Unknown known folder/u);
    expect(() => native["getKnownFolderPath"]?.("UserProgramFiles", "extra")).toThrow(/expects one/u);
  });

  it("can read the real registration key (read only) through the adapter", () => {
    const adapter = createCollectorRegistryAdapterOver(integration);
    for (const target of ["chrome", "edge", "chromium"] as const) {
      expect(["absent", "ours", "foreign"]).toContain(adapter.readCollectorHostRegistration(target));
    }
    expect(() => adapter.readCollectorHostRegistration("vivaldi")).toThrow(WindowsIntegrationError);
    expect(Array.isArray(adapter.readBrowserAppPaths("msedge.exe"))).toBe(true);
    expect(adapter.readBrowserPolicies("Microsoft\\Edge").hkcu.hive).toBe("HKCU");
    expect(adapter.readProgIdOpenCommand("ChromeHTML") === null || typeof adapter.readProgIdOpenCommand("ChromeHTML") === "string").toBe(true);
    expect(adapter.readChromePolicies().hklm.hive).toBe("HKLM");
    expect(Array.isArray(adapter.readChromeAppPaths())).toBe(true);
    const progId = adapter.readDefaultBrowserProgId();
    expect(progId === null || typeof progId === "string").toBe(true);
  });
});

// ----- Native: register/unregister through the test-seam build only (OPT-IN) ---------------

registrySeamDescribe("native test-seam build: register/unregister in private temp subkeys, per target (opt-in)", () => {
  const requireNative = createRequire(import.meta.url);
  type SeamResult = { status: string; errorCode: number };
  const seam = requireNative(testAddonPath) as {
    testSetRoot(root: string): string;
    testSeedValue(target: string, kind: string, value: string): SeamResult;
    testSeedSubkey(target: string): SeamResult;
    testCleanup(): SeamResult;
    listCollectorHostTargets(): Array<{ id: string; subkey: string; writable: boolean }>;
    inspectCollectorHostRegistration(target: string): SeamResult;
    registerCollectorHost(target: string): SeamResult;
    unregisterCollectorHost(target: string): SeamResult;
    replaceForeignCollectorHostRegistration(target: string): SeamResult;
  };
  const reader = createWindowsIntegration(requireNative(productAddonPath) as WindowsIntegrationNative);
  const rootKey = `Software\\MAGINALIA-Tests\\${randomUUID()}`;
  const hostKeyOf = (target: string) => `${rootKey}\\${target}\\NativeMessagingHosts\\org.maginalia.collector`;
  const manifest = collectorManifestPathFor(reader.getKnownFolderPath("UserProgramFiles"));
  // The real product keys of every table row: never touched, checked before and after.
  const realKeys = COLLECTOR_REGISTRY_TARGETS.map((target) => target.subkey);
  const realBefore = realKeys.map((subkey) => reader.readRegistryValue("HKCU", subkey, "", "64"));
  const readHost = (target: string) => reader.readRegistryValue("HKCU", hostKeyOf(target), "", "64");
  const verdict = (target: string) => seam.inspectCollectorHostRegistration(target).status;
  const writable = ["chrome", "edge"] as const;

  afterAll(() => {
    seam.testCleanup();
    // Leave nothing behind, and leave the real registration keys exactly as they were.
    for (const target of ["chrome", "edge", "chromium"]) expect(readHost(target)).toBeNull();
    expect(reader.readRegistryValueNames("HKCU", rootKey, "64")).toBeNull();
    expect(realKeys.map((subkey) => reader.readRegistryValue("HKCU", subkey, "", "64"))).toEqual(realBefore);
  });

  it("refuses every call until a private test root is chosen, and rejects roots outside the test area", () => {
    // No root yet: the seam build must not fall back to a real key, for any target.
    for (const target of writable) {
      expect(seam.registerCollectorHost(target)).toMatchObject({ status: "failed" });
      expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "failed" });
      expect(seam.replaceForeignCollectorHostRegistration(target)).toMatchObject({ status: "failed" });
    }
    for (const target of ["chrome", "edge", "chromium"]) expect(seam.inspectCollectorHostRegistration(target)).toMatchObject({ status: "failed" });
    for (const bad of [
      "Software\\Google\\Chrome",
      "Software\\Microsoft\\Edge",
      "Software\\MAGINALIA-Tests\\",
      "Software\\MAGINALIA-Tests\\..\\Google",
      "Software\\MAGINALIA-Tests\\a/b",
      "software\\maginalia-testsX\\a",
      "",
    ]) {
      expect(() => seam.testSetRoot(bad)).toThrow(/testSetRoot requires/u);
    }
    expect(realKeys.map((subkey) => reader.readRegistryValue("HKCU", subkey, "", "64"))).toEqual(realBefore);
  });

  it("keeps the same table and target validation as the product build", () => {
    expect(seam.listCollectorHostTargets().map((row) => `${row.id}:${row.writable}`)).toEqual(["chrome:true", "edge:true", "chromium:false"]);
    expect(seam.testSetRoot(rootKey)).toBe(hostKeyOf("chrome"));
    for (const name of ["registerCollectorHost", "unregisterCollectorHost", "replaceForeignCollectorHostRegistration"] as const) {
      for (const bad of ["chromium", "vivaldi", "Chrome", "", "chrome\0"]) {
        expect(() => seam[name](bad), `${name}(${bad})`).toThrow(/expects one writable target id/u);
      }
    }
    expect(() => seam.inspectCollectorHostRegistration("vivaldi")).toThrow(/expects one target id/u);
    // Nothing above created a key.
    for (const target of ["chrome", "edge", "chromium"]) expect(readHost(target)).toBeNull();
  });

  for (const target of writable) {
    describe(`target ${target}`, () => {
      const host = () => readHost(target);
      const other = target === "chrome" ? "edge" : "chrome";

      it("treats a missing key, a valueless key and an empty REG_SZ default as absent, and register repairs it", () => {
        expect(host()).toBeNull();
        expect(verdict(target)).toBe("absent");
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "not-registered" });
        expect(seam.testSeedValue(target, "no-default", "")).toMatchObject({ status: "ok" });
        expect(verdict(target)).toBe("absent");
        expect(seam.testSeedValue(target, "empty-sz", "")).toMatchObject({ status: "ok" });
        expect(host()).toEqual({ type: "sz", value: "" });
        expect(verdict(target)).toBe("absent");
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "not-registered" });
        expect(host()).toEqual({ type: "sz", value: "" });   // an empty-default key is left alone
        expect(seam.registerCollectorHost(target)).toMatchObject({ status: "ok" });
        expect(host()).toEqual({ type: "sz", value: manifest });
        expect(verdict(target)).toBe("ours");
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "ok" });
        expect(host()).toBeNull();
      });

      it("registers the fixed manifest path in its own key only, is idempotent, and is value-matched on unregister", () => {
        const otherBefore = readHost(other);
        const otherVerdictBefore = verdict(other);
        expect(seam.registerCollectorHost(target)).toMatchObject({ status: "ok", errorCode: 0 });
        expect(host()).toEqual({ type: "sz", value: manifest });
        expect(readHost(other)).toEqual(otherBefore);            // no other target was written
        expect(readHost("chromium")).toBeNull();
        expect(verdict(other)).toBe(otherVerdictBefore);
        expect(seam.registerCollectorHost(target)).toMatchObject({ status: "ok" });
        expect(host()).toEqual({ type: "sz", value: manifest });

        // A foreign registration is never overwritten by register, and unregister leaves it.
        const foreign = "C:\\Program Files\\Standalone Host\\host.json";
        expect(seam.testSeedValue(target, "sz", foreign)).toMatchObject({ status: "ok" });
        expect(verdict(target)).toBe("foreign");
        expect(seam.registerCollectorHost(target)).toMatchObject({ status: "foreign" });
        expect(host()).toEqual({ type: "sz", value: foreign });
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "foreign" });
        expect(host()).toEqual({ type: "sz", value: foreign });

        // Only the explicit replace entry point overwrites it; then unregister removes our key.
        expect(seam.replaceForeignCollectorHostRegistration(target)).toMatchObject({ status: "ok" });
        expect(host()).toEqual({ type: "sz", value: manifest });
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "ok" });
        expect(host()).toBeNull();
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "not-registered" });
      });

      it("classifies type, path-variant and size variants as foreign and never deletes them", () => {
        const variants: ReadonlyArray<readonly [string, string, string]> = [
          ["REG_EXPAND_SZ", "expand-sz", manifest],
          ["DWORD", "dword", ""],
          ["binary", "binary", ""],
          ["trailing backslash", "sz", `${manifest}\\`],
          ["trailing slash", "sz", `${manifest}/`],
          ["extended-length prefix", "sz", `\\\\?\\${manifest}`],
          ["leading space", "sz", ` ${manifest}`],
          ["parent directory", "sz", path.win32.dirname(manifest)],
          ["long value (20000 chars)", "sz", `C:\\${"a".repeat(20000)}`],
          ["oversized value (100000 chars)", "sz", `C:\\${"a".repeat(100000)}`],
        ];
        for (const [label, kind, text] of variants) {
          expect(seam.testSeedValue(target, kind, text), label).toMatchObject({ status: "ok" });
          expect(verdict(target), label).toBe("foreign");
          expect(seam.unregisterCollectorHost(target), label).toMatchObject({ status: "foreign" });
          expect(seam.registerCollectorHost(target), label).toMatchObject({ status: "foreign" });
        }
        expect(seam.replaceForeignCollectorHostRegistration(target)).toMatchObject({ status: "ok" });
        expect(verdict(target)).toBe("ours");
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "ok" });
      });

      it("matches the manifest path case-insensitively and does not fold dotted capital I", () => {
        expect(seam.testSeedValue(target, "sz", manifest.toUpperCase())).toMatchObject({ status: "ok" });
        expect(verdict(target)).toBe("ours");
        expect(seam.testSeedValue(target, "sz", manifest.toLowerCase())).toMatchObject({ status: "ok" });
        expect(verdict(target)).toBe("ours");
        // U+0130 (dotted capital I) is not the same character as "i" in an ordinal comparison.
        expect(seam.testSeedValue(target, "sz", manifest.replace("i", "\u0130"))).toMatchObject({ status: "ok" });
        expect(verdict(target)).toBe("foreign");
        expect(seam.testSeedValue(target, "sz", manifest.toLowerCase())).toMatchObject({ status: "ok" });
        expect(seam.unregisterCollectorHost(target)).toMatchObject({ status: "ok" });
        expect(host()).toBeNull();
      });

      it("reports a key with subkeys as a plain failure, not access-denied, and keeps it", () => {
        expect(seam.registerCollectorHost(target)).toMatchObject({ status: "ok" });
        expect(seam.testSeedSubkey(target)).toMatchObject({ status: "ok" });
        const result = seam.unregisterCollectorHost(target);
        expect(result.status).toBe("failed");
        expect(result.errorCode).toBe(145);          // ERROR_DIR_NOT_EMPTY
        expect(host()).toEqual({ type: "sz", value: manifest });
        // Test cleanup of this key happens in afterAll (the whole private root is removed).
      });
    });
  }

  describe("target chromium (read-only)", () => {
    it("is inspected with the same ownership rules but can be neither written, replaced nor deleted", () => {
      expect(verdict("chromium")).toBe("absent");
      expect(seam.testSeedValue("chromium", "sz", manifest)).toMatchObject({ status: "ok" });
      expect(verdict("chromium")).toBe("ours");
      expect(seam.testSeedValue("chromium", "sz", "C:\\Other\\host.json")).toMatchObject({ status: "ok" });
      expect(verdict("chromium")).toBe("foreign");
      for (const name of ["registerCollectorHost", "unregisterCollectorHost", "replaceForeignCollectorHostRegistration"] as const) {
        expect(() => seam[name]("chromium")).toThrow(/expects one writable target id/u);
      }
      expect(readHost("chromium")).toEqual({ type: "sz", value: "C:\\Other\\host.json" });   // untouched
    });
  });
});

// ----- Native: the product binary has no test seam -----------------------------------------

nativeDescribe("product binary: no test seam, product-only export table", () => {
  it("exports only the N-API registration pair natively and contains no seam strings", async () => {
    const script = await loadAddonScript();
    const product = await readFile(productAddonPath);
    expect(script.listNativeExports(product)).toEqual([...script.PRODUCT_NATIVE_EXPORTS].sort());
    expect(script.findTestSeamMarkers(product)).toEqual([]);
    expect(() => script.assertProductBinary(product)).not.toThrow();
    // The registry sandbox prefix and seam function names exist only in the test target.
    for (const marker of ["MAGINALIA-Tests", "testSetRoot", "testSeedValue", "testCleanup"]) {
      expect(product.includes(Buffer.from(marker, "latin1"))).toBe(false);
      expect(product.includes(Buffer.from(marker, "utf16le"))).toBe(false);
    }
    expect(product.includes(Buffer.from("RegDeleteTreeW", "latin1"))).toBe(false);
  });

  it("the check detects the seam build (so a passing product check is meaningful)", async () => {
    const script = await loadAddonScript();
    const seamBinary = await readFile(testAddonPath);
    expect(script.findTestSeamMarkers(seamBinary).length).toBeGreaterThan(0);
    expect(() => script.assertProductBinary(seamBinary)).toThrow(/test-seam/u);
  });
});

// ----- Staging checks ----------------------------------------------------------------------

nativeDescribe("staging checks (scripts/windows-integration-addon.mjs)", () => {
  const scratchRoots: string[] = [];
  afterAll(async () => {
    for (const root of scratchRoots) await rm(root, { recursive: true, force: true });
  });
  const scratch = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maginalia-stage-wi-"));
    scratchRoots.push(root);
    return root;
  };

  it("fails closed when the addon is missing", async () => {
    const script = await loadAddonScript();
    const root = await scratch();
    await expect(script.stageWindowsIntegrationAddon({ desktopRoot: root, repositoryRoot: root, runtimeRoot: path.join(root, "runtime") })).rejects.toThrow(/build:native/u);
  });

  it("stages the verified product addon with provenance", async () => {
    const script = await loadAddonScript();
    const root = await scratch();
    const runtimeRoot = path.join(root, "runtime");
    const provenance = await script.stageWindowsIntegrationAddon({ desktopRoot, repositoryRoot, runtimeRoot });
    expect(provenance.napiVersion).toBe(8);
    expect(provenance.crt).toBe("static (/MT)");
    expect(provenance.addonApiVersion).toBe(2);
    expect(provenance.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const staged = await readFile(path.join(runtimeRoot, "windows-integration", "windows_integration.node"));
    expect(staged.length).toBe(provenance.bytes);
    expect(staged.equals(await readFile(productAddonPath))).toBe(true);
  });

  it("refuses to stage the test-seam build even when it is renamed to the product file name", async () => {
    const script = await loadAddonScript();
    const root = await scratch();
    const fakeDesktop = path.join(root, "desktop");
    const nativeDirectory = path.join(fakeDesktop, "native", "windows-integration");
    await mkdir(path.join(nativeDirectory, "build", "Release"), { recursive: true });
    await cp(path.join(desktopRoot, "native", "windows-integration", "binding.gyp"), path.join(nativeDirectory, "binding.gyp"));
    await cp(testAddonPath, path.join(nativeDirectory, "build", "Release", "windows_integration.node"));
    await expect(script.stageWindowsIntegrationAddon({ desktopRoot: fakeDesktop, repositoryRoot: root, runtimeRoot: path.join(root, "runtime") })).rejects.toThrow(/test-seam|native exports/u);
  });

  it("refuses a binding.gyp that drops N-API 8 or the static CRT", async () => {
    const script = await loadAddonScript();
    const root = await scratch();
    const fakeDesktop = path.join(root, "desktop");
    const nativeDirectory = path.join(fakeDesktop, "native", "windows-integration");
    await mkdir(path.join(nativeDirectory, "build", "Release"), { recursive: true });
    await cp(productAddonPath, path.join(nativeDirectory, "build", "Release", "windows_integration.node"));
    const gyp = readFileSync(path.join(desktopRoot, "native", "windows-integration", "binding.gyp"), "utf8");
    const write = async (text: string) => (await import("node:fs/promises")).writeFile(path.join(nativeDirectory, "binding.gyp"), text, "utf8");
    await write(gyp.replace(/"RuntimeLibrary": "0"/gu, '"RuntimeLibrary": "2"'));
    await expect(script.stageWindowsIntegrationAddon({ desktopRoot: fakeDesktop, repositoryRoot: root, runtimeRoot: path.join(root, "runtime") })).rejects.toThrow(/static CRT/u);
    await write(gyp.replace(/NAPI_VERSION=8/gu, "NAPI_VERSION=9"));
    await expect(script.stageWindowsIntegrationAddon({ desktopRoot: fakeDesktop, repositoryRoot: root, runtimeRoot: path.join(root, "runtime") })).rejects.toThrow(/NAPI_VERSION=8/u);
  });
});

describe("packaging configuration", () => {
  it("ships the addon next to shelf-mutex without disturbing existing entries", () => {
    const config = JSON.parse(readFileSync(path.join(desktopRoot, "packaging", "electron-builder.json"), "utf8")) as { extraResources: Array<{ from: string; to: string; filter?: string[] }> };
    const targets = config.extraResources.map((entry) => entry.to);
    expect(targets).toContain("shelf-mutex");
    expect(config.extraResources.find((entry) => entry.to === "windows-integration")).toEqual({
      from: "packaging/runtime/windows-integration",
      to: "windows-integration",
      filter: ["windows_integration.node", "PROVENANCE.json"],
    });
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("binding.gyp keeps the test seam in a separate, non-shipped target", () => {
    const gyp = JSON.parse(readFileSync(path.join(desktopRoot, "native", "windows-integration", "binding.gyp"), "utf8")) as { targets: Array<{ target_name: string; defines: string[] }> };
    const byName = Object.fromEntries(gyp.targets.map((target) => [target.target_name, target.defines]));
    expect(Object.keys(byName).sort()).toEqual(["windows_integration", "windows_integration_test"]);
    expect(byName["windows_integration"]).not.toContain("MAGINALIA_WI_TEST_SEAM=1");
    expect(byName["windows_integration_test"]).toContain("MAGINALIA_WI_TEST_SEAM=1");
    const builder = readFileSync(path.join(desktopRoot, "packaging", "electron-builder.json"), "utf8");
    expect(builder).not.toContain("windows_integration_test");
  });
});
