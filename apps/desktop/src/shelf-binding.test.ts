import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { handleExperimentalRequest } from "./collector-native-host.js";
import {
  createShelfBindingFromConfirmedSelection,
  digestPrivateShelfLocator,
  parseShelfBinding,
  parseShelfBindingJson,
  persistShelfBinding,
  readShelfBinding,
  serializeShelfBinding,
  validateShelfBindingForUse,
  type ShelfBindingReaderAdapter,
  type ShelfBindingV1,
  type SecureShelfBindingPersistenceAdapter,
} from "./shelf-binding.js";

const SHELF_LOCATION_PATH = "C:\\Users\\Researcher\\AppData\\Roaming\\MAGINALIA\\shelf_location.yml";
const PRIVATE_SHELF_LOCATOR = "D:\\Research\\Private Shelf";
const SHELF_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_SHELF_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function makeBinding(): ShelfBindingV1 {
  const result = createShelfBindingFromConfirmedSelection({
    shelfLocationPath: SHELF_LOCATION_PATH,
    privateShelfLocator: PRIVATE_SHELF_LOCATOR,
    confirmedMarker: { version: 1, type: "shelf", id: SHELF_ID },
  });
  if (result.kind === "error") throw new Error(`Fixture binding failed: ${result.code}`);
  return result.binding;
}

function useRequest(overrides: Record<string, unknown> = {}): {
  binding: unknown;
  shelfLocationPath: unknown;
  privateShelfLocator: unknown;
  marker: unknown;
} {
  return {
    binding: makeBinding(),
    shelfLocationPath: SHELF_LOCATION_PATH,
    privateShelfLocator: PRIVATE_SHELF_LOCATOR,
    marker: { version: 1, type: "shelf", id: SHELF_ID },
    ...overrides,
  };
}

