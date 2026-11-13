import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, writeFile, lstat, utimes } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyCollectorIntegration } from "./collector-integration-apply";
import { createNodeCollectorApplyFileSystem } from "./collector-integration-apply-fs";
import {
  HOST_SELF_CHECK_TIMEOUT_MS,
  createNodeHostSelfCheckRunner,
  encodeHealthFrame,
  parseHealthFrame,
  type HostSpawn,
} from "./collector-integration-apply-self-check";
import { CollectorFileSystemError, type CollectorApplyRequest, type CollectorIntegrationApplyDependencies } from "./collector-integration-apply-types";
import { parseCollectorPayloadDescriptor, COLLECTOR_PROTOCOL, COLLECTOR_HOST_ADDON_NAME, COLLECTOR_HOST_EXECUTABLE_NAME } from "./collector-payload";
import { FakeCollectorRegistryAdapter } from "./collector-registry-adapter.test-helper";
import { fakeSafeInspector } from "./collector-host-fixture.test-helper";
import { COLLECTOR_TEST_KEY, HOST_SOURCE_FILES, applyDescriptor, extensionSourceFiles } from "./collector-integration-apply.test-helper";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

interface RealFixture {
  readonly root: string;
  readonly registry: FakeCollectorRegistryAdapter;
  readonly hostSource: string;
  readonly extensionSource: string;
  readonly programFolder: string;
  readonly deps: CollectorIntegrationApplyDependencies;
  payload: unknown;
  suffix: number;
}

async function realFixture(): Promise<RealFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mgn-wp5b-")));
  roots.push(root);
  const localAppData = path.join(root, "Local");
  const userProgramFiles = path.join(localAppData, "Programs");
  const hostSource = path.join(root, "res", "collector-host");
  const extensionSource = path.join(root, "res", "collector-extension");
  await mkdir(userProgramFiles, { recursive: true });
  await mkdir(hostSource, { recursive: true });
  for (const [name, content] of Object.entries(HOST_SOURCE_FILES)) await writeFile(path.join(hostSource, name), content);
  for (const [name, content] of Object.entries(extensionSourceFiles())) {
    await mkdir(path.dirname(path.join(extensionSource, ...name.split("/"))), { recursive: true });
    await writeFile(path.join(extensionSource, ...name.split("/")), content);
  }
  const registry = new FakeCollectorRegistryAdapter();
  registry.knownFolders = { UserProgramFiles: userProgramFiles, LocalAppData: localAppData, ProgramFiles: path.join(root, "pf"), ProgramFilesX86: path.join(root, "pf86") };
  const fixture: RealFixture = {
    root,
    registry,
    hostSource,
    extensionSource,
    programFolder: path.join(userProgramFiles, "MAGINALIA Collector"),
    payload: applyDescriptor(),
    suffix: 0,
    get deps(): CollectorIntegrationApplyDependencies {
      return {
        registry,
        fileSystem: createNodeCollectorApplyFileSystem({ createPrivateDirectory: async (target) => { try { await mkdir(target); return "created"; } catch { return "exists"; } } }),
        inspectPathSecurity: fakeSafeInspector,
        readPayloadDescriptor: async () => fixture.payload,
        now: () => new Date(),
        e2eIsolationActive: false,
        payloadSource: { hostFolder: hostSource, extensionFolder: extensionSource },
        runHostSelfCheck: async () => ({ status: "ok", protocol: COLLECTOR_PROTOCOL }),
        randomSuffix: () => { fixture.suffix += 1; return fixture.suffix.toString(16).padStart(16, "0"); },
      };
    },
  };
  return fixture;
}

const apply = (fixture: RealFixture, request: CollectorApplyRequest) => applyCollectorIntegration(request, fixture.deps);

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

