import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeFacts } from "./collector-host-fixture.test-helper.js";
import { stateFileText } from "./collector-integration.test-helper.js";
import { FakeCollectorRegistryAdapter } from "./collector-registry-adapter.test-helper.js";
import { createCollectorStartupRefreshFromParts } from "./collector-startup-refresh-composition.js";

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
  readPayloadDescriptor: async () => { throw new Error("no descriptor"); },
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

  it("writes and shows nothing for a machine without the integration state", async () => {
    const m = await machine();
    const startup = createCollectorStartupRefreshFromParts(parts(m));
    const result = await startup.runStartup();
    expect(result.outcome).toBe("not-opted-in");
    expect(result.notices).toEqual([]);
    expect(await readdir(m.root)).toEqual(["Local", "Programs"]);
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

  it("shows the alpha1 notice once for a standalone Host folder", async () => {
    const m = await machine();
    await mkdir(path.join(m.registry.knownFolders.UserProgramFiles, "MAGINALIA Collector Host"), { recursive: true });
    const first = await createCollectorStartupRefreshFromParts(parts(m)).runStartup();
    expect(first.notices.map((notice) => notice.kind)).toEqual(["alpha1-migration"]);
    const second = await createCollectorStartupRefreshFromParts(parts(m)).runStartup();
    expect(second.notices).toEqual([]);
  });
});