describe("versioned Shelf binding contract", () => {
  test("creates a v1 binding from the confirmed typed marker and exact configured locator", () => {
    const marker = Object.freeze({ version: 1, type: "shelf", id: SHELF_ID });
    const created = createShelfBindingFromConfirmedSelection({
      shelfLocationPath: SHELF_LOCATION_PATH,
      privateShelfLocator: PRIVATE_SHELF_LOCATOR,
      confirmedMarker: marker,
    });

    expect(created).toMatchObject({
      kind: "valid",
      binding: {
        version: 1,
        shelfLocationPath: SHELF_LOCATION_PATH,
        expectedShelfId: SHELF_ID,
        locatorSha256: digestPrivateShelfLocator(PRIVATE_SHELF_LOCATOR),
        generation: 1,
      },
    });
    expect(marker).toEqual({ version: 1, type: "shelf", id: SHELF_ID });
  });

  test("rejects untyped or mismatched markers without adopting or repairing them", () => {
    expect(createShelfBindingFromConfirmedSelection({
      shelfLocationPath: SHELF_LOCATION_PATH,
      privateShelfLocator: PRIVATE_SHELF_LOCATOR,
      confirmedMarker: { version: 1, type: "project", id: SHELF_ID },
    })).toEqual({ kind: "error", code: "marker-invalid" });

    const result = validateShelfBindingForUse(useRequest({
      marker: { version: 1, type: "shelf", id: OTHER_SHELF_ID },
    }));
    expect(result).toEqual({ kind: "error", code: "shelf-identity-mismatch" });
  });

  test("strictly parses the v1 schema and canonical JSON representation", () => {
    const binding = makeBinding();
    const serialized = serializeShelfBinding(binding);

    expect(parseShelfBinding(binding)).toEqual({ kind: "valid", binding });
    expect(parseShelfBindingJson(serialized)).toEqual({ kind: "valid", binding });
    expect(parseShelfBinding({ ...binding, extra: true })).toEqual({ kind: "error", code: "binding-schema-invalid" });
    expect(parseShelfBinding({ ...binding, version: 2 })).toEqual({ kind: "error", code: "binding-version-unsupported" });
    expect(parseShelfBinding({ ...binding, generation: 0 })).toEqual({ kind: "error", code: "binding-generation-invalid" });
    expect(parseShelfBinding({ ...binding, generation: 1.25 })).toEqual({ kind: "error", code: "binding-generation-invalid" });
  });

  test("treats malformed, duplicate-key, and unsupported-version JSON as corrupt or unsupported", () => {
    const serialized = serializeShelfBinding(makeBinding());
    const duplicateVersion = serialized.replace('  "version": 1,', '  "version": 1,\n  "version": 1,');
    const unsupportedVersion = serialized.replace('  "version": 1,', '  "version": 2,');

    expect(parseShelfBindingJson("{broken")).toEqual({ kind: "error", code: "binding-json-corrupt" });
    expect(parseShelfBindingJson(duplicateVersion)).toEqual({ kind: "error", code: "binding-json-corrupt" });
    expect(parseShelfBindingJson(unsupportedVersion)).toEqual({ kind: "error", code: "binding-version-unsupported" });
  });

  test("fails closed when the config reference changes or no longer names shelf_location.yml", () => {
    expect(validateShelfBindingForUse(useRequest({
      shelfLocationPath: "C:\\Users\\Researcher\\Other\\shelf_location.yml",
    }))).toEqual({ kind: "error", code: "configuration-reference-mismatch" });

    expect(createShelfBindingFromConfirmedSelection({
      shelfLocationPath: "relative\\shelf_location.yml",
      privateShelfLocator: PRIVATE_SHELF_LOCATOR,
      confirmedMarker: { version: 1, type: "shelf", id: SHELF_ID },
    })).toEqual({ kind: "error", code: "configuration-reference-invalid" });

    expect(createShelfBindingFromConfirmedSelection({
      shelfLocationPath: "C:\\Users\\Researcher\\AppData\\Roaming\\MAGINALIA\\config.json",
      privateShelfLocator: PRIVATE_SHELF_LOCATOR,
      confirmedMarker: { version: 1, type: "shelf", id: SHELF_ID },
    })).toEqual({ kind: "error", code: "configuration-reference-invalid" });
  });

  test("detects a moved or changed locator by its digest without learning a replacement", () => {
    const result = validateShelfBindingForUse(useRequest({
      privateShelfLocator: "D:\\Research\\Moved Private Shelf",
    }));

    expect(result).toEqual({ kind: "error", code: "locator-changed" });
    expect(digestPrivateShelfLocator("\\\\server\\share\\Shelf")).toBeUndefined();
  });

  test("accepts a drive-root Shelf locator supported by existing configuration", () => {
    const result = createShelfBindingFromConfirmedSelection({
      shelfLocationPath: SHELF_LOCATION_PATH,
      privateShelfLocator: "D:\\",
      confirmedMarker: { version: 1, type: "shelf", id: SHELF_ID },
    });

    expect(result).toMatchObject({
      kind: "valid",
      binding: {
        expectedShelfId: SHELF_ID,
        locatorSha256: digestPrivateShelfLocator("D:\\"),
      },
    });
  });

  test("reuses a valid per-user binding without per-logon input", () => {
    expect(validateShelfBindingForUse(useRequest()))
      .toMatchObject({ kind: "valid", binding: { expectedShelfId: SHELF_ID } });
  });

  test("uses injected persistence and exposes a read-only Host adapter surface", async () => {
    const binding = makeBinding();
    const serialized = serializeShelfBinding(binding);
    const hostReader: ShelfBindingReaderAdapter = {
      readBindingText: vi.fn().mockResolvedValue(serialized),
    };
    const loaded = await readShelfBinding(hostReader);

    expect(loaded).toEqual({ kind: "valid", binding });
    expect(hostReader.readBindingText).toHaveBeenCalledOnce();
    expect("replaceBindingAtomically" in hostReader).toBe(false);

    const replaceBindingAtomically = vi.fn().mockResolvedValue(undefined);
    const injectedWriter: SecureShelfBindingPersistenceAdapter = {
      readBindingText: vi.fn().mockResolvedValue(null),
      replaceBindingAtomically,
    };
    const persisted = await persistShelfBinding(injectedWriter, binding, null);

    expect(persisted).toEqual({ kind: "valid", binding });
    expect(replaceBindingAtomically).toHaveBeenCalledOnce();
    expect(replaceBindingAtomically).toHaveBeenCalledWith(serialized, null);
    expect(await persistShelfBinding(injectedWriter, binding, 1)).toEqual({
      kind: "error",
      code: "binding-generation-conflict",
    });
    expect(replaceBindingAtomically).toHaveBeenCalledOnce();
  });

  test("keeps the experimental Native Messaging Host read-only", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "shelf-binding-host-read-only-"));
    try {
      const descriptorPath = path.join(temporaryRoot, "experimental-descriptor.json");
      const origin = `chrome-extension://${"a".repeat(32)}/`;
      await writeFile(descriptorPath, JSON.stringify({
        experimental: true,
        shelfLocationPath: path.join(temporaryRoot, "shelf_location.yml"),
        expectedShelfId: SHELF_ID,
        allowedOrigin: origin,
      }));

      const response = await handleExperimentalRequest({
        protocol: "maginalia.collector.experimental.v1",
        operation: "health",
      }, descriptorPath, origin);
      const saveResponse = await handleExperimentalRequest({
        protocol: "maginalia.collector.experimental.v1",
        operation: "save",
      }, descriptorPath, origin);

      expect(response).toMatchObject({
        ok: true,
        experimental: true,
        writesEnabled: false,
        operations: ["health", "configured_shelf"],
      });
      expect(saveResponse).toMatchObject({
        ok: false,
        error: "unsupported_operation",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("fails closed for missing, corrupt, or unavailable injected storage", async () => {
    await expect(readShelfBinding({ readBindingText: async () => null }))
      .resolves.toEqual({ kind: "error", code: "binding-missing" });
    await expect(readShelfBinding({ readBindingText: async () => "not-json" }))
      .resolves.toEqual({ kind: "error", code: "binding-json-corrupt" });
    await expect(readShelfBinding({ readBindingText: async () => { throw new Error("unavailable"); } }))
      .resolves.toEqual({ kind: "error", code: "binding-unavailable" });
  });
});
