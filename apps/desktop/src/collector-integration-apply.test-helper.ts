/**
 * Fakes for the Collector integration apply tests (WP-5b): an in-memory write-capable file
 * system with fault injection, a fixture that builds a packaged payload source and the full
 * dependency set. Nothing here touches a real path, registry, process or environment.
 */
import * as path from "node:path";
import {
  COLLECTOR_EXTENSION_ID,
  COLLECTOR_HOST_ADDON_NAME,
  COLLECTOR_HOST_EXECUTABLE_NAME,
  COLLECTOR_PROTOCOL,
} from "./collector-payload.js";
import {
  CollectorFileSystemError,
  type CollectorApplyFileSystem,
  type CollectorCopyResult,
  type CollectorDirectoryEntry,
  type CollectorIntegrationApplyDependencies,
  type HostSelfCheckRequest,
  type HostSelfCheckResult,
} from "./collector-integration-apply-types.js";
import { FakeCollectorRegistryAdapter } from "./collector-registry-adapter.test-helper.js";
import { FakeCollectorFileSystem, FIXTURE_NOW, fakeKey, sha256 } from "./collector-integration.test-helper.js";
import { safeFacts } from "./collector-host-fixture.test-helper.js";
import type { PathSecurityFacts } from "./collector-path-security.js";

/** The real Collector 0.3.0 public key: its derived extension ID is the compiled constant. */
export const COLLECTOR_TEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyp0ZIrFbABW+I8H80k14vICG1gWIgUUlVxxfQ7trxjGvg728zPYQ7o1ZE01uwGzaKGRn3J5cyNwlcjrYJHENHRdDwD7H3opT4rUMXdUJVSsQB4FSjsq0KBNyxv4QuTjeEY7tuEmUKfAdcKD7H8poGmcTdpPcZR+ycmcAHnThsj3EcLKxreKeYXRPI3Is1TeJhsU5aFH8SElFO8bt/+ggPEDvk5SDpPUJa+3tW2Jz0MZyoBph5jf4G8EXQ/ZHD2hcrxqjhVQ2pLqovBRsC9b2vhuS42cxTCspSDdFvwwN+wnEyfUlHXXCwRUCsQR+JpIiT7X6LvgAku/iN2Lo7fkqbQIDAQAB";

export type FakeMutation = "mkdir" | "mkdir-private" | "write" | "copy" | "rename-file" | "rename-dir" | "remove-file" | "remove-dir";

const parentKey = (target: string): string => fakeKey(path.win32.dirname(target));

export class FakeApplyFileSystem extends FakeCollectorFileSystem implements CollectorApplyFileSystem {
  /** Every mutation, in order: `<op> <lower-case path>`. */
  public readonly mutations: string[] = [];
  /** The Nth mutation (1-based) throws before running; one shot. */
  public failAt: number | null = null;
  /** After the Nth mutation ran, every later mutation throws (the process "died"). */
  public crashAfter: number | null = null;
  /** Mutations touching these paths (the path itself or anything below) throw `locked`. */
  public readonly locked = new Set<string>();
  /** Called after a copy read the source: tests change the source here. Returns `true` to report it changed. */
  public onCopy: ((source: string, destination: string) => boolean | void) | undefined;
  /** Called after a copy was written: tests corrupt the destination here. */
  public afterCopy: ((destination: string) => void) | undefined;
  public readonly privateDirectories: string[] = [];

  private count = 0;
  /** Original-case base names (the base class keys nodes by lower-cased path). */
  private readonly names = new Map<string, string>();

  public override addDirectory(target: string, options: { readonly reparse?: boolean } = {}): void {
    super.addDirectory(target, options);
    this.names.set(fakeKey(target), path.win32.basename(target));
  }

  public override addFile(target: string, content: string | Uint8Array, options: { readonly reparse?: boolean; readonly kind?: "file" | "other" } = {}): void {
    super.addFile(target, content, options);
    this.names.set(fakeKey(target), path.win32.basename(target));
  }

  public get mutationCount(): number {
    return this.count;
  }

  private begin(op: FakeMutation, targets: readonly string[], locking: readonly string[] = targets): void {
    this.count += 1;
    if (this.crashAfter !== null && this.count > this.crashAfter) throw new CollectorFileSystemError("failed");
    if (this.failAt === this.count) {
      this.failAt = null;
      throw new CollectorFileSystemError("failed");
    }
    for (const target of locking) {
      const probe = fakeKey(target);
      for (const lock of this.locked) {
        if (probe === lock || probe.startsWith(`${lock}\\`)) throw new CollectorFileSystemError("locked");
      }
    }
    this.mutations.push(`${op} ${targets.map(fakeKey).join(" -> ")}`);
  }

