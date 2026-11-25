import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDestinationInsideRoot,
  comparablePath,
  E2E_ISOLATION_EXIT_CODE,
  E2E_ISOLATION_MARKER_FILE,
  E2E_ISOLATION_MARKER_KIND,
  E2E_ISOLATION_ROOT_ENV,
  E2EIsolationError,
  enforceE2EIsolationBeforeStartup,
  establishE2EIsolation,
  isStrictlyInside,
  validateIsolationRoot,
  type E2EIsolationApp,
} from "./e2e-isolation";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(E2EIsolationError);
    expect((error as E2EIsolationError).code).toBe(code);
    return;
  }
  throw new Error(`expected E2EIsolationError ${code}`);
}

let base: string;
let root: string;
/** The temporary directory as the OS reported it (may use 8.3 short names). */
let reportedBase: string;

function prepareRoot(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, E2E_ISOLATION_MARKER_FILE), JSON.stringify({ kind: E2E_ISOLATION_MARKER_KIND, version: 1 }));
  for (const name of ["userData", "Downloads", "Documents", "evidence"]) mkdirSync(path.join(directory, name), { recursive: true });
}

beforeEach(() => {
  reportedBase = mkdtempSync(path.join(os.tmpdir(), "maginalia-e2e-isolation-日本語-"));
  // Compare against the on-disk spelling; a dedicated test covers short names.
  base = realpathSync.native(reportedBase);
  root = path.join(base, "root");
  prepareRoot(root);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("path comparison", () => {
  it("treats Windows paths case-insensitively and ignores trailing separators", () => {
    expect(comparablePath("C:\\Tmp\\Root\\", "win32")).toBe("c:\\tmp\\root");
    expect(isStrictlyInside("C:\\Tmp\\Root", "c:\\TMP\\root\\userData", "win32")).toBe(true);
    expect(isStrictlyInside("c:\\tmp\\root", "C:/Tmp/Root/Downloads/x", "win32")).toBe(true);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(isStrictlyInside("/tmp/root", "/tmp/Root/userData", "linux")).toBe(false);
    expect(isStrictlyInside("/tmp/root", "/tmp/root/userData", "linux")).toBe(true);
  });

  it("does not treat the root itself, a sibling with the same prefix, or a parent escape as inside", () => {
    expect(isStrictlyInside("C:\\tmp\\root", "C:\\tmp\\root", "win32")).toBe(false);
    expect(isStrictlyInside("C:\\tmp\\root", "C:\\tmp\\root-evil\\userData", "win32")).toBe(false);
    expect(isStrictlyInside("C:\\tmp\\root", "C:\\tmp\\root\\..\\other", "win32")).toBe(false);
    expect(isStrictlyInside("C:\\tmp\\root", "D:\\tmp\\root\\userData", "win32")).toBe(false);
  });
});

describe("validateIsolationRoot", () => {
  it("accepts a marked absolute directory and returns its canonical spelling", () => {
    const validated = validateIsolationRoot(root);
    expect(comparablePath(validated.root)).toBe(comparablePath(path.resolve(root)));
  });

  it("rejects a missing, relative, drive-relative, UNC or device root", () => {
    expectCode(() => validateIsolationRoot(undefined), "root-missing");
    expectCode(() => validateIsolationRoot(""), "root-missing");
    expectCode(() => validateIsolationRoot("relative\\root", { platform: "win32" }), "root-not-absolute");
    expectCode(() => validateIsolationRoot("relative/root", { platform: "linux" }), "root-not-absolute");
    expectCode(() => validateIsolationRoot("C:relative", { platform: "win32" }), "root-not-absolute");
    expectCode(() => validateIsolationRoot("\\\\server\\share\\root", { platform: "win32" }), "root-unsupported-form");
    expectCode(() => validateIsolationRoot("\\\\?\\C:\\root", { platform: "win32" }), "root-unsupported-form");
    expectCode(() => validateIsolationRoot("\\\\.\\C:\\root", { platform: "win32" }), "root-unsupported-form");
    expectCode(() => validateIsolationRoot(` ${root}`), "root-not-absolute");
  });

  it("rejects parent-directory segments even when they resolve back inside", () => {
    expectCode(() => validateIsolationRoot(path.join(root, "userData") + path.sep + ".." ), "root-unsupported-form");
  });

  it("rejects a filesystem root and a root that contains a protected location", () => {
    expectCode(() => validateIsolationRoot(path.parse(root).root), "root-too-broad");
    expectCode(() => validateIsolationRoot(root, { protectedPaths: [path.join(root, "home", "user")] }), "root-too-broad");
    expectCode(() => validateIsolationRoot(root, { protectedPaths: [root] }), "root-too-broad");
    expect(validateIsolationRoot(root, { protectedPaths: [base + "-elsewhere"] }).root).toBeTruthy();
  });

  it("rejects a root without a valid harness marker", () => {
    const unmarked = path.join(base, "unmarked");
    mkdirSync(unmarked);
    expectCode(() => validateIsolationRoot(unmarked), "root-marker-invalid");
    writeFileSync(path.join(unmarked, E2E_ISOLATION_MARKER_FILE), "not json");
    expectCode(() => validateIsolationRoot(unmarked), "root-marker-invalid");
    writeFileSync(path.join(unmarked, E2E_ISOLATION_MARKER_FILE), JSON.stringify({ kind: "other", version: 1 }));
    expectCode(() => validateIsolationRoot(unmarked), "root-marker-invalid");
  });

  it("rejects a file root", () => {
    const file = path.join(base, "file-root");
    writeFileSync(file, "x");
    expectCode(() => validateIsolationRoot(file), "root-not-directory");
  });

  it("rejects a root that is a junction, or that is reached through a junction", () => {
    const junction = path.join(base, "junction-root");
    symlinkSync(root, junction, "junction");
    expectCode(() => validateIsolationRoot(junction), "root-reparse-point");
    const parentJunction = path.join(base, "parent-junction");
    symlinkSync(base, parentJunction, "junction");
    expectCode(() => validateIsolationRoot(path.join(parentJunction, "root")), "root-reparse-point");
  });

  it("accepts the OS-reported temporary spelling (for example 8.3 short names) and canonicalizes it", () => {
    const reportedRoot = path.join(reportedBase, "root");
    const validated = validateIsolationRoot(reportedRoot);
    expect(comparablePath(validated.root)).toBe(comparablePath(root));
    expect(comparablePath(assertDestinationInsideRoot(validated, "userData", path.join(reportedRoot, "userData")))).toBe(comparablePath(path.join(root, "userData")));
  });

  it.runIf(process.platform === "win32")("accepts a root spelled with different case and returns the on-disk spelling", () => {
    const upper = root.toUpperCase();
    const validated = validateIsolationRoot(upper);
    expect(validated.root).not.toBe(upper);
    expect(comparablePath(validated.root)).toBe(comparablePath(root));
  });
});

describe("assertDestinationInsideRoot", () => {
  it("accepts existing and not-yet-created destinations strictly inside the root", () => {
    const isolation = validateIsolationRoot(root);
    expect(comparablePath(assertDestinationInsideRoot(isolation, "userData", path.join(root, "userData")))).toBe(comparablePath(path.join(root, "userData")));
    expect(comparablePath(assertDestinationInsideRoot(isolation, "Shelf", path.join(root, "Shelf", "本棚", "new")))).toBe(comparablePath(path.join(root, "Shelf", "本棚", "new")));
  });

  it("rejects the root itself, outside paths and prefix siblings", () => {
    const isolation = validateIsolationRoot(root);
    expectCode(() => assertDestinationInsideRoot(isolation, "x", root), "destination-outside-root");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", path.join(base, "outside")), "destination-outside-root");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", `${root}-evil${path.sep}userData`), "destination-outside-root");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", path.join(os.homedir(), "AppData", "Roaming", "Electron")), "destination-outside-root");
  });

  it("rejects relative destinations and parent-directory escapes", () => {
    const isolation = validateIsolationRoot(root);
    expectCode(() => assertDestinationInsideRoot(isolation, "x", "userData"), "destination-not-absolute");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", `.${path.sep}userData`), "destination-not-absolute");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", `${root}${path.sep}..${path.sep}outside`), "destination-unsupported-form");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", undefined), "destination-not-absolute");
  });

  it("rejects a junction inside the root that points outside, and one that points back inside", () => {
    const isolation = validateIsolationRoot(root);
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    const escape = path.join(root, "escape");
    symlinkSync(outside, escape, "junction");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", path.join(escape, "Downloads")), "destination-reparse-point");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", escape), "destination-reparse-point");
    const loop = path.join(root, "loop");
    symlinkSync(path.join(root, "Downloads"), loop, "junction");
    expectCode(() => assertDestinationInsideRoot(isolation, "x", loop), "destination-reparse-point");
  });

  it.runIf(process.platform === "win32")("accepts case differences inside the root on Windows", () => {
    const isolation = validateIsolationRoot(root);
    const spelled = path.join(root.toUpperCase(), "USERDATA");
    expect(comparablePath(assertDestinationInsideRoot(isolation, "userData", spelled))).toBe(comparablePath(path.join(root, "userData")));
  });

  it("can require the destination to exist", () => {
    const isolation = validateIsolationRoot(root);
    expectCode(() => assertDestinationInsideRoot(isolation, "x", path.join(root, "absent"), { mustExist: true }), "destination-missing");
  });
});

