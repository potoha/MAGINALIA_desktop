/**
 * Opt-in runner for the registry test-seam suite of `src/windows-integration.test.ts`.
 *
 * The suite registers/unregisters through the separate test-seam addon build, but it still
 * WRITES to the real HKCU (a private, randomly named `Software\MAGINALIA-Tests\<uuid>` subkey,
 * removed afterwards; the real Chrome NativeMessagingHosts key is never touched). A normal
 * `npm test` therefore skips it. Run this script on a developer machine only, never in CI.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const vitestBin = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const child = spawn(process.execPath, [vitestBin, "run", "--config", "vitest.config.mts", "src/windows-integration.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, MAGINALIA_RUN_REGISTRY_SEAM_TESTS: "1" },
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
