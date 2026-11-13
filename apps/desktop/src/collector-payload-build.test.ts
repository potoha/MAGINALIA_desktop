/**
 * Collector payload packaging (WP-4): strict ZIP extraction, extension ID derivation,
 * pin verification, descriptor schema, stage output and the packaged-tree verifier.
 * Pure build-script logic; no Windows, Chrome, network or installer involved.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";

const desktopRoot = path.resolve(import.meta.dirname, "..");

/* eslint-disable @typescript-eslint/no-explicit-any */
async function load(name: string): Promise<any> {
  return import(pathToFileURL(path.join(desktopRoot, "scripts", name)).href);
}

// The real Collector 0.3.0 public key (the extension ID is derived from it).
const COLLECTOR_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyp0ZIrFbABW+I8H80k14vICG1gWIgUUlVxxfQ7trxjGvg728zPYQ7o1ZE01uwGzaKGRn3J5cyNwlcjrYJHENHRdDwD7H3opT4rUMXdUJVSsQB4FSjsq0KBNyxv4QuTjeEY7tuEmUKfAdcKD7H8poGmcTdpPcZR+ycmcAHnThsj3EcLKxreKeYXRPI3Is1TeJhsU5aFH8SElFO8bt/+ggPEDvk5SDpPUJa+3tW2Jz0MZyoBph5jf4G8EXQ/ZHD2hcrxqjhVQ2pLqovBRsC9b2vhuS42cxTCspSDdFvwwN+wnEyfUlHXXCwRUCsQR+JpIiT7X6LvgAku/iN2Lo7fkqbQIDAQAB";
const COLLECTOR_ID = "blgmoddncpknfnikdfnjelmdmphfgknf";
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

interface ZipEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  external?: number;
  madeBy?: number;
  declaredSize?: number;
  crc?: number;
}

/** Minimal ZIP writer that can also write deliberately malformed archives. */
function writeZip(entries: ZipEntry[], { comment = Buffer.alloc(0), trailing = Buffer.alloc(0) } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = entry.crc ?? (zlib.crc32(entry.data) >>> 0);
    const size = entry.declaredSize ?? entry.data.length;
    const flags = entry.flags ?? 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.external ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, centralBytes, end, comment, trailing]);
}

function manifest(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ manifest_version: 3, name: "Test Collector", version: "0.3.0", key: COLLECTOR_KEY, ...overrides }));
}

const FILES = ["manifest.json", "popup.js", "icon..png"];

function releaseEntries(manifestBytes: Buffer = manifest()): ZipEntry[] {
  return [
    { name: "manifest.json", data: manifestBytes },
    { name: "popup.js", data: Buffer.from("console.log('popup');\n") },
    { name: "icon..png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), method: 0 },
  ];
}

function pinFor(zip: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    version: "0.3.0",
    asset: "maginalia-collector-0.3.0.zip",
    url: "https://github.com/potoha/MAGINALIA-Collector/releases/download/v0.3.0/maginalia-collector-0.3.0.zip",
    sha256: sha256(zip),
    extensionId: COLLECTOR_ID,
    files: FILES,
    ...overrides,
  };
}

describe("extension ID derivation", () => {
  it("derives the known Collector ID from the real manifest key", async () => {
    const { deriveExtensionId } = await load("collector-payload.mjs");
    expect(deriveExtensionId(COLLECTOR_KEY)).toBe(COLLECTOR_ID);
  });

  it("matches Chrome's algorithm on a fresh key and rejects missing or invalid keys", async () => {
    const { deriveExtensionId } = await load("collector-payload.mjs");
    const der = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
    const expected = [...createHash("sha256").update(der).digest("hex").slice(0, 32)].map((digit) => "abcdefghijklmnop"[Number.parseInt(digit, 16)]).join("");
    expect(deriveExtensionId(der.toString("base64"))).toBe(expected);
    expect(deriveExtensionId(der.toString("base64"))).toMatch(/^[a-p]{32}$/u);
    for (const bad of [undefined, "", "not base64!", 5]) expect(() => deriveExtensionId(bad)).toThrow();
  });
});

