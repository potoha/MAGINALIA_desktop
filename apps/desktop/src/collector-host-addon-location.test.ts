import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SEA_ADDON_FILENAME, resolveProductNativeAddonCandidates } from "./shelf-native-mutex";

describe("production Collector Host addon location", () => {
  it("uses exactly the file next to the standalone executable", () => {
    const executable = path.join(path.parse(process.cwd()).root, "Programs", "MAGINALIA Collector Host", "MAGINALIA-Collector-Host.exe");
    expect(resolveProductNativeAddonCandidates("sea", { executablePath: executable, moduleDirectory: "ignored" })).toEqual({
      mode: "product-sea",
      candidates: [path.join(path.dirname(executable), SEA_ADDON_FILENAME)],
    });
    expect(resolveProductNativeAddonCandidates("sea", {})).toEqual({ mode: "product-sea", candidates: [] });
  });

  it("uses exactly the compiled checkout layout for the Node product entry", () => {
    const moduleDirectory = path.join(process.cwd(), "dist", "main");
    expect(resolveProductNativeAddonCandidates("module", { moduleDirectory, executablePath: "ignored" })).toEqual({
      mode: "product-module",
      candidates: [path.join(process.cwd(), "native", "shelf-mutex", "build", "Release", "shelf_mutex.node")],
    });
    expect(resolveProductNativeAddonCandidates("module", {})).toEqual({ mode: "product-module", candidates: [] });
  });
});