  public lock(target: string): void {
    this.locked.add(fakeKey(target));
  }

  public node(target: string) {
    return this.nodes.get(fakeKey(target));
  }

  public bytes(target: string): Uint8Array {
    const node = this.nodes.get(fakeKey(target));
    if (node === undefined) throw new Error("fixture: unknown path");
    return node.content;
  }

  public setBytes(target: string, content: string | Uint8Array): void {
    const node = this.nodes.get(fakeKey(target));
    if (node === undefined) throw new Error("fixture: unknown path");
    node.content = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }

  public touch(target: string, mtimeMs: number): void {
    const node = this.nodes.get(fakeKey(target));
    if (node === undefined) throw new Error("fixture: unknown path");
    node.mtimeMs = mtimeMs;
  }

  /** Lower-case path -> kind/hash, for "nothing outside the program folder changed" assertions. */
  public snapshot(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [key, node] of this.nodes) result.set(key, `${node.kind}:${node.reparse}:${node.kind === "file" ? sha256(node.content) : ""}`);
    return result;
  }

  public async listDirectory(target: string): Promise<readonly CollectorDirectoryEntry[] | null> {
    this.enterPublic(target);
    const directory = this.nodes.get(fakeKey(target));
    if (directory === undefined) return null;
    if (directory.kind !== "directory") throw new CollectorFileSystemError("failed");
    const prefix = `${fakeKey(target)}\\`;
    const entries: CollectorDirectoryEntry[] = [];
    for (const [key, node] of this.nodes) {
      if (!key.startsWith(prefix) || key.slice(prefix.length).includes("\\")) continue;
      entries.push({ name: this.names.get(key) ?? key.slice(prefix.length), kind: node.kind, isReparsePoint: node.reparse, size: node.content.byteLength, mtimeMs: node.mtimeMs ?? FIXTURE_NOW.getTime() });
    }
    return entries;
  }

  private enterPublic(target: string): void {
    if (this.failing.has(fakeKey(target))) throw new CollectorFileSystemError("failed");
  }

  private requireParent(target: string): void {
    const parent = this.nodes.get(parentKey(target));
    if (parent === undefined || parent.kind !== "directory") throw new CollectorFileSystemError("missing");
  }

  public async makeDirectory(target: string): Promise<"created" | "exists"> {
    this.begin("mkdir", [target], []);
    if (this.nodes.has(fakeKey(target))) return "exists";
    this.requireParent(target);
    this.nodes.set(fakeKey(target), { kind: "directory", reparse: false, content: new Uint8Array() });
    this.names.set(fakeKey(target), path.win32.basename(target));
    return "created";
  }

  public async createPrivateDirectory(target: string): Promise<"created" | "exists"> {
    this.begin("mkdir-private", [target], []);
    if (this.nodes.has(fakeKey(target))) return "exists";
    this.requireParent(target);
    this.nodes.set(fakeKey(target), { kind: "directory", reparse: false, content: new Uint8Array() });
    this.names.set(fakeKey(target), path.win32.basename(target));
    this.privateDirectories.push(fakeKey(target));
    return "created";
  }

  public async writeFileExclusive(target: string, bytes: Uint8Array): Promise<void> {
    this.begin("write", [target], []);
    this.requireParent(target);
    if (this.nodes.has(fakeKey(target))) throw new CollectorFileSystemError("exists");
    this.nodes.set(fakeKey(target), { kind: "file", reparse: false, content: new Uint8Array(bytes) });
    this.names.set(fakeKey(target), path.win32.basename(target));
  }

  public async copyFileExclusive(source: string, destination: string): Promise<CollectorCopyResult> {
    this.begin("copy", [destination], []);
    const origin = this.nodes.get(fakeKey(source));
    if (origin === undefined) throw new CollectorFileSystemError("missing");
    if (origin.kind !== "file" || origin.reparse) throw new CollectorFileSystemError("failed");
    this.requireParent(destination);
    if (this.nodes.has(fakeKey(destination))) throw new CollectorFileSystemError("exists");
    const content = new Uint8Array(origin.content);
    const changed = this.onCopy?.(source, destination) === true;
    this.nodes.set(fakeKey(destination), { kind: "file", reparse: false, content });
    this.names.set(fakeKey(destination), path.win32.basename(destination));
    const written = sha256(content);
    this.afterCopy?.(destination);
    return { sha256: written, size: content.byteLength, sourceChanged: changed };
  }

  public async renameFile(from: string, to: string, options: { readonly replace: boolean }): Promise<void> {
    this.begin("rename-file", [from, to], [from, ...(this.nodes.has(fakeKey(to)) && options.replace ? [to] : [])]);
    const node = this.nodes.get(fakeKey(from));
    if (node === undefined) throw new CollectorFileSystemError("missing");
    if (node.kind !== "file" || node.reparse) throw new CollectorFileSystemError("failed");
    const existing = this.nodes.get(fakeKey(to));
    if (existing !== undefined && (!options.replace || existing.kind !== "file")) throw new CollectorFileSystemError("exists");
    this.nodes.delete(fakeKey(from));
    this.nodes.set(fakeKey(to), node);
    this.names.set(fakeKey(to), path.win32.basename(to));
    this.names.delete(fakeKey(from));
  }

  public async renameDirectory(from: string, to: string): Promise<void> {
    this.begin("rename-dir", [from, to], [from]);
    const node = this.nodes.get(fakeKey(from));
    if (node === undefined) throw new CollectorFileSystemError("missing");
    if (node.kind !== "directory" || node.reparse) throw new CollectorFileSystemError("failed");
    if (this.nodes.has(fakeKey(to))) throw new CollectorFileSystemError("exists");
    const fromKey = fakeKey(from);
    const toKey = fakeKey(to);
    const moved: Array<[string, typeof node]> = [];
    for (const [key, value] of this.nodes) {
      if (key === fromKey || key.startsWith(`${fromKey}\\`)) moved.push([key, value]);
    }
    for (const [key] of moved) this.nodes.delete(key);
    for (const [key, value] of moved) {
      const target = toKey + key.slice(fromKey.length);
      this.nodes.set(target, value);
      this.names.set(target, key === fromKey ? path.win32.basename(to) : (this.names.get(key) ?? target.slice(target.lastIndexOf("\\") + 1)));
      this.names.delete(key);
    }
  }

  public async removeFile(target: string): Promise<"removed" | "missing"> {
    this.begin("remove-file", [target]);
    const node = this.nodes.get(fakeKey(target));
    if (node === undefined) return "missing";
    if (node.kind !== "file" || node.reparse) throw new CollectorFileSystemError("failed");
    this.nodes.delete(fakeKey(target));
    this.names.delete(fakeKey(target));
    return "removed";
  }

  public async removeEmptyDirectory(target: string): Promise<"removed" | "missing"> {
    this.begin("remove-dir", [target]);
    const node = this.nodes.get(fakeKey(target));
    if (node === undefined) return "missing";
    if (node.kind !== "directory" || node.reparse) throw new CollectorFileSystemError("failed");
    const prefix = `${fakeKey(target)}\\`;
    for (const key of this.nodes.keys()) if (key.startsWith(prefix)) throw new CollectorFileSystemError("not-empty");
    this.nodes.delete(fakeKey(target));
    this.names.delete(fakeKey(target));
    return "removed";
  }
}

