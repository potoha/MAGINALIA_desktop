import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeFacts } from "./collector-host-fixture.test-helper.js";
import { payloadDescriptorFixture, stateFileText } from "./collector-integration.test-helper.js";
import { FakeCollectorRegistryAdapter } from "./collector-registry-adapter.test-helper.js";
import { CollectorPayloadNotEmbeddedError, createCollectorIntegrationRuntimeFromParts, createCollectorStartupRefreshFromParts } from "./collector-startup-refresh-composition.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function machine(): Promise<{ root: string; registry: FakeCollectorRegistryAdapter; programFolder: string; noticePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maginalia-wp5c-"));
  directories.push(root);
  const registry = new FakeCollectorRegistryAdapter();
  registry.knownFolders = { ...registry.knownFolders, LocalAppData: path.win32.join(root, "Local"), UserProgramFiles: path.win32.join(root, "Programs") };
  await mkdir(registry.knownFolders.LocalAppData, { recursive: true });
  await mkdir(registry.knownFolders.UserProgramFiles, { recursive: true });
  return { root, registry, programFolder: path.win32.join(registry.knownFolders.UserProgramFiles, "MAGINALIA Collector"), noticePath: path.join(root, "userData", "collector-notices.json") };
}

const parts = (m: Awaited<ReturnType<typeof machine>>, extra: Partial<Parameters<typeof createCollectorStartupRefreshFromParts>[0]> = {}) => ({
  e2eIsolationActive: false,
  createRegistry: () => m.registry,
  inspectPathSecurity: () => safeFacts(true),
  createPrivateDirectory: () => "exists" as const,
  resourcesPath: path.join(m.root, "resources"),
  isPackaged: false,
  compiledPayload: { embedded: true, value: payloadDescriptorFixture() },
  processEnvironment: { SystemRoot: "C:\Windows" },
  noticeStatePath: m.noticePath,
  ...extra,
});

describe("startup refresh composition (unwired)", () => {
  it("constructs nothing and does nothing under E2E isolation", async () => {
    const m = await machine();
    let constructed = 0;
    const startup = createCollectorStartupRefreshFromParts(parts(m, { e2eIsolationActive: true, createRegistry: () => { constructed += 1; return m.registry; } }));
    expect((await startup.runStartup()).outcome).toBe("skipped-e2e-isolation");
    expect(constructed).toBe(0);
    expect(await readdir(m.root)).toEqual(["Local", "Programs"]);
  });

  it("writes nothing outside userData for a machine without the integration state (alpha1 notice only)", async () => {
    const m = await machine();
    const startup = createCollectorStartupRefreshFromParts(parts(m));
    const result = await startup.runStartup();
    expect(result.outcome).toBe("not-opted-in");
    expect(result.notices).toEqual([]);
    expect(await readdir(m.root)).toEqual(["Local", "Programs"]); // nothing, not even userData, before a surface exists
    expect((await startup.markNoticeSurfaceReady()).map((notice) => notice.kind)).toEqual(["alpha1-migration"]);
    expect(await readdir(m.root)).toEqual(["Local", "Programs", "userData"]);
    expect(await readdir(m.registry.knownFolders.LocalAppData)).toEqual([]);
    expect(await readdir(m.registry.knownFolders.UserProgramFiles)).toEqual([]);
  });

  it("recognizes the opt-in from a valid state file and raises a repair notice (no automatic repair) for a damaged folder", async () => {
    const m = await machine();
    m.registry.registration = "ours";
    await mkdir(m.programFolder, { recursive: true });
    await writeFile(path.join(m.programFolder, "integration-state.json"), stateFileText(), "utf8");
    const before = await readdir(m.programFolder);
    const result = await createCollectorStartupRefreshFromParts(parts(m)).runStartup();
    expect(result.notices.map((notice) => notice.kind)).toEqual(["repair"]);
    expect(await readdir(m.programFolder)).toEqual(before);
  });

  it("shows the alpha1 notice only once", async () => {
    const m = await machine();
    const firstRun = createCollectorStartupRefreshFromParts(parts(m));
    await firstRun.runStartup();
    expect((await firstRun.markNoticeSurfaceReady()).map((notice) => notice.kind)).toEqual(["alpha1-migration"]);
    const secondRun = createCollectorStartupRefreshFromParts(parts(m));
    await secondRun.runStartup();
    expect(await secondRun.markNoticeSurfaceReady()).toEqual([]);
  });

  it("without an embedded payload: a development build is inert, a packaged app fails loudly", async () => {
    const m = await machine();
    let constructed = 0;
    const missing = { embedded: false, value: null };
    const createRegistry = () => { constructed += 1; return m.registry; };
    const dev = createCollectorStartupRefreshFromParts(parts(m, { compiledPayload: missing, createRegistry }));
    const result = await dev.runStartup();
    expect(result.outcome).toBe("skipped-no-payload");
    expect(result.notices).toEqual([]);
    expect(constructed).toBe(0);
    expect(await readdir(m.root)).toEqual(["Local", "Programs"]);
    expect(() => createCollectorStartupRefreshFromParts(parts(m, { compiledPayload: missing, isPackaged: true, createRegistry }))).toThrow(CollectorPayloadNotEmbeddedError);
    // the default (this unbuilt source tree) is not embedded either
    expect(() => createCollectorStartupRefreshFromParts({ ...parts(m, { isPackaged: true }), compiledPayload: undefined })).toThrow(CollectorPayloadNotEmbeddedError);
  });
});

describe("integration runtime (WP-7 slice A)", () => {
  it("is inert under E2E isolation: no registry, every operation rejects", async () => {
    const m = await machine();
    let constructed = 0;
    const runtime = createCollectorIntegrationRuntimeFromParts(parts(m, { e2eIsolationActive: true, createRegistry: () => { constructed += 1; return m.registry; } }));
    expect(runtime.mode).toBe("inert-e2e-isolation");
    await expect(runtime.inspect()).rejects.toThrow();
    await expect(runtime.apply({ action: "setup" })).rejects.toThrow();
    await expect(runtime.locateChrome()).rejects.toThrow();
    expect(constructed).toBe(0);
    expect(await readdir(m.root)).toEqual(["Local", "Programs"]);
  });

  it("is inert in a development build without an embedded payload", async () => {
    const m = await machine();
    let constructed = 0;
    const runtime = createCollectorIntegrationRuntimeFromParts(parts(m, { compiledPayload: { embedded: false, value: null }, createRegistry: () => { constructed += 1; return m.registry; } }));
    expect(runtime.mode).toBe("inert-no-payload");
    await expect(runtime.apply({ action: "setup" })).rejects.toThrow();
    expect(constructed).toBe(0);
  });

  it("an active runtime inspects read-only and hands the startup apply to the injected wrapper", async () => {
    const m = await machine();
    let wrapped = 0;
    const runtime = createCollectorIntegrationRuntimeFromParts(parts(m, {
      wrapApply: (apply) => { wrapped += 1; return apply; },
    }));
    expect(runtime.mode).toBe("active");
    expect(wrapped).toBe(1);
    const inspection = await runtime.inspect({ verifyFileHashes: false });
    expect(inspection.state).toBe("not-set-up");
    expect((await runtime.locateChrome()).status).toBeDefined();
    expect(await readdir(m.root)).toEqual(["Local", "Programs"]);
  });
});