describe("strict ZIP extraction", () => {
  it("extracts exactly the pinned files in pinned order with verbatim bytes", async () => {
    const { extractCollectorZip } = await load("collector-payload.mjs");
    const entries = releaseEntries();
    const files: Map<string, Buffer> = extractCollectorZip(writeZip([...entries].reverse()), FILES);
    expect([...files.keys()]).toEqual(FILES);
    for (const entry of entries) expect(files.get(entry.name)?.equals(entry.data)).toBe(true);
  });

  const refusals: Array<[string, () => Buffer, RegExp]> = [
    ["a parent-directory traversal", () => writeZip([...releaseEntries(), { name: "../evil.js", data: Buffer.from("x") }]), /traversal|Unsafe|Nested/u],
    ["a traversal inside a path", () => writeZip([...releaseEntries(), { name: "a/../b.js", data: Buffer.from("x") }]), /traversal/u],
    ["an absolute POSIX name", () => writeZip([...releaseEntries(), { name: "/etc/passwd", data: Buffer.from("x") }]), /absolute/u],
    ["an absolute drive name", () => writeZip([...releaseEntries(), { name: "C:evil.js", data: Buffer.from("x") }]), /absolute/u],
    ["a backslash name", () => writeZip([...releaseEntries(), { name: "..\\evil.js", data: Buffer.from("x") }]), /backslash/u],
    ["an alternate-data-stream name", () => writeZip([...releaseEntries(), { name: "popup.js:stream", data: Buffer.from("x") }]), /colon/u],
    ["a control character name", () => writeZip([...releaseEntries(), { name: "a\u0001.js", data: Buffer.from("x") }]), /control/u],
    ["a nested file", () => writeZip([...releaseEntries(), { name: "sub/popup.js", data: Buffer.from("x") }]), /Nested/u],
    ["a directory entry", () => writeZip([...releaseEntries(), { name: "sub/", data: Buffer.alloc(0), method: 0 }]), /directory/u],
    ["a name that ends with a dot", () => writeZip([...releaseEntries(), { name: "evil.", data: Buffer.from("x") }]), /dot or space/u],
    ["a duplicate entry", () => writeZip([...releaseEntries(), { name: "popup.js", data: Buffer.from("other") }]), /Duplicate/u],
    ["a case-insensitive duplicate", () => writeZip([...releaseEntries(), { name: "POPUP.JS", data: Buffer.from("other") }]), /Duplicate/u],
    ["an extra entry beyond the pinned list", () => writeZip([...releaseEntries(), { name: "extra.js", data: Buffer.from("x") }]), /Unexpected entry/u],
    ["a missing pinned entry", () => writeZip(releaseEntries().slice(0, 2)), /Missing entry/u],
    ["a symbolic link entry", () => writeZip(releaseEntries().map((entry) => (entry.name === "popup.js" ? { ...entry, madeBy: 0x031e, external: (0xa1ff << 16) >>> 0 } : entry))), /not a regular file/u],
    ["a DOS directory attribute", () => writeZip(releaseEntries().map((entry) => (entry.name === "popup.js" ? { ...entry, external: 0x10 } : entry))), /directory/u],
    ["an encrypted entry", () => writeZip(releaseEntries().map((entry) => (entry.name === "popup.js" ? { ...entry, flags: 0x0801 } : entry))), /unsupported flags/u],
    ["a data-descriptor entry", () => writeZip(releaseEntries().map((entry) => (entry.name === "popup.js" ? { ...entry, flags: 0x0808 } : entry))), /unsupported flags/u],
    ["a CRC mismatch", () => writeZip(releaseEntries().map((entry) => (entry.name === "popup.js" ? { ...entry, crc: 1 } : entry))), /CRC/u],
    ["an archive comment", () => writeZip(releaseEntries(), { comment: Buffer.from("hi") }), /end-of-central-directory|comment/u],
    ["trailing bytes after the archive", () => writeZip(releaseEntries(), { trailing: Buffer.from("tail") }), /end-of-central-directory/u],
  ];
  for (const [label, build, message] of refusals) {
    it(`refuses ${label}`, async () => {
      const { extractCollectorZip } = await load("collector-payload.mjs");
      expect(() => extractCollectorZip(build(), FILES)).toThrow(message);
    });
  }

  it("refuses a decompression bomb whose declared size understates the real size", async () => {
    const { extractCollectorZip } = await load("collector-payload.mjs");
    const bomb = Buffer.alloc(3 * 1024 * 1024, 0x41);
    const zip = writeZip(releaseEntries().map((entry) => (entry.name === "popup.js" ? { ...entry, data: bomb, declaredSize: 10 } : entry)));
    expect(() => extractCollectorZip(zip, FILES)).toThrow(/inflate|size/u);
  });

  it("enforces per-entry, total, entry-count and archive size limits", async () => {
    const { extractCollectorZip } = await load("collector-payload.mjs");
    const zip = writeZip(releaseEntries());
    expect(() => extractCollectorZip(zip, FILES, { maxEntryBytes: 10 })).toThrow(/larger than/u);
    expect(() => extractCollectorZip(zip, FILES, { maxTotalBytes: 10 })).toThrow(/expands/u);
    expect(() => extractCollectorZip(zip, FILES, { maxEntries: 2 })).toThrow(/more than 2 entries/u);
    expect(() => extractCollectorZip(zip, FILES, { maxZipBytes: 10 })).toThrow(/larger than/u);
    const huge = writeZip(releaseEntries().map((entry) => (entry.name === "popup.js" ? { ...entry, data: Buffer.alloc(3 * 1024 * 1024, 1) } : entry)));
    expect(() => extractCollectorZip(huge, FILES)).toThrow(/larger than/u);
  });

  it("refuses non-ZIP and truncated input", async () => {
    const { extractCollectorZip } = await load("collector-payload.mjs");
    expect(() => extractCollectorZip(Buffer.from("not a zip at all, definitely"), FILES)).toThrow();
    expect(() => extractCollectorZip(Buffer.alloc(3), FILES)).toThrow();
    const zip = writeZip(releaseEntries());
    expect(() => extractCollectorZip(zip.subarray(0, zip.length - 30), FILES)).toThrow();
  });
});

