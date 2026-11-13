/**
 * Process entry for the production Collector Host (`org.maginalia.collector`).
 *
 * - Node: `node dist/main/collector-native-host-product-entry.js <origin>`
 * - Standalone executable: the Node SEA is a bundle of this file
 *   (`npm run package:windows:collector-host`).
 *
 * Both forms put Chrome's first argument (the caller origin) at `argv[2]`; in the SEA
 * `argv[1]` repeats the executable path. The addon location is a code location: next
 * to the executable for the SEA, the compiled checkout layout otherwise. Nothing here
 * reads environment variables, the working directory or a descriptor.
 */
import { collectorCallerOrigin, runCollectorProductHost } from "./collector-native-host-product.js";

function runningAsSingleExecutable(): boolean {
  try {
    return (require("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

void runCollectorProductHost({
  origin: collectorCallerOrigin(process.argv, 2),
  addonLocation: runningAsSingleExecutable() ? "sea" : "module",
}).catch(() => {
  process.stderr.write("Collector host failed.\n");
  process.exitCode = 1;
});
