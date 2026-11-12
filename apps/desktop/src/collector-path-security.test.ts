import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_SYSTEM_SID,
  evaluatePathSecurity,
  inspectAndEvaluatePathSecurity,
  parsePathSecurityFacts,
  verifyCollectorStorageSecurity,
  type PathSecurityFacts,
} from "./collector-path-security";
import { resolveShelfBindingStoragePaths } from "./shelf-binding-store";
import { createNativePrivateDirectory, inspectNativePathSecurity, nativeShelfMutexAvailable } from "./shelf-native-mutex";
import { safeFacts } from "./collector-host-fixture.test-helper";

function withAce(
  facts: PathSecurityFacts,
  ace: { type: "allow" | "deny" | "allow-object"; sid: string; mask: number; inheritOnly?: boolean },
): PathSecurityFacts {
  if (!facts.exists) return facts;
  return { ...facts, aces: [...facts.aces, { inheritOnly: false, ...ace }] };
}

describe("Collector ownership / ACL policy (fakes)", () => {
  it("accepts current-user ownership with only the user, SYSTEM and Administrators writing", () => {
    expect(evaluatePathSecurity(safeFacts(true), "directory")).toEqual({ ok: true });
    expect(evaluatePathSecurity(safeFacts(false), "file")).toEqual({ ok: true });
  });

  it("fails closed on each unsafe fact", () => {
    const dir = safeFacts(true);
    if (!dir.exists) throw new Error("fixture");
    expect(evaluatePathSecurity({ exists: false }, "directory")).toEqual({ ok: false, violation: "missing" });
    expect(evaluatePathSecurity({ ...dir, isReparsePoint: true }, "directory")).toEqual({ ok: false, violation: "reparse-point" });
    expect(evaluatePathSecurity(dir, "file")).toEqual({ ok: false, violation: "wrong-entry-type" });
    expect(evaluatePathSecurity({ ...dir, ownerSid: WINDOWS_ADMINISTRATORS_SID }, "directory"))
      .toEqual({ ok: false, violation: "owner-not-current-user" });
    expect(evaluatePathSecurity({ ...dir, ownerSid: "" }, "directory")).toEqual({ ok: false, violation: "owner-not-current-user" });
    expect(evaluatePathSecurity({ ...dir, daclPresent: false, aces: [] }, "directory")).toEqual({ ok: false, violation: "null-dacl" });
    // Everyone with FILE_WRITE_DATA, Authenticated Users with DELETE, an AppContainer
    // capability with full control, another local user with GENERIC_WRITE.
    for (const [sid, mask] of [
      ["S-1-1-0", 0x2],
      ["S-1-5-11", 0x10000],
      ["S-1-15-3-1-2-3", 0x1f01ff],
      ["S-1-5-21-9-9-9-1002", 0x40000000],
    ] as const) {
      expect(evaluatePathSecurity(withAce(dir, { type: "allow", sid, mask }), "directory"))
        .toEqual({ ok: false, violation: "foreign-writer" });
    }
    expect(evaluatePathSecurity(withAce(dir, { type: "allow-object", sid: "", mask: 0x2 }), "directory"))
      .toEqual({ ok: false, violation: "unsupported-ace" });
  });

  it("ignores read-only grants, deny entries and inherit-only templates", () => {
    const dir = safeFacts(true);
    expect(evaluatePathSecurity(withAce(dir, { type: "allow", sid: "S-1-5-32-545", mask: 0x1200a9 }), "directory")).toEqual({ ok: true });
    expect(evaluatePathSecurity(withAce(dir, { type: "deny", sid: "S-1-1-0", mask: 0x1f01ff }), "directory")).toEqual({ ok: true });
    expect(evaluatePathSecurity(withAce(dir, { type: "allow", sid: "S-1-3-0", mask: 0x10000000, inheritOnly: true }), "directory"))
      .toEqual({ ok: true });
    expect(evaluatePathSecurity(withAce(dir, { type: "allow", sid: WINDOWS_SYSTEM_SID.toLowerCase(), mask: 0x1f01ff }), "directory"))
      .toEqual({ ok: true });
  });

  it("treats malformed native results and inspection errors as failures", () => {
    expect(parsePathSecurityFacts(null)).toBeUndefined();
    expect(parsePathSecurityFacts({ exists: true })).toBeUndefined();
    expect(inspectAndEvaluatePathSecurity(() => { throw new Error("denied"); }, "C:\\x", "file"))
      .toEqual({ ok: false, violation: "inspection-failed" });
    expect(inspectAndEvaluatePathSecurity(() => ({ exists: "yes" }), "C:\\x", "file"))
      .toEqual({ ok: false, violation: "inspection-failed" });
    expect(inspectAndEvaluatePathSecurity(() => ({ exists: false }), "C:\\x", "directory", { optional: true })).toEqual({ ok: true });
  });

  it("checks the application root, binding directory, binding file and an existing coordination root", () => {
    const paths = resolveShelfBindingStoragePaths("C:\\Users\\Researcher\\AppData\\Local");
    const seen: string[] = [];
    const facts = new Map<string, unknown>([
      ["C:\\Users\\Researcher\\AppData\\Local\\MAGINALIA", safeFacts(true)],
      [paths.bindingDirectory, safeFacts(true)],
      [paths.bindingPath, safeFacts(false)],
      [paths.coordinationRoot, { exists: false }],
    ]);
    const inspect = (target: string): unknown => { seen.push(target); return facts.get(target); };
    expect(verifyCollectorStorageSecurity(paths, inspect)).toEqual({ ok: true });
    expect(seen).toEqual([...facts.keys()]);
    facts.set(paths.coordinationRoot, withAce(safeFacts(true), { type: "allow", sid: "S-1-1-0", mask: 0x2 }));
    expect(verifyCollectorStorageSecurity(paths, inspect)).toEqual({ ok: false, target: "coordination-root", violation: "foreign-writer" });
    facts.set(paths.bindingPath, { exists: false });
    expect(verifyCollectorStorageSecurity(paths, inspect)).toEqual({ ok: false, target: "binding-file", violation: "missing" });
  });
});