describe("pin verification", () => {
  it("accepts the matching ZIP, version, ID and Host constant", async () => {
    const { verifyCollectorExtension } = await load("collector-payload.mjs");
    const zip = writeZip(releaseEntries());
    const verified = verifyCollectorExtension(zip, pinFor(zip), { hostExtensionId: COLLECTOR_ID });
    expect(verified).toMatchObject({ zipSha256: sha256(zip), version: "0.3.0", extensionId: COLLECTOR_ID });
  });

  it("fails on a tampered ZIP", async () => {
    const { verifyCollectorExtension } = await load("collector-payload.mjs");
    const zip = writeZip(releaseEntries());
    const pin = pinFor(zip);
    const tampered = Buffer.from(zip);
    tampered[40] ^= 0xff;
    expect(() => verifyCollectorExtension(tampered, pin)).toThrow(/SHA-256/u);
  });

  it("fails on a wrong manifest version", async () => {
    const { verifyCollectorExtension } = await load("collector-payload.mjs");
    const zip = writeZip(releaseEntries(manifest({ version: "0.3.1" })));
    expect(() => verifyCollectorExtension(zip, pinFor(zip))).toThrow(/version 0\.3\.1/u);
  });

  it("fails on a wrong derived extension ID and on a missing key", async () => {
    const { verifyCollectorExtension } = await load("collector-payload.mjs");
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const wrongKey = writeZip(releaseEntries(manifest({ key: otherKey })));
    expect(() => verifyCollectorExtension(wrongKey, pinFor(wrongKey))).toThrow(/derived from manifest\.key/u);
    const noKey = writeZip(releaseEntries(manifest({ key: undefined })));
    expect(() => verifyCollectorExtension(noKey, pinFor(noKey))).toThrow(/manifest\.key/u);
  });

  it("fails when the pin or the Host constant disagrees with the derived ID", async () => {
    const { verifyCollectorExtension } = await load("collector-payload.mjs");
    const zip = writeZip(releaseEntries());
    expect(() => verifyCollectorExtension(zip, pinFor(zip, { extensionId: "a".repeat(32) }))).toThrow(/pinned/u);
    expect(() => verifyCollectorExtension(zip, pinFor(zip), { hostExtensionId: "a".repeat(32) })).toThrow(/Host constant/u);
  });

  it("fails on a non-JSON, non-object or non-MV3 manifest", async () => {
    const { verifyCollectorExtension } = await load("collector-payload.mjs");
    for (const bytes of [Buffer.from("{nope"), Buffer.from("[]"), manifest({ manifest_version: 2 })]) {
      const zip = writeZip(releaseEntries(bytes));
      expect(() => verifyCollectorExtension(zip, pinFor(zip))).toThrow();
    }
  });
});

