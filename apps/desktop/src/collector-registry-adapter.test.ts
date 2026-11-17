/**
 * The in-memory fake must validate its inputs exactly like the product adapter (same shared
 * patterns and policy-root enumeration), so a test cannot pass with an argument production rejects.
 */
import { describe, expect, it } from "vitest";
import { FakeCollectorRegistryAdapter } from "./collector-registry-adapter.test-helper.js";

describe("FakeCollectorRegistryAdapter input validation (mirrors the product adapter)", () => {
  it("rejects a policy root outside the enumeration and accepts the two fixed ones", () => {
    const fake = new FakeCollectorRegistryAdapter();
    for (const bad of ["", "Google\\Chrome\\Extra", "..\\Chrome", "Mozilla\\Firefox", 5]) {
      expect(() => fake.readBrowserPolicies(bad as never), String(bad)).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    }
    expect(fake.readBrowserPolicies("Google\\Chrome").hkcu.hive).toBe("HKCU");
    expect(fake.readBrowserPolicies("Microsoft\\Edge").hklm.hive).toBe("HKLM");
  });

  it("rejects an App Paths name that is not a bare *.exe file name", () => {
    const fake = new FakeCollectorRegistryAdapter();
    for (const bad of ["", "chrome", "..\\chrome.exe", "a/b.exe", "a\0.exe", ".exe", `${"x".repeat(70)}.exe`, 5]) {
      expect(() => fake.readBrowserAppPaths(bad as never), String(bad)).toThrow(expect.objectContaining({ code: "windows-integration-invalid-argument" }));
    }
    expect(fake.readBrowserAppPaths("msedge.exe")).toEqual([]);
  });

  it("yields no command for a ProgId that is not a plain name", () => {
    const fake = new FakeCollectorRegistryAdapter();
    fake.progIdOpenCommands["Evil\\Prog"] = "x";
    fake.progIdOpenCommands["ChromeHTML"] = "chrome.exe";
    expect(fake.readProgIdOpenCommand("Evil\\Prog")).toBeNull();
    expect(fake.readProgIdOpenCommand("")).toBeNull();
    expect(fake.readProgIdOpenCommand("ChromeHTML")).toBe("chrome.exe");
  });

  it("reports which key the default ProgId came from", () => {
    const fake = new FakeCollectorRegistryAdapter();
    expect(fake.readDefaultBrowserProgId()).toBeNull();
    fake.defaultBrowserProgId = "VivaldiHTM";
    expect(fake.readDefaultBrowserProgId()).toEqual({ progId: "VivaldiHTM", source: "user-choice" });
    fake.defaultBrowserProgIdSource = "user-choice-latest";
    expect(fake.readDefaultBrowserProgId()).toEqual({ progId: "VivaldiHTM", source: "user-choice-latest" });
  });
});