export const SOURCE_HOST_FOLDER = "C:\\res\\collector-host";
export const SOURCE_EXTENSION_FOLDER = "C:\\res\\collector-extension";
export const HOST_SOURCE_FILES: Readonly<Record<string, string>> = {
  [COLLECTOR_HOST_EXECUTABLE_NAME]: "host-executable-bytes",
  [COLLECTOR_HOST_ADDON_NAME]: "host-addon-bytes",
  "LICENSE.txt": "license",
  "NOTICE.txt": "notice",
  "NODE-LICENSE.txt": "node license",
};

export function extensionSourceFiles(version = "0.3.0"): Record<string, string> {
  return {
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "MAGINALIA Collector", version, key: COLLECTOR_TEST_KEY }),
    "service-worker.js": "console.log('worker');",
    "pages/onboarding.html": "<html></html>",
  };
}

export function applyDescriptor(options: { readonly payloadId?: string; readonly hostVersion?: string; readonly extensionVersion?: string; readonly host?: Record<string, string>; readonly extension?: Record<string, string> } = {}): Record<string, unknown> {
  const host = options.host ?? HOST_SOURCE_FILES;
  const extension = options.extension ?? extensionSourceFiles(options.extensionVersion);
  return {
    version: 1,
    payloadId: options.payloadId ?? "1.2.0+abc1234",
    host: {
      version: options.hostVersion ?? "1.2.0",
      files: {
        [COLLECTOR_HOST_EXECUTABLE_NAME]: sha256(host[COLLECTOR_HOST_EXECUTABLE_NAME] as string),
        [COLLECTOR_HOST_ADDON_NAME]: sha256(host[COLLECTOR_HOST_ADDON_NAME] as string),
      },
    },
    extension: {
      version: options.extensionVersion ?? "0.3.0",
      id: COLLECTOR_EXTENSION_ID,
      zipSha256: sha256("zip"),
      files: Object.fromEntries(Object.entries(extension).map(([name, content]) => [name, sha256(content)])),
    },
    protocol: COLLECTOR_PROTOCOL,
  };
}

