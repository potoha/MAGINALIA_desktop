import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLECTOR_CONTACT_MIN_INTERVAL_MS,
  COLLECTOR_CONTACT_RECORD_FILENAME,
  createCollectorContactRecorder,
  type CollectorContactValues,
} from "./collector-contact-record";
import {
  createCollectorFixture,
  fakeSafeInspector,
  safeFacts,
  type CollectorFixture,
} from "./collector-host-fixture.test-helper";

const protocol = "maginalia.collector.experimental.v1";
const values: CollectorContactValues = { protocol, hostVersion: "0.2.0", extensionVersion: "0.3.0" };

let fixture: CollectorFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

async function withIntegrationFolder(): Promise<{ current: CollectorFixture; file: string; folder: string }> {
  const current = await createCollectorFixture();
  fixture = current;
  await mkdir(current.storage.bindingDirectory, { recursive: true });
  return { current, file: path.join(current.storage.bindingDirectory, COLLECTOR_CONTACT_RECORD_FILENAME), folder: current.storage.bindingDirectory };
}

function clock(start: string): { now: () => Date; advance(ms: number): void } {
  let time = Date.parse(start);
  return { now: () => new Date(time), advance: (ms) => { time += ms; } };
}

describe("Collector contact record", () => {
  it("writes exactly the five documented fields and leaves no temp file", async () => {
    const { current, file, folder } = await withIntegrationFolder();
    const time = clock("2026-11-13T09:00:00.000Z");
    const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: fakeSafeInspector, now: time.now });
    expect(await record(values)).toBe("written");
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toEqual({
      version: 1, protocol, hostVersion: "0.2.0", extensionVersion: "0.3.0", contactedAt: "2026-11-13T09:00:00.000Z",
    });
    expect(Object.keys(JSON.parse(text))).toEqual(["version", "protocol", "hostVersion", "extensionVersion", "contactedAt"]);
    expect(text).not.toContain(current.temp);
    expect(await readdir(folder)).toEqual([COLLECTOR_CONTACT_RECORD_FILENAME]);
  });

  it("is rate limited to once per 60 s unless a value changed", async () => {
    const { current, file } = await withIntegrationFolder();
    const time = clock("2026-11-13T09:00:00.000Z");
    const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: fakeSafeInspector, now: time.now });
    expect(await record(values)).toBe("written");
    time.advance(COLLECTOR_CONTACT_MIN_INTERVAL_MS - 1);
    expect(await record(values)).toBe("skipped");
    expect(JSON.parse(await readFile(file, "utf8")).contactedAt).toBe("2026-11-13T09:00:00.000Z");
    // A changed value is written immediately.
    expect(await record({ ...values, extensionVersion: "0.3.1" })).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ extensionVersion: "0.3.1", contactedAt: "2026-11-13T09:00:59.999Z" });
    expect(await record({ ...values, extensionVersion: "0.3.1" })).toBe("skipped");
    time.advance(COLLECTOR_CONTACT_MIN_INTERVAL_MS);
    expect(await record({ ...values, extensionVersion: "0.3.1" })).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8")).contactedAt).toBe("2026-11-13T09:01:59.999Z");
  });

  it("replaces a malformed or future-dated record but never a non-regular entry", async () => {
    const { current, file, folder } = await withIntegrationFolder();
    const time = clock("2026-11-13T09:00:00.000Z");
    const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: fakeSafeInspector, now: time.now });
    await writeFile(file, "not json");
    expect(await record(values)).toBe("written");
    await writeFile(file, JSON.stringify({ version: 1, ...values, contactedAt: "2030-01-01T00:00:00.000Z" }));
    expect(await record(values)).toBe("written");
    await rm(file);

    // A directory in the final position is refused and left intact.
    await mkdir(file);
    expect(await record(values)).toBe("skipped");
    expect(await readdir(folder)).toEqual([COLLECTOR_CONTACT_RECORD_FILENAME]);
    await rm(file, { recursive: true });

    // A link in the final position is never followed; its target is not modified.
    const target = path.join(current.temp, "link-target");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "keep");
    let linked = true;
    try { await symlink(target, file, "junction"); } catch { linked = false; }
    if (linked) {
      expect(await record(values)).toBe("skipped");
      expect(await readdir(target)).toEqual(["keep.txt"]);
      expect(await readdir(folder)).toEqual([COLLECTOR_CONTACT_RECORD_FILENAME]);
    }
  });

  it("does the same bounded work for an oversize existing record and rewrites it", async () => {
    const { current, file, folder } = await withIntegrationFolder();
    const time = clock("2026-11-13T09:00:00.000Z");
    const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: fakeSafeInspector, now: time.now });
    // A valid-looking record padded far beyond the 4 KiB limit is never parsed.
    const padded = JSON.stringify({ version: 1, ...values, contactedAt: "2026-11-13T09:00:00.000Z", pad: "x".repeat(64 * 1024 * 1024) });
    await writeFile(file, padded);
    const started = Date.now();
    expect(await record(values)).toBe("written");
    expect(Date.now() - started).toBeLessThan(5_000);
    const text = await readFile(file, "utf8");
    expect(text.length).toBeLessThan(1024);
    expect(Object.keys(JSON.parse(text))).toEqual(["version", "protocol", "hostVersion", "extensionVersion", "contactedAt"]);
    expect(await readdir(folder)).toEqual([COLLECTOR_CONTACT_RECORD_FILENAME]);
  });

  it("skips silently when the integration folder is missing and does not create it", async () => {
    const current = await createCollectorFixture();
    fixture = current;
    const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: fakeSafeInspector });
    expect(await record(values)).toBe("skipped");
    expect(await readdir(current.localAppData)).toEqual([]);
    await mkdir(path.dirname(current.storage.bindingDirectory));
    expect(await record(values)).toBe("skipped");
    expect(await readdir(path.dirname(current.storage.bindingDirectory))).toEqual([]);
  });

  it("skips when the ownership/ACL check fails for the application root or integration folder", async () => {
    const { current, folder } = await withIntegrationFolder();
    const applicationRoot = path.dirname(folder);
    const foreignWriter = (bad: string) => (target: string) => {
      const facts = fakeSafeInspector(target);
      if (!facts.exists || path.resolve(target) !== path.resolve(bad)) return facts;
      return { ...facts, aces: [...facts.aces, { type: "allow" as const, sid: "S-1-1-0", mask: 0x2, inheritOnly: false }] };
    };
    const reparse = (bad: string) => (target: string) => {
      const facts = fakeSafeInspector(target);
      return facts.exists && path.resolve(target) === path.resolve(bad) ? { ...facts, isReparsePoint: true } : facts;
    };
    const otherOwner = () => ({ ...safeFacts(true), ownerSid: "S-1-5-21-9-9-9-1" });
    const inspectors: readonly ((target: string) => unknown)[] = [
      foreignWriter(folder), foreignWriter(applicationRoot), reparse(folder), reparse(applicationRoot), otherOwner,
      () => { throw new Error("addon failure"); }, () => ({ exists: false }), () => "garbage",
    ];
    for (const inspector of inspectors) {
      const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: inspector });
      expect(await record(values)).toBe("skipped");
      expect(await readdir(folder)).toEqual([]);
    }
  });

  it("does not require a Shelf binding file", async () => {
    const { current, folder } = await withIntegrationFolder();
    expect(await readdir(folder)).toEqual([]);
    const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: fakeSafeInspector });
    expect(await record(values)).toBe("written");
  });

  it("is atomic: a failure before the rename leaves no temp file and keeps the previous record", async () => {
    const { current, file, folder } = await withIntegrationFolder();
    const time = clock("2026-11-13T09:00:00.000Z");
    const base = { resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: fakeSafeInspector, now: time.now };
    expect(await createCollectorContactRecorder(base)(values)).toBe("written");
    const before = await readFile(file, "utf8");
    time.advance(COLLECTOR_CONTACT_MIN_INTERVAL_MS);
    const failing = createCollectorContactRecorder({ ...base, beforeRename: async () => { throw new Error("injected"); } });
    expect(await failing(values)).toBe("skipped");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(folder)).toEqual([COLLECTOR_CONTACT_RECORD_FILENAME]);
    await rm(file);
    expect(await failing(values)).toBe("skipped");
    expect(await readdir(folder)).toEqual([]);
  });

  it("never throws for an unsupported LocalAppData location", async () => {
    const record = createCollectorContactRecorder({ resolveLocalAppDataPath: () => { throw new Error("no known folder"); }, inspectPathSecurity: fakeSafeInspector });
    expect(await record(values)).toBe("skipped");
    const relative = createCollectorContactRecorder({ resolveLocalAppDataPath: () => "relative\\path", inspectPathSecurity: fakeSafeInspector });
    expect(await relative(values)).toBe("skipped");
  });
});
