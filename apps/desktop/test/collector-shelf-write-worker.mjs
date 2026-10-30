/**
 * Real-child-process driver for the cross-process Shelf writer PoC.
 *
 * This file is test-only. It is not packaged, not registered as a Native
 * Messaging Host, and is never imported by product code. It exercises the
 * compiled coordination layer (`dist/main/shelf-write-coordination.js`) from an
 * ordinary OS process so that exclusion, idempotency, crash recovery and receipt
 * durability are proven between processes rather than between in-process stubs.
 */
import { createRequire } from "node:module";
import { readFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const commandFile = process.argv[2];
if (typeof commandFile !== "string") {
  process.stdout.write(`${JSON.stringify({ ok: false, code: "missing-command" })}\n`);
  process.exit(2);
}

const coordination = require(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "main",
  "shelf-write-coordination.js"
));

const command = JSON.parse(await readFile(commandFile, "utf8"));

const faults = {};
if (command.crashAfterBook === true) {
  // Simulates a power loss between the add-only Book publish and the Annotation
  // publish. process.exit skips finally blocks, so the lease file is left behind
  // exactly as a crashed process would leave it.
  faults.beforeAnnotationPublish = () => {
    process.stdout.write(`${JSON.stringify({ ok: false, code: "simulated-crash" })}\n`);
    process.exit(70);
  };
}
if (typeof command.swapAnnotationsTo === "string") {
  // Simulates an attacker/user replacing the record directory with a junction
  // after the layout was validated.
  faults.beforeAnnotationPublish = async () => {
    await rename(command.annotationsPath, `${command.annotationsPath}.original`);
    await symlink(command.swapAnnotationsTo, command.annotationsPath, "junction");
  };
}

try {
  const receipt = await coordination.commitShelfQuote({
    requestId: command.requestId,
    shelfRoot: command.shelfRoot,
    expectedShelfId: command.expectedShelfId,
    coordinationRoot: command.coordinationRoot,
    quote: command.quote,
    url: command.url,
    getDate: command.getDate,
    ...(command.title === undefined ? {} : { title: command.title }),
    ...(command.authors === undefined ? {} : { authors: command.authors }),
    ...(command.comment === undefined ? {} : { comment: command.comment }),
    processLabel: command.processLabel ?? "poc-worker",
    ...(command.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: command.acquireTimeoutMs }),
    ...(Object.keys(faults).length === 0 ? {} : { faults })
  });
  process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
} catch (error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
  process.stdout.write(`${JSON.stringify({ ok: false, code, message: String(error && error.message ? error.message : error) })}\n`);
  process.exit(code.startsWith("shelf-write-") ? 3 : 1);
}
