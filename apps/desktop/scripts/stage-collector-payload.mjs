/**
 * Collector payload staging (WP-4, design §2.1/§2.2).
 *
 * Inputs:
 *   - the Host payload built by `build-collector-host.mjs` (release/collector-host/payload);
 *   - the pinned Collector release ZIP (runtime-versions.json `collectorExtension`),
 *     downloaded from the pinned URL or, for a release that is not published yet, read from
 *     an explicit local path given with the build-time flag `--collector-zip <absolute path>`.
 *     A local ZIP is verified against the same pinned SHA-256; there is no unpinned mode and
 *     no environment-variable or runtime override.
 *
 * Output (under `packaging/runtime/`, consumed by electron-builder `extraResources`):
 *   collector-host/        Host exe, shelf_mutex.node, LICENSE/NOTICE/NODE-LICENSE/PROVENANCE
 *   collector-extension/   the exact release file list, verbatim bytes
 *   collector-payload.json descriptor (hashes), informational copy of the compiled constants
 *
 * Fails closed on any mismatch (ZIP hash, entry set, manifest version, derived extension
 * ID versus pin and versus the Host's COLLECTOR_EXTENSION_ID constant, Host/addon hashes).
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  HOST_ADDON, HOST_EXECUTABLE, buildDescriptor, loadCollectorZip, readCollectorPin, sha256, verifyCollectorExtension,
} from "./collector-payload.mjs";

export const HOST_RESOURCE_DIRECTORY = "collector-host";
export const EXTENSION_RESOURCE_DIRECTORY = "collector-extension";
export const DESCRIPTOR_FILE_NAME = "collector-payload.json";
/** Files shipped in `<resources>/collector-host/` (design §2.1). */
export const HOST_RESOURCE_FILES = Object.freeze([HOST_EXECUTABLE, HOST_ADDON, "LICENSE.txt", "NOTICE.txt", "NODE-LICENSE.txt", "PROVENANCE.txt"]);

/** The Host's compiled extension ID constant is the single source of truth for the ID. */
export async function readHostExtensionId(desktopRoot) {
  const source = await readFile(path.join(desktopRoot, "src", "collector-native-host-product.ts"), "utf8");
  const id = /COLLECTOR_EXTENSION_ID = "([a-p]{32})"/u.exec(source)?.[1];
  if (!id) throw new Error("The Collector extension ID constant was not found in collector-native-host-product.ts.");
  return id;
}

export async function stageCollectorPayload({ desktopRoot, runtimeRoot, localZip, shelfMutexSha256 }) {
  const packagingRoot = path.join(desktopRoot, "packaging");
  const pin = readCollectorPin(JSON.parse(await readFile(path.join(packagingRoot, "runtime-versions.json"), "utf8")));
  const hostPayload = path.join(desktopRoot, "release", "collector-host", "payload");
  const hostFiles = new Map();
  for (const name of HOST_RESOURCE_FILES) {
    hostFiles.set(name, await readFile(path.join(hostPayload, name)).catch(() => {
      throw new Error(`The Collector Host payload is incomplete (missing ${name}); run npm run package:windows:collector-host first.`);
    }));
  }
  const addonSha256 = sha256(hostFiles.get(HOST_ADDON));
  if (shelfMutexSha256 !== undefined && addonSha256 !== shelfMutexSha256) {
    throw new Error("The Host shelf_mutex.node differs from the staged Shelf mutex addon; rebuild the Host payload after build:native.");
  }

  const zip = await loadCollectorZip(pin, { localZip });
  const extension = verifyCollectorExtension(zip.bytes, pin, { hostExtensionId: await readHostExtensionId(desktopRoot) });

  const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: desktopRoot }).toString("utf8").trim();
  const descriptor = buildDescriptor({
    desktopVersion: desktopPackage.version,
    commit,
    hostFiles: new Map([[HOST_EXECUTABLE, hostFiles.get(HOST_EXECUTABLE)], [HOST_ADDON, hostFiles.get(HOST_ADDON)]]),
    extension,
  });

  const hostOutput = path.join(runtimeRoot, HOST_RESOURCE_DIRECTORY);
  const extensionOutput = path.join(runtimeRoot, EXTENSION_RESOURCE_DIRECTORY);
  await rm(hostOutput, { recursive: true, force: true });
  await rm(extensionOutput, { recursive: true, force: true });
  await rm(path.join(runtimeRoot, DESCRIPTOR_FILE_NAME), { force: true });
  await mkdir(hostOutput, { recursive: true });
  await mkdir(extensionOutput, { recursive: true });
  for (const name of HOST_RESOURCE_FILES) await copyFile(path.join(hostPayload, name), path.join(hostOutput, name));
  for (const [name, bytes] of extension.files) await writeFile(path.join(extensionOutput, name), bytes);
  await writeFile(path.join(runtimeRoot, DESCRIPTOR_FILE_NAME), `${JSON.stringify(descriptor, null, 2)}\n`);
  return { descriptor, source: zip.source, pin };
}