describe("repository pin and build-time flag", () => {
  it("pins Collector 0.3.0 with the known ID, consistent with the Host constant", async () => {
    const { readCollectorPin } = await load("collector-payload.mjs");
    const pin = readCollectorPin(JSON.parse(await readFile(path.join(desktopRoot, "packaging", "runtime-versions.json"), "utf8")));
    expect(pin).toMatchObject({
      version: "0.3.0",
      asset: "maginalia-collector-0.3.0.zip",
      url: "https://github.com/potoha/MAGINALIA-Collector/releases/download/v0.3.0/maginalia-collector-0.3.0.zip",
      sha256: "d5190a0f02fafe59b4d1bdc14ef35f7d029f6d70551f0ee2d70857c554b3df00",
      extensionId: COLLECTOR_ID,
    });
    expect(pin.files).toHaveLength(14);
    const { readHostExtensionId } = await load("stage-collector-payload.mjs");
    expect(await readHostExtensionId(desktopRoot)).toBe(pin.extensionId);
  });

  it("rejects malformed pins", async () => {
    const { readCollectorPin } = await load("collector-payload.mjs");
    const zip = writeZip(releaseEntries());
    const good = pinFor(zip);
    expect(() => readCollectorPin({ collectorExtension: good })).not.toThrow();
    for (const bad of [
      { ...good, sha256: "ABC" }, { ...good, extensionId: "xyz" }, { ...good, asset: "other.zip" },
      { ...good, url: "https://example.com/maginalia-collector-0.3.0.zip" }, { ...good, files: ["popup.js"] },
      { ...good, files: ["manifest.json", "manifest.json"] }, { ...good, files: ["manifest.json", "../x"] },
    ]) expect(() => readCollectorPin({ collectorExtension: bad })).toThrow();
    expect(() => readCollectorPin({})).toThrow(/no collectorExtension/u);
  });

  it("parses --collector-zip and requires an absolute path to read a local ZIP", async () => {
    const { parseCollectorZipFlag, loadCollectorZip } = await load("collector-payload.mjs");
    expect(parseCollectorZipFlag([])).toBeUndefined();
    expect(parseCollectorZipFlag(["--collector-zip", "C:\\x\\a.zip"])).toBe("C:\\x\\a.zip");
    expect(parseCollectorZipFlag(["--collector-zip=C:\\x\\a.zip"])).toBe("C:\\x\\a.zip");
    expect(() => parseCollectorZipFlag(["--collector-zip"])).toThrow();
    expect(() => parseCollectorZipFlag(["--collector-zip", "a", "--collector-zip", "b"])).toThrow(/twice/u);
    await expect(loadCollectorZip({}, { localZip: "relative.zip" })).rejects.toThrow(/absolute/u);
  });

  it("a local ZIP is still verified against the pinned hash; a download failure explains the flag", async () => {
    const { loadCollectorZip, verifyCollectorExtension } = await load("collector-payload.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "collector-zip-"));
    try {
      const zip = writeZip(releaseEntries());
      const file = path.join(root, "local.zip");
      await writeFile(file, zip);
      const pin = pinFor(zip);
      const loaded = await loadCollectorZip(pin, { localZip: file });
      expect(loaded.source).toBe("local");
      expect(() => verifyCollectorExtension(loaded.bytes, pin)).not.toThrow();
      expect(() => verifyCollectorExtension(loaded.bytes, pinFor(zip, { sha256: "0".repeat(64) }))).toThrow(/SHA-256/u);
      await expect(loadCollectorZip(pin, { fetchImpl: async () => ({ ok: false, status: 404, body: null }) })).rejects.toThrow(/--collector-zip/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("payload descriptor", () => {
  async function descriptor() {
    const { buildDescriptor, verifyCollectorExtension } = await load("collector-payload.mjs");
    const zip = writeZip(releaseEntries());
    const extension = verifyCollectorExtension(zip, pinFor(zip));
    return buildDescriptor({
      desktopVersion: "0.2.0",
      commit: "abcdef0123456789",
      hostFiles: new Map([["MAGINALIA-Collector-Host.exe", Buffer.from("exe")], ["shelf_mutex.node", Buffer.from("addon")]]),
      extension,
    });
  }

  it("has exactly the design section 2.1 shape and validates", async () => {
    const value = await descriptor();
    expect(Object.keys(value)).toEqual(["version", "payloadId", "host", "extension", "protocol"]);
    expect(value).toMatchObject({
      version: 1,
      payloadId: "0.2.0+abcdef0",
      host: { version: "0.2.0", files: { "MAGINALIA-Collector-Host.exe": sha256("exe"), "shelf_mutex.node": sha256("addon") } },
      extension: { version: "0.3.0", id: COLLECTOR_ID },
      protocol: "maginalia.collector.experimental.v1",
    });
    expect(Object.keys(value.extension.files)).toEqual(["icon..png", "manifest.json", "popup.js"]);
  });

  it("refuses a Desktop version that is not the payload version", async () => {
    const { buildDescriptor } = await load("collector-payload.mjs");
    expect(() => buildDescriptor({ desktopVersion: "0.1.0", commit: "abcdef0", hostFiles: new Map(), extension: {} })).toThrow(/PAYLOAD_VERSION/u);
  });

  it("the Desktop package version equals the payload version", async () => {
    const { PAYLOAD_VERSION } = await load("collector-payload.mjs");
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8")) as { version: string };
    expect(desktopPackage.version).toBe(PAYLOAD_VERSION);
    expect(PAYLOAD_VERSION).toBe("0.2.0");
  });

  it("the JSON Schema and the hand validator agree on the example and on mutations", async () => {
    const { validateDescriptor } = await load("collector-payload.mjs");
    const schema = JSON.parse(await readFile(path.join(desktopRoot, "packaging", "collector-payload.schema.json"), "utf8"));
    const example = JSON.parse(await readFile(path.join(desktopRoot, "packaging", "collector-payload.example.json"), "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(example)).toBe(true);
    expect(() => validateDescriptor(example)).not.toThrow();
    const mutate = (change: (value: any) => void) => { const copy = structuredClone(example); change(copy); return copy; };
    const bad = [
      mutate((v) => { v.version = 2; }),
      mutate((v) => { v.payloadId = "0.2.0"; }),
      mutate((v) => { v.extra = 1; }),
      mutate((v) => { delete v.protocol; }),
      mutate((v) => { v.protocol = "other"; }),
      mutate((v) => { v.host.files["MAGINALIA-Collector-Host.exe"] = "XYZ"; }),
      mutate((v) => { v.host.files.extra = "a".repeat(64); }),
      mutate((v) => { delete v.host.files["shelf_mutex.node"]; }),
      mutate((v) => { v.extension.id = "blgmoddncpknfnikdfnjelmdmphfgknz"; }),
      mutate((v) => { v.extension.zipSha256 = "a".repeat(63); }),
      mutate((v) => { delete v.extension.files["manifest.json"]; }),
      mutate((v) => { v.extension.files["../x.js"] = "a".repeat(64); }),
      mutate((v) => { v.extension.allowedOrigins = []; }),
    ];
    for (const value of bad) {
      expect(validate(value)).toBe(false);
      expect(() => validateDescriptor(value)).toThrow();
    }
  });
});

describe("repository packaging wiring", () => {
  it("ships the Collector payload through extraResources and no standalone installer", async () => {
    const builder = JSON.parse(await readFile(path.join(desktopRoot, "packaging", "electron-builder.json"), "utf8")) as { extraResources: Array<{ from: string; to: string }> };
    const mapping = Object.fromEntries(builder.extraResources.map((entry) => [entry.to, entry.from]));
    expect(mapping).toMatchObject({
      "collector-host": "packaging/runtime/collector-host",
      "collector-extension": "packaging/runtime/collector-extension",
      "collector-payload.json": "packaging/runtime/collector-payload.json",
      "shelf-mutex": "packaging/runtime/shelf-mutex",
      "windows-integration": "packaging/runtime/windows-integration",
    });
    const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["dist:collector-host"]).toBeUndefined();
    expect(packageJson.scripts["dist:windows"]).toContain("package:windows:collector-host");
    const build = await readFile(path.join(desktopRoot, "scripts", "build-collector-host.mjs"), "utf8");
    expect(build).not.toMatch(/nsis|makensis|installer\.nsi|Setup-/iu);
    await expect(readFile(path.join(desktopRoot, "packaging", "collector-host", "installer.nsi"))).rejects.toThrow();
    const stage = await readFile(path.join(desktopRoot, "scripts", "stage-windows-app.mjs"), "utf8");
    expect(stage).toContain("stageCollectorPayload");
  });
});

describe("staging and packaged-tree verification", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "collector-stage-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function fixture() {
    const desktop = path.join(root, "desktop");
    const payload = path.join(desktop, "release", "collector-host", "payload");
    await mkdir(payload, { recursive: true });
    await mkdir(path.join(desktop, "src"), { recursive: true });
    await mkdir(path.join(desktop, "packaging"), { recursive: true });
    await writeFile(path.join(desktop, "src", "collector-native-host-product.ts"), `export const COLLECTOR_EXTENSION_ID = "${COLLECTOR_ID}";\n`);
    await writeFile(path.join(desktop, "package.json"), JSON.stringify({ version: "0.2.0" }));
    const addon = Buffer.from("addon-bytes");
    const files: Record<string, Buffer> = {
      "MAGINALIA-Collector-Host.exe": Buffer.from("exe-bytes"), "shelf_mutex.node": addon,
      "LICENSE.txt": Buffer.from("l"), "NOTICE.txt": Buffer.from("n"), "NODE-LICENSE.txt": Buffer.from("nl"), "PROVENANCE.txt": Buffer.from("p"),
    };
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(payload, name), bytes);
    const zip = writeZip(releaseEntries());
    const zipPath = path.join(root, "collector.zip");
    await writeFile(zipPath, zip);
    const pin = pinFor(zip);
    await writeFile(path.join(desktop, "packaging", "runtime-versions.json"), JSON.stringify({ collectorExtension: pin }));
    return { desktop, zipPath, pin, addon, runtime: path.join(desktop, "packaging", "runtime") };
  }

  /** Stage into a runtime folder and shape it like `<resources>` (adds shelf-mutex). */
  async function stagedResources() {
    const { stageCollectorPayload } = await load("stage-collector-payload.mjs");
    const f = await fixture();
    await mkdir(path.join(f.runtime, "shelf-mutex"), { recursive: true });
    await writeFile(path.join(f.runtime, "shelf-mutex", "shelf_mutex.node"), f.addon);
    const result = await stageCollectorPayload({ desktopRoot: f.desktop, runtimeRoot: f.runtime, localZip: f.zipPath, shelfMutexSha256: sha256(f.addon), commit: "0123456789abcdef" });
    return { ...f, result, resources: f.runtime };
  }

  it("stages the design 2.1 layout and a descriptor whose hashes match the files", async () => {
    const { resources, result } = await stagedResources();
    expect(result.source).toBe("local");
    expect(result.descriptor.payloadId).toBe("0.2.0+0123456");
    const descriptorOnDisk = JSON.parse(await readFile(path.join(resources, "collector-payload.json"), "utf8"));
    expect(descriptorOnDisk).toEqual(result.descriptor);
    expect(descriptorOnDisk.host.files["shelf_mutex.node"]).toBe(sha256("addon-bytes"));
    for (const [name, hash] of Object.entries(descriptorOnDisk.extension.files as Record<string, string>)) {
      expect(sha256(await readFile(path.join(resources, "collector-extension", name)))).toBe(hash);
    }
  });

  it("refuses to stage a tampered local ZIP and a Host addon that differs from the staged Shelf mutex", async () => {
    const { stageCollectorPayload } = await load("stage-collector-payload.mjs");
    const f = await fixture();
    const zip = await readFile(f.zipPath);
    zip[50] ^= 0xff;
    await writeFile(f.zipPath, zip);
    await expect(stageCollectorPayload({ desktopRoot: f.desktop, runtimeRoot: f.runtime, localZip: f.zipPath, commit: "0123456" })).rejects.toThrow(/SHA-256/u);
    await expect(stageCollectorPayload({ desktopRoot: f.desktop, runtimeRoot: f.runtime, localZip: f.zipPath, shelfMutexSha256: "0".repeat(64), commit: "0123456" })).rejects.toThrow(/differs from the staged Shelf mutex/u);
  });

  it("verifies a staged tree and fails on each kind of tampering", async () => {
    const { verifyCollectorResources } = await load("verify-packaged-collector-payload.mjs");
    const { resources, pin } = await stagedResources();
    const options = { pin, hostExtensionId: COLLECTOR_ID };
    await expect(verifyCollectorResources(resources, options)).resolves.toMatchObject({ descriptor: { protocol: "maginalia.collector.experimental.v1" } });

    const tamper = async (relative: string, content: string | null, expected: RegExp) => {
      const target = path.join(resources, relative);
      const original = await readFile(target).catch(() => null);
      if (content === null) await rm(target); else await writeFile(target, content);
      await expect(verifyCollectorResources(resources, options)).rejects.toThrow(expected);
      if (original === null) await rm(target, { force: true }); else await writeFile(target, original);
    };
    await tamper(path.join("collector-host", "MAGINALIA-Collector-Host.exe"), "evil", /does not match collector-payload\.json/u);
    await tamper(path.join("collector-host", "shelf_mutex.node"), "evil", /does not match collector-payload\.json/u);
    await tamper(path.join("shelf-mutex", "shelf_mutex.node"), "other", /not the same build/u);
    await tamper(path.join("collector-extension", "popup.js"), "evil", /does not match collector-payload\.json/u);
    await tamper(path.join("collector-extension", "popup.js"), null, /does not hold exactly/u);
    await tamper(path.join("collector-extension", "extra.js"), "extra", /does not hold exactly/u);
    await tamper(path.join("collector-host", "EXTRA.dll"), "extra", /must hold exactly/u);
    await tamper("collector-payload.json", "{}", /exactly the keys|must be/u);
    await expect(verifyCollectorResources(resources, { pin: { ...pin, version: "0.3.1" }, hostExtensionId: COLLECTOR_ID })).rejects.toThrow(/version/u);
    await expect(verifyCollectorResources(resources, { pin, hostExtensionId: "a".repeat(32) })).rejects.toThrow(/Host constant/u);
    await expect(verifyCollectorResources(resources, { pin: { ...pin, sha256: "1".repeat(64) }, hostExtensionId: COLLECTOR_ID })).rejects.toThrow(/ZIP SHA-256/u);
  });
});