const native = process.platform === "win32" && nativeShelfMutexAvailable();

describe.skipIf(!native)("Collector ownership / ACL policy (real Windows addon, disposable temp dir)", () => {
  it("accepts a protected private directory and its files; rejects junctions and foreign writers", async () => {
    const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "collector-acl-")));
    try {
      const privateDir = path.join(temp, "private");
      expect(createNativePrivateDirectory(privateDir)).toBe("created");
      expect(createNativePrivateDirectory(privateDir)).toBe("exists");
      const file = path.join(privateDir, "binding.json");
      await writeFile(file, "{}\n");
      expect(inspectAndEvaluatePathSecurity(inspectNativePathSecurity, privateDir, "directory")).toEqual({ ok: true });
      expect(inspectAndEvaluatePathSecurity(inspectNativePathSecurity, file, "file")).toEqual({ ok: true });
      expect(inspectAndEvaluatePathSecurity(inspectNativePathSecurity, path.join(privateDir, "absent"), "file"))
        .toEqual({ ok: false, violation: "missing" });

      const junction = path.join(temp, "junction");
      await symlink(privateDir, junction, "junction");
      expect(inspectAndEvaluatePathSecurity(inspectNativePathSecurity, junction, "directory"))
        .toEqual({ ok: false, violation: "reparse-point" });

      // Grant Everyone write on one disposable file only.
      const exposed = path.join(privateDir, "exposed.json");
      await writeFile(exposed, "{}\n");
      execFileSync("icacls", [exposed, "/grant", "*S-1-1-0:(W)"], { stdio: "ignore" });
      expect(inspectAndEvaluatePathSecurity(inspectNativePathSecurity, exposed, "file"))
        .toEqual({ ok: false, violation: "foreign-writer" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