describe("product file-system adapter on a temp root", () => {
  const code = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
      return "none";
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CollectorFileSystemError);
      expect((error as Error).message).not.toMatch(/[A-Za-z]:\\|mgn-wp5b/u);
      return (error as CollectorFileSystemError).code;
    }
  };

  it("makes a directory non-recursively and reports exists", async () => {
    const f = await realFixture();
    const fs = f.deps.fileSystem;
    const target = path.join(f.root, "a");
    expect(await fs.makeDirectory(target)).toBe("created");
    expect(await fs.makeDirectory(target)).toBe("exists");
    expect(await code(() => fs.makeDirectory(path.join(f.root, "x", "y")))).toBe("missing");
    expect(await exists(path.join(f.root, "x"))).toBe(false);
  });

  it("writes exclusively and never overwrites", async () => {
    const f = await realFixture();
    const fs = f.deps.fileSystem;
    const target = path.join(f.root, "w.txt");
    await fs.writeFileExclusive(target, new TextEncoder().encode("one"));
    expect(await code(() => fs.writeFileExclusive(target, new TextEncoder().encode("two")))).toBe("exists");
    expect(await readFile(target, "utf8")).toBe("one");
  });

  it("copies exclusively and hashes the bytes it wrote", async () => {
    const f = await realFixture();
    const fs = f.deps.fileSystem;
    const destination = path.join(f.root, "copy.bin");
    const result = await fs.copyFileExclusive(path.join(f.hostSource, COLLECTOR_HOST_EXECUTABLE_NAME), destination);
    expect(result).toMatchObject({ sourceChanged: false, size: HOST_SOURCE_FILES[COLLECTOR_HOST_EXECUTABLE_NAME]?.length });
    expect(await fs.sha256File(destination)).toBe(result.sha256);
    expect(await code(() => fs.copyFileExclusive(path.join(f.hostSource, COLLECTOR_HOST_ADDON_NAME), destination))).toBe("exists");
    expect(await readFile(destination, "utf8")).toBe(HOST_SOURCE_FILES[COLLECTOR_HOST_EXECUTABLE_NAME]);
  });

  it("reports a missing copy source and refuses a symbolic-link or directory source", async () => {
    const f = await realFixture();
    const fs = f.deps.fileSystem;
    expect(await code(() => fs.copyFileExclusive(path.join(f.root, "nope"), path.join(f.root, "d1")))).toBe("missing");
    expect(await code(() => fs.copyFileExclusive(f.hostSource, path.join(f.root, "d2")))).toBe("failed");
    const link = path.join(f.root, "link.bin");
    try {
      await symlink(path.join(f.hostSource, COLLECTOR_HOST_ADDON_NAME), link, "file");
    } catch {
      return; // symbolic links need a privilege on some Windows setups; the junction tests cover links
    }
    expect(await code(() => fs.copyFileExclusive(link, path.join(f.root, "d3")))).toBe("failed");
    expect(await exists(path.join(f.root, "d3"))).toBe(false);
  });

  it("renames files with and without replacement, and directories never over an existing one", async () => {
    const f = await realFixture();
    const fs = f.deps.fileSystem;
    await writeFile(path.join(f.root, "a"), "a");
    await writeFile(path.join(f.root, "b"), "b");
    expect(await code(() => fs.renameFile(path.join(f.root, "a"), path.join(f.root, "b"), { replace: false }))).toBe("exists");
    await fs.renameFile(path.join(f.root, "a"), path.join(f.root, "b"), { replace: true });
    expect(await readFile(path.join(f.root, "b"), "utf8")).toBe("a");
    await mkdir(path.join(f.root, "d1"));
    await mkdir(path.join(f.root, "d2"));
    expect(await code(() => fs.renameDirectory(path.join(f.root, "d1"), path.join(f.root, "d2")))).toBe("exists");
    await fs.renameDirectory(path.join(f.root, "d1"), path.join(f.root, "d3"));
    expect(await exists(path.join(f.root, "d3"))).toBe(true);
    expect(await code(() => fs.renameFile(path.join(f.root, "d3"), path.join(f.root, "d4"), { replace: true }))).toBe("failed");
    expect(await code(() => fs.renameDirectory(path.join(f.root, "b"), path.join(f.root, "d5")))).toBe("failed");
  });

  it("removes one file or one empty directory only", async () => {
    const f = await realFixture();
    const fs = f.deps.fileSystem;
    await mkdir(path.join(f.root, "dir"));
    await writeFile(path.join(f.root, "dir", "f"), "x");
    expect(await code(() => fs.removeEmptyDirectory(path.join(f.root, "dir")))).toBe("not-empty");
    expect(await code(() => fs.removeFile(path.join(f.root, "dir")))).toBe("failed");
    expect(await fs.removeFile(path.join(f.root, "dir", "f"))).toBe("removed");
    expect(await fs.removeFile(path.join(f.root, "dir", "f"))).toBe("missing");
    expect(await fs.removeEmptyDirectory(path.join(f.root, "dir"))).toBe("removed");
    expect(await fs.removeEmptyDirectory(path.join(f.root, "dir"))).toBe("missing");
  });

  it("lists entries with their kind, size, mtime, and null for a missing directory", async () => {
    const f = await realFixture();
    const fs = f.deps.fileSystem;
    await mkdir(path.join(f.root, "l"));
    await writeFile(path.join(f.root, "l", "f.txt"), "abc");
    await mkdir(path.join(f.root, "l", "sub"));
    const entries = [...(await fs.listDirectory(path.join(f.root, "l")) ?? [])].sort((x, y) => x.name.localeCompare(y.name));
    expect(entries.map((entry) => [entry.name, entry.kind, entry.isReparsePoint])).toEqual([["f.txt", "file", false], ["sub", "directory", false]]);
    expect(entries[0]?.size).toBe(3);
    expect(entries[0]?.mtimeMs).toBeGreaterThan(0);
    expect(await fs.listDirectory(path.join(f.root, "none"))).toBeNull();
  });

  it("delegates the private directory creation to the injected helper", async () => {
    const calls: string[] = [];
    const fs = createNodeCollectorApplyFileSystem({ createPrivateDirectory: (target) => { calls.push(target); return "created"; } });
    expect(await fs.createPrivateDirectory("C:\\x")).toBe("created");
    expect(calls).toEqual(["C:\\x"]);
  });

  it("translates a failing private-directory helper to a path-free error", async () => {
    const fs = createNodeCollectorApplyFileSystem({ createPrivateDirectory: () => { throw new Error("C:\\secret exploded"); } });
    expect(await code(() => fs.createPrivateDirectory("C:\\x"))).toBe("failed");
  });
});