class FakeApp implements E2EIsolationApp {
  readonly paths: Record<string, string>;
  readonly setCalls: string[] = [];
  constructor(userData: string) {
    this.paths = { userData, downloads: path.join(os.homedir(), "Downloads"), documents: path.join(os.homedir(), "Documents"), home: os.homedir(), appData: path.join(os.homedir(), "AppData", "Roaming") };
  }
  getPath(name: "userData" | "downloads" | "documents" | "home" | "appData"): string {
    return this.paths[name]!;
  }
  setPath(name: "downloads" | "documents", value: string): void {
    this.setCalls.push(name);
    this.paths[name] = value;
  }
}

describe("establishE2EIsolation", () => {
  it("is inert and reads nothing when the gate variable is absent", () => {
    const app = new FakeApp("Z:\\never\\read");
    expect(establishE2EIsolation(app, { env: {} })).toBeUndefined();
    expect(app.setCalls).toEqual([]);
  });

  it("verifies userData, redirects Downloads/Documents into the root, and writes evidence inside it", () => {
    const app = new FakeApp(path.join(root, "userData"));
    const logs: string[] = [];
    const state = establishE2EIsolation(app, { env: { [E2E_ISOLATION_ROOT_ENV]: root, MAGINALIA_FIRST_RUN_SMOKE_SHELF: path.join(root, "Shelf") }, log: (line) => logs.push(line) });
    expect(state).toBeDefined();
    expect(comparablePath(app.getPath("downloads"))).toBe(comparablePath(path.join(root, "Downloads")));
    expect(comparablePath(app.getPath("documents"))).toBe(comparablePath(path.join(root, "Documents")));
    expect(Object.keys(state!.guardedEnvironment)).toEqual(["MAGINALIA_FIRST_RUN_SMOKE_SHELF"]);
    expect(readdirSync(path.join(root, "evidence")).some((name) => name.startsWith("startup-isolation-"))).toBe(true);
    expect(logs[0]).toMatch(/^MAGINALIA_E2E_ISOLATION_OK /u);
  });

  it("fails before redirecting anything when Electron fell back to a userData outside the root (the #93 first-launch case)", () => {
    const app = new FakeApp(path.join(os.homedir(), "AppData", "Roaming", "Electron"));
    expectCode(() => establishE2EIsolation(app, { env: { [E2E_ISOLATION_ROOT_ENV]: root } }), "destination-outside-root");
    expect(app.setCalls).toEqual([]);
    expect(readdirSync(path.join(root, "evidence"))).toEqual([]);
  });

  it("fails when an explicit smoke Workdesk/Shelf/Downloads path is outside the root", () => {
    const app = new FakeApp(path.join(root, "userData"));
    expectCode(() => establishE2EIsolation(app, { env: { [E2E_ISOLATION_ROOT_ENV]: root, MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS: path.join(os.homedir(), "Downloads") } }), "destination-outside-root");
    expect(app.setCalls).toEqual([]);
  });

  it("fails when the gate is set but empty, or the harness did not prepare Downloads", () => {
    const app = new FakeApp(path.join(root, "userData"));
    expectCode(() => establishE2EIsolation(app, { env: { [E2E_ISOLATION_ROOT_ENV]: "" } }), "root-missing");
    rmSync(path.join(root, "Downloads"), { recursive: true });
    expectCode(() => establishE2EIsolation(app, { env: { [E2E_ISOLATION_ROOT_ENV]: root } }), "destination-missing");
    expect(existsSync(path.join(root, "Downloads"))).toBe(false);
  });

  it("the startup hook exits with code 78 on failure", () => {
    const previous = process.env[E2E_ISOLATION_ROOT_ENV];
    process.env[E2E_ISOLATION_ROOT_ENV] = path.join(base, "not-a-root");
    try {
      const app = new FakeApp(path.join(root, "userData"));
      let exitCode: number | undefined;
      expect(() => enforceE2EIsolationBeforeStartup(app, (code) => { exitCode = code; throw new Error("exit"); })).toThrow("exit");
      expect(exitCode).toBe(E2E_ISOLATION_EXIT_CODE);
    } finally {
      if (previous === undefined) delete process.env[E2E_ISOLATION_ROOT_ENV];
      else process.env[E2E_ISOLATION_ROOT_ENV] = previous;
    }
  });
});
