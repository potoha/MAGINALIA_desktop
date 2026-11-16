/**
 * Test-only harness for the production Collector Host core.
 *
 * The production entry (`dist/main/collector-native-host-product.js`) has no injection
 * surface by design, so it can only be run against the real per-user LocalAppData. This
 * harness runs the same `runCollectorProductHost` loop, with the same stdin/stdout
 * framing and the same writer, in a separate OS process, but injects a disposable
 * LocalAppData root. It is never packaged or registered as a Native Messaging Host.
 *
 * argv[2]: JSON command file { localAppData, origin, acquireTimeoutMs? }
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "main");
const product = require(path.join(main, "collector-native-host-product.js"));
const configuration = require(path.join(main, "collector-shelf-configuration.js"));
const nativeMutex = require(path.join(main, "shelf-native-mutex.js"));
const contact = require(path.join(main, "collector-contact-record.js"));
const writer = require(path.join(main, "shelf-native-write-lock.js"));

const command = JSON.parse(await readFile(process.argv[2], "utf8"));
await product.runCollectorProductHost({
  origin: command.origin,
  addonLocation: "module",
  dependencies: {
    readConfiguration: () => configuration.readCollectorShelfConfiguration({
      resolveLocalAppDataPath: () => command.localAppData,
      inspectPathSecurity: nativeMutex.inspectNativePathSecurity,
    }),
    writeQuote: (request) => writer.commitShelfQuoteWithNativeLock(
      request,
      command.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: command.acquireTimeoutMs },
    ),
    // Same recorder as production, bound to the disposable LocalAppData root.
    recordContact: contact.createCollectorContactRecorder({
      resolveLocalAppDataPath: () => command.localAppData,
      inspectPathSecurity: nativeMutex.inspectNativePathSecurity,
    }),
  },
});
