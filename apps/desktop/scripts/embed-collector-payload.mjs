/**
 * Embed the Collector payload descriptor into the STAGED main bundle (WP-5c, design 2.1).
 *
 * `tsc` compiles `src/collector-payload-compiled.ts` to a module that exports
 * `COLLECTOR_PAYLOAD_EMBEDDED = false` and `COMPILED_COLLECTOR_PAYLOAD = null`. The descriptor only
 * exists after staging (it holds the Host hashes and the commit in `payloadId`), so the staging step
 * overwrites that emitted module inside `packaging/.stage/app/dist/main`. The repository's own
 * `dist/` stays the development form. Fails closed: the module must exist and look like the
 * compiled stub, the descriptor must validate, and the written file is read back and compared.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateDescriptor } from "./collector-payload.mjs";

export const COMPILED_MODULE_FILE = "collector-payload-compiled.js";

export function renderCompiledModule(descriptor) {
  validateDescriptor(descriptor);
  return [
    "\"use strict\";",
    "Object.defineProperty(exports, \"__esModule\", { value: true });",
    "exports.COMPILED_COLLECTOR_PAYLOAD = exports.COLLECTOR_PAYLOAD_EMBEDDED = void 0;",
    "exports.COLLECTOR_PAYLOAD_EMBEDDED = true;",
    `exports.COMPILED_COLLECTOR_PAYLOAD = Object.freeze(${JSON.stringify(descriptor)});`,
    "",
  ].join("\n");
}

export async function embedCollectorPayload({ distMainDirectory, descriptor }) {
  const target = path.join(distMainDirectory, COMPILED_MODULE_FILE);
  let current;
  try {
    current = await readFile(target, "utf8");
  } catch {
    throw new Error(`${COMPILED_MODULE_FILE} was not emitted into ${distMainDirectory}; add src/collector-payload-compiled.ts to the main build and rebuild.`);
  }
  if (!current.includes("COLLECTOR_PAYLOAD_EMBEDDED") || !current.includes("COMPILED_COLLECTOR_PAYLOAD") || /COLLECTOR_PAYLOAD_EMBEDDED\s*=\s*true/u.test(current)) {
    throw new Error(`${COMPILED_MODULE_FILE} is not the unembedded compiled stub.`);
  }
  const text = renderCompiledModule(descriptor);
  await writeFile(target, text, "utf8");
  if ((await readFile(target, "utf8")) !== text) throw new Error(`${COMPILED_MODULE_FILE} could not be written back identically.`);
  return target;
}
