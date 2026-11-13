/**
 * Fakes and a "ready installation" fixture for the Collector integration inspection tests.
 *
 * `FakeCollectorFileSystem` is an in-memory Windows-path tree. It implements only the
 * read-only `CollectorIntegrationFileSystem` interface and records every call, so tests can
 * assert that nothing but reads happened. Nothing here touches a real path, registry or env.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type {
  CollectorFileEntry,
  CollectorFileRead,
  CollectorIntegrationFileSystem,
} from "./collector-integration-types.js";
import type { CollectorIntegrationInspectDependencies } from "./collector-integration.js";
import {
  COLLECTOR_ALLOWED_ORIGINS,
  COLLECTOR_EXTENSION_ID,
  COLLECTOR_HOST_ADDON_NAME,
  COLLECTOR_HOST_EXECUTABLE_NAME,
  COLLECTOR_PROTOCOL,
} from "./collector-payload.js";
import { FakeCollectorRegistryAdapter } from "./collector-registry-adapter.test-helper.js";
import { safeFacts } from "./collector-host-fixture.test-helper.js";
import type { PathSecurityFacts } from "./collector-path-security.js";

export const sha256 = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

interface FakeNode {
  kind: "file" | "directory" | "other";
  reparse: boolean;
  content: Uint8Array;
}

const key = (target: string): string => path.win32.normalize(target).toLowerCase();

export type FakeFileSystemCall = "stat" | "readSmallFile" | "sha256File";

export class FakeCollectorFileSystem implements CollectorIntegrationFileSystem {
  private readonly nodes = new Map<string, FakeNode>();
  public readonly calls: Array<{ readonly method: FakeFileSystemCall }> = [];
  /** Paths (lower-case keys) whose access throws. */
  public readonly failing = new Set<string>();
  /** Lower-case keys of every file passed to `readSmallFile`. */
  public readonly readPaths: string[] = [];

  public addDirectory(target: string, options: { readonly reparse?: boolean } = {}): void {
    const parent = path.win32.dirname(target);
    if (parent !== target && !this.nodes.has(key(parent)) && /^[A-Za-z]:\\.+/u.test(parent)) this.addDirectory(parent);
    this.nodes.set(key(target), { kind: "directory", reparse: options.reparse === true, content: new Uint8Array() });
  }

  public addFile(target: string, content: string | Uint8Array, options: { readonly reparse?: boolean; readonly kind?: "file" | "other" } = {}): void {
    this.addDirectory(path.win32.dirname(target));
    this.nodes.set(key(target), {
      kind: options.kind ?? "file",
      reparse: options.reparse === true,
      content: typeof content === "string" ? new TextEncoder().encode(content) : content,
    });
  }

  public remove(target: string): void {
    this.nodes.delete(key(target));
  }

  public setReparse(target: string, reparse: boolean): void {
    const node = this.nodes.get(key(target));
    if (node === undefined) throw new Error("fixture: unknown path");
    node.reparse = reparse;
  }

  public has(target: string): boolean {
    return this.nodes.has(key(target));
  }

  public text(target: string): string {
    const node = this.nodes.get(key(target));
    if (node === undefined) throw new Error("fixture: unknown path");
    return new TextDecoder().decode(node.content);
  }

  private enter(method: FakeFileSystemCall, target: string): void {
    this.calls.push({ method });
    if (this.failing.has(key(target))) throw new Error("injected file-system failure");
  }

  public async stat(target: string): Promise<CollectorFileEntry | null> {
    this.enter("stat", target);
    const node = this.nodes.get(key(target));
    return node === undefined ? null : { kind: node.kind, isReparsePoint: node.reparse, size: node.content.byteLength };
  }

  public async readSmallFile(target: string, maxBytes: number): Promise<CollectorFileRead> {
    this.enter("readSmallFile", target);
    this.readPaths.push(key(target));
    const node = this.nodes.get(key(target));
    if (node === undefined || node.kind !== "file") return { kind: "missing" };
    if (node.content.byteLength > maxBytes) return { kind: "too-large" };
    return { kind: "ok", bytes: node.content };
  }

  public async sha256File(target: string): Promise<string | null> {
    this.enter("sha256File", target);
    const node = this.nodes.get(key(target));
    return node === undefined || node.kind !== "file" ? null : sha256(node.content);
  }
}

export const HOST_EXE_BYTES = "host-executable-bytes";
export const HOST_ADDON_BYTES = "host-addon-bytes";
export const EXTENSION_FILES: Readonly<Record<string, string>> = {
  "manifest.json": JSON.stringify({ manifest_version: 3, name: "MAGINALIA Collector", version: "0.3.0" }),
  "background.js": "console.log('background');",
  "pages/onboarding.html": "<html></html>",
};

