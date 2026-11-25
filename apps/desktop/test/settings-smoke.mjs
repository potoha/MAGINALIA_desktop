import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const root = await mkdtemp(path.join(tmpdir(), "maginalia-settings-smoke-"));
try {
  const fixture = path.join(root, "日本語の設定確認.md");
  await writeFile(fixture, "\uFEFF# 設定とキー割り当て\r\n\r\n原稿の本文を保持します。\r\n", "utf8");
  const userDataRoot = path.join(root, "profile");
  for (const mode of ["--smoke-settings", "--smoke-settings-restore"]) {
    const result = await runElectronSmoke({
      userDataRoot,
      appArgs: [mode, "--smoke-writing", fixture],
      timeoutMs: 90_000
    });
    assertElectronSmokeMarker(result, "MAGINALIA_SETTINGS_SMOKE_OK", "Electron Settings smoke");
    process.stdout.write(result.stdout + result.stderr);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  // Only this harness's generated temporary root is removed.
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("maginalia-settings-smoke-")) {
    throw new Error("Unexpected Settings smoke cleanup target");
  }
  await rm(root, { recursive: true, force: true });
}