export interface ApplyFixture {
  readonly registry: FakeCollectorRegistryAdapter;
  readonly fileSystem: FakeApplyFileSystem;
  readonly securityFacts: Map<string, PathSecurityFacts | "throw">;
  readonly securityCalls: string[];
  readonly selfChecks: HostSelfCheckRequest[];
  readonly programFolder: string;
  readonly userProgramFiles: string;
  readonly integrationDirectory: string;
  readonly applicationRoot: string;
  payload: unknown;
  now: Date;
  isolated: boolean;
  selfCheckResult: HostSelfCheckResult | "throw";
  suffixCounter: number;
  deps: CollectorIntegrationApplyDependencies;
}

/**
 * A machine where the program folder does not exist yet, the packaged payload sits in
 * `C:\res`, and the user directories (`LocalAppData`, `Programs`) exist with safe ACLs.
 */
export function createApplyFixture(options: { readonly programsExists?: boolean } = {}): ApplyFixture {
  const registry = new FakeCollectorRegistryAdapter();
  const fileSystem = new FakeApplyFileSystem();
  const userProgramFiles = registry.knownFolders.UserProgramFiles;
  const programFolder = path.win32.join(userProgramFiles, "MAGINALIA Collector");
  const applicationRoot = path.win32.join(registry.knownFolders.LocalAppData, "MAGINALIA");
  const integrationDirectory = path.win32.join(applicationRoot, "integration");
  const securityFacts = new Map<string, PathSecurityFacts | "throw">();
  const securityCalls: string[] = [];
  const selfChecks: HostSelfCheckRequest[] = [];
  fileSystem.addDirectory(registry.knownFolders.LocalAppData);
  if (options.programsExists !== false) fileSystem.addDirectory(userProgramFiles);
  for (const [name, content] of Object.entries(HOST_SOURCE_FILES)) fileSystem.addFile(path.win32.join(SOURCE_HOST_FOLDER, name), content);
  for (const [name, content] of Object.entries(extensionSourceFiles())) fileSystem.addFile(path.win32.join(SOURCE_EXTENSION_FOLDER, ...name.split("/")), content);
  const fixture: ApplyFixture = {
    registry,
    fileSystem,
    securityFacts,
    securityCalls,
    selfChecks,
    programFolder,
    userProgramFiles,
    integrationDirectory,
    applicationRoot,
    payload: applyDescriptor(),
    now: FIXTURE_NOW,
    isolated: false,
    selfCheckResult: { status: "ok", protocol: COLLECTOR_PROTOCOL },
    suffixCounter: 0,
    get deps(): CollectorIntegrationApplyDependencies {
      return {
        registry,
        fileSystem,
        inspectPathSecurity: (target: string) => {
          securityCalls.push(target);
          const configured = securityFacts.get(fakeKey(target));
          if (configured === "throw") throw new Error("injected security inspection failure");
          if (configured !== undefined) return configured;
          return fileSystem.has(target) ? safeFacts(true) : { exists: false };
        },
        readPayloadDescriptor: async () => fixture.payload,
        now: () => fixture.now,
        e2eIsolationActive: fixture.isolated,
        payloadSource: { hostFolder: SOURCE_HOST_FOLDER, extensionFolder: SOURCE_EXTENSION_FOLDER },
        runHostSelfCheck: async (request) => {
          selfChecks.push(request);
          if (fixture.selfCheckResult === "throw") throw new Error("injected self-check failure");
          return fixture.selfCheckResult;
        },
        randomSuffix: () => {
          fixture.suffixCounter += 1;
          return fixture.suffixCounter.toString(16).padStart(16, "0");
        },
      };
    },
  };
  return fixture;
}