describe("end to end on a temp root (real files, fake registry)", () => {
  it("setup, no-op, tamper, repair, refresh, remove", async () => {
    const f = await realFixture();
    const setup = await apply(f, { action: "setup" });
    expect(setup).toMatchObject({ outcome: "applied", state: "ready" });
    expect(await readFile(path.join(f.programFolder, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME), "utf8")).toBe("host-executable-bytes");
    expect(await readFile(path.join(f.programFolder, "extension", "pages", "onboarding.html"), "utf8")).toBe("<html></html>");
    expect(JSON.parse(await readFile(path.join(f.programFolder, "org.maginalia.collector.json"), "utf8"))).toMatchObject({ name: "org.maginalia.collector", path: "host-a\\MAGINALIA-Collector-Host.exe" });
    expect((await apply(f, { action: "setup" })).outcome).toBe("noop");

    await writeFile(path.join(f.programFolder, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME), "tampered");
    expect((await apply(f, { action: "repair" })).state).toBe("ready");
    expect(await readFile(path.join(f.programFolder, "host-b", COLLECTOR_HOST_EXECUTABLE_NAME), "utf8")).toBe("host-executable-bytes");
    expect(await exists(path.join(f.programFolder, "host-a"))).toBe(false);

    await writeFile(path.join(f.hostSource, COLLECTOR_HOST_EXECUTABLE_NAME), "host-executable-bytes-v2");
    f.payload = applyDescriptor({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0", host: { ...HOST_SOURCE_FILES, [COLLECTOR_HOST_EXECUTABLE_NAME]: "host-executable-bytes-v2" } });
    const refreshed = await apply(f, { action: "refresh" });
    expect(refreshed).toMatchObject({ outcome: "applied", state: "ready" });
    expect(await exists(path.join(f.programFolder, "host-b"))).toBe(false);
    expect(await readFile(path.join(f.programFolder, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME), "utf8")).toBe("host-executable-bytes-v2");

    const removed = await apply(f, { action: "remove" });
    expect(removed).toMatchObject({ outcome: "applied", state: "not-set-up" });
    expect(await exists(f.programFolder)).toBe(false);
    expect(await exists(path.join(f.root, "Local", "Programs"))).toBe(true);
  });

  it("creates the integration folder and removes only old contact temp files", async () => {
    const f = await realFixture();
    const integration = path.join(f.root, "Local", "MAGINALIA", "integration");
    await mkdir(integration, { recursive: true });
    const old = path.join(integration, ".collector-contact.json.abc.tmp");
    const young = path.join(integration, ".collector-contact.json.def.tmp");
    await writeFile(old, "x");
    await writeFile(young, "x");
    const past = new Date(Date.now() - 20 * 60_000);
    await utimes(old, past, past);
    await apply(f, { action: "setup" });
    expect(await exists(old)).toBe(false);
    expect(await exists(young)).toBe(true);
  });

  it("the setup creates the integration folder on a machine that has none", async () => {
    const f = await realFixture();
    await apply(f, { action: "setup" });
    expect((await lstat(path.join(f.root, "Local", "MAGINALIA", "integration"))).isDirectory()).toBe(true);
  });

  it("a real junction inside the extension folder survives remove with its target intact (canary)", async () => {
    const f = await realFixture();
    await apply(f, { action: "setup" });
    const canaryDirectory = path.join(f.root, "canary");
    await mkdir(canaryDirectory);
    await writeFile(path.join(canaryDirectory, "sentinel.txt"), "do not delete");
    const link = path.join(f.programFolder, "extension", "linked");
    await symlink(canaryDirectory, link, "junction");
    const result = await apply(f, { action: "remove" });
    expect(result.outcome).toBe("partial");
    expect(result.warnings).toContain("leftovers-remain");
    expect(await readFile(path.join(canaryDirectory, "sentinel.txt"), "utf8")).toBe("do not delete");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    // everything else of ours is gone, the state file stays for the retry
    expect(await exists(path.join(f.programFolder, "host-a"))).toBe(false);
    expect(await exists(path.join(f.programFolder, "org.maginalia.collector.json"))).toBe(false);
    expect(await exists(path.join(f.programFolder, "integration-state.json"))).toBe(true);
    await rmdir(link);
    expect((await apply(f, { action: "remove" })).outcome).toBe("applied");
    expect(await readFile(path.join(canaryDirectory, "sentinel.txt"), "utf8")).toBe("do not delete");
  });

  it("a real junction as the extension folder itself is never entered or replaced", async () => {
    const f = await realFixture();
    await apply(f, { action: "setup" });
    const canaryDirectory = path.join(f.root, "canary2");
    await mkdir(canaryDirectory);
    await writeFile(path.join(canaryDirectory, "sentinel.txt"), "do not delete");
    await rm(path.join(f.programFolder, "extension"), { recursive: true });
    await symlink(canaryDirectory, path.join(f.programFolder, "extension"), "junction");
    const repair = await apply(f, { action: "repair" });
    expect(repair.outcome).toBe("refused");
    expect((await apply(f, { action: "remove" })).outcome).toBe("partial");
    expect(await readdir(canaryDirectory)).toEqual(["sentinel.txt"]);
  });

  it("a real junction as host-a is never deleted through", async () => {
    const f = await realFixture();
    await apply(f, { action: "setup" });
    const canaryDirectory = path.join(f.root, "canary3");
    await mkdir(canaryDirectory);
    await writeFile(path.join(canaryDirectory, "sentinel.txt"), "do not delete");
    await rm(path.join(f.programFolder, "host-a"), { recursive: true });
    await symlink(canaryDirectory, path.join(f.programFolder, "host-a"), "junction");
    await apply(f, { action: "remove" });
    expect(await readdir(canaryDirectory)).toEqual(["sentinel.txt"]);
  });

  it("sentinels next to the program folder are never touched by remove", async () => {
    const f = await realFixture();
    await apply(f, { action: "setup" });
    const sentinel = path.join(f.root, "Local", "Programs", "Other App", "app.exe");
    await mkdir(path.dirname(sentinel));
    await writeFile(sentinel, "other");
    const binding = path.join(f.root, "Local", "MAGINALIA", "integration", "private-shelf-binding.json");
    await writeFile(binding, "{}");
    await apply(f, { action: "remove" });
    expect(await readFile(sentinel, "utf8")).toBe("other");
    expect(await readFile(binding, "utf8")).toBe("{}");
  });
});

// ----- Host self-check runner -----------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: () => boolean;
  killed: boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

const frame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
};

function runnerWith(child: FakeChild, spawned: Array<{ executable: string; args: readonly string[] }> = [], timeoutMs?: number) {
  const spawn: HostSpawn = (executable, args) => {
    spawned.push({ executable, args });
    return child as never;
  };
  return createNodeHostSelfCheckRunner({ spawn, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

const request = { executablePath: "C:\\host\\MAGINALIA-Collector-Host.exe", allowedOrigin: "chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/" };

describe("Host self-check runner", () => {
  it("has the 10 second timeout of the design", () => {
    expect(HOST_SELF_CHECK_TIMEOUT_MS).toBe(10_000);
  });

  it("encodes one length-prefixed health request", () => {
    const encoded = encodeHealthFrame();
    expect(encoded.readUInt32LE(0)).toBe(encoded.length - 4);
    expect(JSON.parse(encoded.subarray(4).toString("utf8"))).toEqual({ protocol: COLLECTOR_PROTOCOL, operation: "health" });
  });

  it("spawns the executable with the allowed origin as the only argument and sends health", async () => {
    const child = fakeChild();
    const spawned: Array<{ executable: string; args: readonly string[] }> = [];
    const seen: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => seen.push(chunk));
    const promise = runnerWith(child, spawned)(request);
    child.stdout.write(frame({ protocol: COLLECTOR_PROTOCOL, ok: true, experimental: true, operations: ["health"], writesEnabled: false }));
    expect(await promise).toEqual({ status: "ok", protocol: COLLECTOR_PROTOCOL });
    expect(spawned).toEqual([{ executable: request.executablePath, args: [request.allowedOrigin] }]);
    expect(Buffer.concat(seen).equals(encodeHealthFrame())).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("passes a host version through when the answer carries one", async () => {
    const child = fakeChild();
    const promise = runnerWith(child)(request);
    child.stdout.write(frame({ protocol: COLLECTOR_PROTOCOL, ok: true, host: { version: "1.2.0" } }));
    expect(await promise).toEqual({ status: "ok", protocol: COLLECTOR_PROTOCOL, hostVersion: "1.2.0" });
  });

  it("assembles an answer that arrives in pieces", async () => {
    const child = fakeChild();
    const promise = runnerWith(child)(request);
    const whole = frame({ protocol: COLLECTOR_PROTOCOL, ok: true });
    child.stdout.write(whole.subarray(0, 2));
    child.stdout.write(whole.subarray(2, 9));
    child.stdout.write(whole.subarray(9));
    expect((await promise).status).toBe("ok");
  });

  it.each([
    ["ok:false", frame({ protocol: COLLECTOR_PROTOCOL, ok: false })],
    ["no protocol", frame({ ok: true })],
    ["not an object", frame([1])],
    ["invalid JSON", Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("{x}")])],
    ["zero length", Buffer.from([0, 0, 0, 0])],
    ["oversized length", Buffer.from([0xff, 0xff, 0xff, 0x7f, 1])],
  ])("fails on a bad answer (%s)", async (_label, bytes) => {
    const child = fakeChild();
    const promise = runnerWith(child)(request);
    child.stdout.write(bytes);
    expect(await promise).toEqual({ status: "failed" });
  });

  it("fails when the process exits before answering", async () => {
    const child = fakeChild();
    const promise = runnerWith(child)(request);
    child.emit("close", 1);
    expect(await promise).toEqual({ status: "failed" });
  });

  it("fails when the process cannot be started (error event)", async () => {
    const child = fakeChild();
    const promise = runnerWith(child)(request);
    child.emit("error", new Error("C:\\secret"));
    expect(await promise).toEqual({ status: "failed" });
  });

  it("fails when spawn throws", async () => {
    const runner = createNodeHostSelfCheckRunner({ spawn: () => { throw new Error("blocked"); } });
    expect(await runner(request)).toEqual({ status: "failed" });
  });

  it("fails and kills the child on timeout", async () => {
    const child = fakeChild();
    const result = await runnerWith(child, [], 20)(request);
    expect(result).toEqual({ status: "failed" });
    expect(child.killed).toBe(true);
  });

  it("settles once: a late answer after the timeout changes nothing", async () => {
    const child = fakeChild();
    const promise = runnerWith(child, [], 10)(request);
    expect(await promise).toEqual({ status: "failed" });
    child.stdout.write(frame({ protocol: COLLECTOR_PROTOCOL, ok: true }));
  });

  it("parseHealthFrame reports an incomplete frame as undefined", () => {
    expect(parseHealthFrame(Buffer.from([1, 0]))).toBeUndefined();
    expect(parseHealthFrame(Buffer.from([9, 0, 0, 0, 1]))).toBeUndefined();
  });
});

// ----- Descriptor consistency (WP-4 <-> WP-5a) --------------------------------------------------

describe("descriptor validators agree", () => {
  it("the example descriptor validates with the TypeScript validator and the build-script validator", async () => {
    const example = JSON.parse(readFileSync(path.join(desktopRoot, "packaging", "collector-payload.example.json"), "utf8")) as unknown;
    expect(parseCollectorPayloadDescriptor(example)).toMatchObject({ ok: true });
    const script = await import(pathToFileURL(path.join(desktopRoot, "scripts", "collector-payload.mjs")).href) as { validateDescriptor: (value: unknown) => unknown };
    expect(() => script.validateDescriptor(example)).not.toThrow();
  });

  it("both reject the same broken variants", async () => {
    const script = await import(pathToFileURL(path.join(desktopRoot, "scripts", "collector-payload.mjs")).href) as { validateDescriptor: (value: unknown) => unknown };
    const example = JSON.parse(readFileSync(path.join(desktopRoot, "packaging", "collector-payload.example.json"), "utf8")) as Record<string, unknown>;
    const broken: unknown[] = [
      { ...example, version: 2 },
      { ...example, extra: true },
      { ...example, protocol: "other" },
      { ...example, payloadId: "x" },
      { ...example, host: { ...(example.host as object), files: { "MAGINALIA-Collector-Host.exe": "zz" } } },
    ];
    for (const value of broken) {
      expect(parseCollectorPayloadDescriptor(value).ok).toBe(false);
      expect(() => script.validateDescriptor(value)).toThrow();
    }
  });

  it("the test descriptor builder produces a descriptor the validator accepts", () => {
    expect(parseCollectorPayloadDescriptor(applyDescriptor())).toMatchObject({ ok: true });
    expect(COLLECTOR_TEST_KEY.length).toBeGreaterThan(300);
  });
});

// ----- Source scan ------------------------------------------------------------------------------

describe("source scan (WP-5b)", () => {
  const read = (name: string): string => readFileSync(path.join(here, name), "utf8");
  /** Code without comments, so prose may say "spawns nothing". */
  const code = (name: string): string => read(name).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  const forbiddenAccess = [/process\s*\.\s*env\b/u, /process\s*\.\s*cwd\b/u, /process\s*\.\s*argv\b/u, /\bapp\s*\.\s*getPath\b/u, /\bprocess\s*\[\s*["']env["']\s*\]/u, /\bprocess\s*\.\s*resourcesPath\b/u];
  const files = ["collector-integration-apply.ts", "collector-integration-apply-types.ts", "collector-integration-apply-fs.ts", "collector-integration-apply-self-check.ts"];

  it.each(files)("%s reads no environment, cwd, argv or Electron path", (file) => {
    const source = read(file);
    for (const pattern of forbiddenAccess) expect(source).not.toMatch(pattern);
  });

  it.each(["collector-integration-apply.ts", "collector-integration-apply-types.ts"])("%s imports no file-system, process or Electron API", (file) => {
    const source = code(file);
    const modules = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1] as string);
    expect(modules.filter((specifier) => specifier.startsWith("node:") && specifier !== "node:crypto" && specifier !== "node:path")).toEqual([]);
    expect(source).not.toMatch(/\belectron\b/u);
    expect(source).not.toMatch(/\bshell\s*\./u);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexecSync\b|\bexecFile\b|\bchild_process\b/u);
  });

  it("the apply module never recurses outside its own named folders", () => {
    const source = read("collector-integration-apply.ts");
    expect(source).not.toMatch(/recursive\s*:\s*true/u);
    expect(source).not.toMatch(/\brmSync\b|\brm\s*\(|\brimraf\b/u);
  });

  it("the file-system adapter imports only the bounded primitives and no recursive or permission API", () => {
    const source = read("collector-integration-apply-fs.ts");
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(node:[^"]+)"/gu)].map((match) => `${match[2]}:${(match[1] as string).split(",").map((name) => name.trim()).filter((name) => !name.startsWith("type ")).sort().join(",")}`);
    expect(imports).toContain("node:fs/promises:lstat,mkdir,open,readdir,rename,rmdir,unlink");
    expect(source).not.toMatch(/recursive\s*:\s*true/u);
    expect(source).not.toMatch(/\bchmod\b|\bchown\b|\bsymlink\b|\blink\s*\(|\bcopyFile\b|\brm\s*\(|\brmSync\b|\bcp\s*\(/u);
  });

  it("the self-check runner uses only child_process.spawn without a shell", () => {
    const source = read("collector-integration-apply-self-check.ts");
    expect(source).toMatch(/shell:\s*false/u);
    expect(source).not.toMatch(/\bexec\(|\bexecSync\b|\bexecFile\b|shell:\s*true/u);
  });

  it("nothing in the apply files prints or throws a path-bearing message", () => {
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/console\.(?:log|error|warn|info)/u);
      expect(source).not.toMatch(/new Error\(`[^`]*\$\{/u);
    }
  });

  it("the inspection module still contains no write (WP-5a invariant)", () => {
    const source = read("collector-integration.ts");
    expect(source).not.toMatch(/registerCollectorHost|unregisterCollectorHost|replaceForeignCollectorHostRegistration/u);
  });
});