export function payloadDescriptorFixture(overrides: { readonly payloadId?: string; readonly hostVersion?: string; readonly extensionVersion?: string } = {}): Record<string, unknown> {
  const extensionFiles = Object.fromEntries(Object.entries(EXTENSION_FILES).map(([name, content]) => [
    name,
    sha256(name === "manifest.json" && overrides.extensionVersion !== undefined
      ? JSON.stringify({ ...JSON.parse(content), version: overrides.extensionVersion })
      : content),
  ]));
  return {
    version: 1,
    payloadId: overrides.payloadId ?? "1.2.0+abc1234",
    host: {
      version: overrides.hostVersion ?? "1.2.0",
      files: {
        [COLLECTOR_HOST_EXECUTABLE_NAME]: sha256(HOST_EXE_BYTES),
        [COLLECTOR_HOST_ADDON_NAME]: sha256(HOST_ADDON_BYTES),
      },
    },
    extension: { version: overrides.extensionVersion ?? "0.3.0", id: COLLECTOR_EXTENSION_ID, zipSha256: sha256("zip"), files: extensionFiles },
    protocol: COLLECTOR_PROTOCOL,
  };
}

export interface IntegrationFixture {
  readonly registry: FakeCollectorRegistryAdapter;
  readonly fileSystem: FakeCollectorFileSystem;
  readonly securityFacts: Map<string, PathSecurityFacts | "throw">;
  readonly securityCalls: string[];
  readonly dependencies: CollectorIntegrationInspectDependencies;
  readonly programFolder: string;
  readonly integrationDirectory: string;
  payload: unknown;
  payloadFails: boolean;
  now: Date;
  isolated: boolean;
}

export const FIXTURE_NOW = new Date("2026-11-14T09:00:00.000Z");

export function expectedManifestText(slot: "a" | "b"): string {
  return JSON.stringify({
    name: "org.maginalia.collector",
    description: "MAGINALIA Collector Native Messaging Host",
    path: `host-${slot}\\${COLLECTOR_HOST_EXECUTABLE_NAME}`,
    type: "stdio",
    allowed_origins: COLLECTOR_ALLOWED_ORIGINS,
  }, null, 2);
}

export function stateFileText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, payloadId: "1.2.0+abc1234", activeSlot: "b", extensionVersion: "0.3.0", placedAt: "2026-11-13T09:00:00.000Z", ...overrides });
}

export function contactText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, protocol: COLLECTOR_PROTOCOL, hostVersion: "1.2.0", extensionVersion: "0.3.0", contactedAt: "2026-11-14T08:59:00.000Z", ...overrides });
}

/**
 * A fully installed, ready integration: registration `ours`, program folder with manifest,
 * state file, active slot `b`, extension folder, all hashes matching. Tests then break it.
 */
export function createIntegrationFixture(options: { readonly installed?: boolean } = {}): IntegrationFixture {
  const registry = new FakeCollectorRegistryAdapter();
  const fileSystem = new FakeCollectorFileSystem();
  const programFolder = path.win32.join(registry.knownFolders.UserProgramFiles, "MAGINALIA Collector");
  const integrationDirectory = path.win32.join(registry.knownFolders.LocalAppData, "MAGINALIA", "integration");
  const securityFacts = new Map<string, PathSecurityFacts | "throw">();
  const securityCalls: string[] = [];
  const fixture: IntegrationFixture = {
    registry,
    fileSystem,
    securityFacts,
    securityCalls,
    programFolder,
    integrationDirectory,
    payload: payloadDescriptorFixture(),
    payloadFails: false,
    now: FIXTURE_NOW,
    isolated: false,
    get dependencies(): CollectorIntegrationInspectDependencies {
      return {
        registry,
        fileSystem,
        inspectPathSecurity: (target: string) => {
          securityCalls.push(target);
          const configured = securityFacts.get(key(target));
          if (configured === "throw") throw new Error("injected security inspection failure");
          if (configured !== undefined) return configured;
          // Default: existing entries (per the fake tree) are safe, others do not exist.
          const present = fileSystem.has(target);
          return present ? safeFacts(true) : { exists: false };
        },
        readPayloadDescriptor: async () => {
          if (fixture.payloadFails) throw new Error("payload unavailable");
          return fixture.payload;
        },
        now: () => fixture.now,
        e2eIsolationActive: fixture.isolated,
      };
    },
  };
  if (options.installed !== false) {
    registry.registration = "ours";
    fileSystem.addDirectory(programFolder);
    fileSystem.addFile(path.win32.join(programFolder, "org.maginalia.collector.json"), expectedManifestText("b"));
    fileSystem.addFile(path.win32.join(programFolder, "integration-state.json"), stateFileText());
    fileSystem.addFile(path.win32.join(programFolder, "host-b", COLLECTOR_HOST_EXECUTABLE_NAME), HOST_EXE_BYTES);
    fileSystem.addFile(path.win32.join(programFolder, "host-b", COLLECTOR_HOST_ADDON_NAME), HOST_ADDON_BYTES);
    for (const [name, content] of Object.entries(EXTENSION_FILES)) {
      fileSystem.addFile(path.win32.join(programFolder, "extension", ...name.split("/")), content);
    }
  }
  return fixture;
}

export const securityKey = key;
