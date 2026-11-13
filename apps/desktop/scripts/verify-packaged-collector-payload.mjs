/**
 * Verify, read-only, that a built Windows package (`win-unpacked`, the tree NSIS wraps)
 * carries the Collector payload exactly as `collector-payload.json` describes it.
 *
 * Usage: node scripts/verify-packaged-collector-payload.mjs <absolute win-unpacked directory> [result.json]
 *
 * Checks (design §2.1, WP-4 acceptance):
 *   - `<resources>/collector-payload.json` is valid and matches the pinned Collector version,
 *     extension ID and ZIP SHA-256 in runtime-versions.json, and the Host's compiled ID constant;
 *   - `<resources>/collector-host/` holds exactly the expected regular files; the Host exe and
 *     addon SHA-256 equal the descriptor, and the addon equals `<resources>/shelf-mutex/shelf_mutex.node`;
 *   - `<resources>/collector-extension/` holds exactly the descriptor's files with matching SHA-256,
 *     and its manifest.json has the descriptor version and a key deriving the descriptor ID;
 *   - no entry is a symbolic link or other non-regular file.
 * It executes nothing and writes nothing except the optional result file.
 */
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_ADDON, HOST_EXECUTABLE, deriveExtensionId, readCollectorPin, sha256, validateDescriptor } from "./collector-payload.mjs";
import { DESCRIPTOR_FILE_NAME, EXTENSION_RESOURCE_DIRECTORY, HOST_RESOURCE_DIRECTORY, HOST_RESOURCE_FILES, readHostExtensionId } from "./stage-collector-payload.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function regularFileNames(directory) {
  const entries = await readdir(directory);
  for (const name of entries) {
    const info = await lstat(path.join(directory, name));
    check(info.isFile() && !info.isSymbolicLink(), `${path.basename(directory)}/${name} is not a regular file`);
  }
  return entries.sort();
}

/** Verify a `<resources>` directory. Exported for tests. */
export async function verifyCollectorResources(resources, { pin, hostExtensionId }) {
  const descriptorInfo = await lstat(path.join(resources, DESCRIPTOR_FILE_NAME));
  check(descriptorInfo.isFile() && !descriptorInfo.isSymbolicLink(), `${DESCRIPTOR_FILE_NAME} is not a regular file`);
  const descriptor = validateDescriptor(JSON.parse(await readFile(path.join(resources, DESCRIPTOR_FILE_NAME), "utf8")));
  check(descriptor.extension.version === pin.version, "descriptor extension version does not match the pin");
  check(descriptor.extension.id === pin.extensionId, "descriptor extension ID does not match the pin");
  check(descriptor.extension.zipSha256 === pin.sha256, "descriptor ZIP SHA-256 does not match the pin");
  check(hostExtensionId === undefined || descriptor.extension.id === hostExtensionId, "descriptor extension ID does not match the Host constant");
  check(JSON.stringify(Object.keys(descriptor.extension.files).sort()) === JSON.stringify([...pin.files].sort()), "descriptor extension file list does not match the pinned list");

  const hostDirectory = path.join(resources, HOST_RESOURCE_DIRECTORY);
  const hostNames = await regularFileNames(hostDirectory);
  check(JSON.stringify(hostNames) === JSON.stringify([...HOST_RESOURCE_FILES].sort()), `collector-host must hold exactly: ${HOST_RESOURCE_FILES.join(", ")}`);
  const hostBytes = {};
  for (const name of [HOST_EXECUTABLE, HOST_ADDON]) {
    hostBytes[name] = await readFile(path.join(hostDirectory, name));
    check(sha256(hostBytes[name]) === descriptor.host.files[name], `${name} does not match collector-payload.json`);
  }
  const shelfMutex = await readFile(path.join(resources, "shelf-mutex", HOST_ADDON));
  check(sha256(shelfMutex) === descriptor.host.files[HOST_ADDON], "the Host addon is not the same build as <resources>/shelf-mutex/shelf_mutex.node");

  const extensionDirectory = path.join(resources, EXTENSION_RESOURCE_DIRECTORY);
  const extensionNames = await regularFileNames(extensionDirectory);
  check(JSON.stringify(extensionNames) === JSON.stringify(Object.keys(descriptor.extension.files).sort()), "collector-extension does not hold exactly the descriptor files");
  for (const name of extensionNames) {
    check(sha256(await readFile(path.join(extensionDirectory, name))) === descriptor.extension.files[name], `collector-extension/${name} does not match collector-payload.json`);
  }
  const manifest = JSON.parse(await readFile(path.join(extensionDirectory, "manifest.json"), "utf8"));
  check(manifest.version === descriptor.extension.version, "extension manifest version does not match the descriptor");
  check(deriveExtensionId(manifest.key) === descriptor.extension.id, "extension manifest key does not derive the descriptor ID");
  return { descriptor, hostBytes: Object.fromEntries(Object.entries(hostBytes).map(([name, bytes]) => [name, bytes.length])) };
}

async function main() {
  const [unpackedArgument, resultPath] = process.argv.slice(2);
  check(unpackedArgument && path.isAbsolute(unpackedArgument), "usage: verify-packaged-collector-payload.mjs <absolute win-unpacked directory> [result.json]");
  const resources = path.join(path.resolve(unpackedArgument), "resources");
  const pin = readCollectorPin(JSON.parse(await readFile(path.join(desktopRoot, "packaging", "runtime-versions.json"), "utf8")));
  const { descriptor, hostBytes } = await verifyCollectorResources(resources, { pin, hostExtensionId: await readHostExtensionId(desktopRoot) });
  const output = {
    status: "PASS",
    verified: "win-unpacked directory package (not an NSIS installation); read-only, nothing executed",
    payloadId: descriptor.payloadId,
    hostBytes,
    descriptor,
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (resultPath) await writeFile(resultPath, text, "utf8");
  process.stdout.write(text);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`verify-packaged-collector-payload: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
