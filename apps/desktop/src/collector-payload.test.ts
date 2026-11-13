import { describe, expect, it } from "vitest";
import { COLLECTOR_EXTENSION_ID, isSafeRelativeFileName, parseCollectorPayloadDescriptor } from "./collector-payload";
import { compareCollectorVersions, parseCollectorVersion } from "./collector-version";
import { payloadDescriptorFixture } from "./collector-integration.test-helper";

function clone(): Record<string, any> {
  return JSON.parse(JSON.stringify(payloadDescriptorFixture()));
}

describe("payload descriptor schema", () => {
  it("accepts the design 2.1 shape and freezes the result", () => {
    const result = parseCollectorPayloadDescriptor(payloadDescriptorFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.payloadId).toBe("1.2.0+abc1234");
    expect(result.descriptor.extension.id).toBe(COLLECTOR_EXTENSION_ID);
    expect(Object.isFrozen(result.descriptor)).toBe(true);
    expect(Object.keys(result.descriptor.extension.files)).toContain("manifest.json");
  });

  const mutations: ReadonlyArray<readonly [string, (value: Record<string, any>) => void, string]> = [
    ["extra top-level field", (v) => { v.extra = 1; }, "unknown-field"],
    ["missing top-level field", (v) => { delete v.protocol; }, "unknown-field"],
    ["descriptor version 2", (v) => { v.version = 2; }, "wrong-descriptor-version"],
    ["payloadId without commit", (v) => { v.payloadId = "1.2.0"; }, "invalid-payload-id"],
    ["payloadId with a path separator", (v) => { v.payloadId = "..\\x+abc"; }, "invalid-payload-id"],
    ["wrong protocol", (v) => { v.protocol = "maginalia.collector.experimental.v2"; }, "wrong-protocol"],
    ["host not an object", (v) => { v.host = "x"; }, "invalid-host"],
    ["host version garbage", (v) => { v.host.version = "latest"; }, "invalid-host-version"],
    ["host file set incomplete", (v) => { delete v.host.files["shelf_mutex.node"]; }, "invalid-host-files"],
    ["host file set with an extra file", (v) => { v.host.files["evil.dll"] = "0".repeat(64); }, "invalid-host-files"],
    ["host hash uppercase", (v) => { v.host.files["shelf_mutex.node"] = "A".repeat(64); }, "invalid-host-files"],
    ["extension version garbage", (v) => { v.extension.version = "x"; }, "invalid-extension-version"],
    ["wrong extension id", (v) => { v.extension.id = "a".repeat(32); }, "wrong-extension-id"],
    ["zip hash too short", (v) => { v.extension.zipSha256 = "abc"; }, "invalid-zip-hash"],
    ["no extension files", (v) => { v.extension.files = {}; }, "invalid-extension-files"],
    ["traversal in extension file name", (v) => { v.extension.files["../x.js"] = "0".repeat(64); }, "invalid-extension-files"],
    ["backslash in extension file name", (v) => { v.extension.files["a\\b.js"] = "0".repeat(64); }, "invalid-extension-files"],
    ["absolute extension file name", (v) => { v.extension.files["/etc/x"] = "0".repeat(64); }, "invalid-extension-files"],
    ["drive in extension file name", (v) => { v.extension.files["C:x.js"] = "0".repeat(64); }, "invalid-extension-files"],
    ["case-insensitive duplicate", (v) => { v.extension.files["Background.js"] = "0".repeat(64); }, "invalid-extension-files"],
    ["bad extension hash", (v) => { v.extension.files["background.js"] = "zz"; }, "invalid-extension-files"],
    ["no manifest.json", (v) => { delete v.extension.files["manifest.json"]; }, "missing-extension-manifest"],
  ];
  for (const [name, mutate, problem] of mutations) {
    it(`rejects: ${name}`, () => {
      const value = clone();
      mutate(value);
      expect(parseCollectorPayloadDescriptor(value)).toEqual({ ok: false, problem });
    });
  }

  it("rejects non-objects", () => {
    for (const value of [null, undefined, 1, "x", [], true]) expect(parseCollectorPayloadDescriptor(value)).toEqual({ ok: false, problem: "not-an-object" });
  });

  it("file-name rule", () => {
    for (const ok of ["manifest.json", "icons/16.png", "a/b/c.js"]) expect(isSafeRelativeFileName(ok)).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", "./a", "a/../b", "a\\b", "a:b", "a\u0000b", "a/b.", "a /b", "x".repeat(201), 3]) expect(isSafeRelativeFileName(bad)).toBe(false);
  });
});

describe("version comparison", () => {
  const cases: ReadonlyArray<readonly [unknown, unknown, string]> = [
    ["0.3.0", "0.3.0", "equal"],
    ["0.3", "0.3.0", "equal"],
    ["0.2.9", "0.3.0", "older"],
    ["1.0.0", "0.9.9", "newer"],
    ["0.3.0.1", "0.3.0", "newer"],
    ["0.10.0", "0.9.0", "newer"],
    ["1.2.0-beta.1", "1.2.0", "older"],
    ["1.2.0", "1.2.0-rc.1", "newer"],
    ["1.2.0-beta.2", "1.2.0-beta.10", "older"],
    ["1.2.0-alpha", "1.2.0-beta", "older"],
    ["1.2.0+abc", "1.2.0+def", "equal"],
    ["", "0.3.0", "unparseable"],
    ["abc", "0.3.0", "unparseable"],
    ["0.3.0", "v0.3.0", "unparseable"],
    ["1.2.3.4.5", "1.2.3", "unparseable"],
    [undefined, "0.3.0", "unparseable"],
    [3, "0.3.0", "unparseable"],
    ["1.-2.0", "1.0.0", "unparseable"],
  ];
  for (const [installed, expected, result] of cases) {
    it(`${JSON.stringify(installed)} vs ${JSON.stringify(expected)} is ${result}`, () => {
      expect(compareCollectorVersions(installed, expected)).toBe(result);
    });
  }

  it("parse rejects empty pre-release identifiers", () => {
    expect(parseCollectorVersion("1.0.0-")).toBeUndefined();
    expect(parseCollectorVersion("1.0.0-a..b")).toBeUndefined();
  });
});
