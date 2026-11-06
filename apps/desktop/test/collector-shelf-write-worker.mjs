/**
 * Real-child-process driver for the cross-process Shelf writer PoC.
 *
 * This file is test-only. It is not packaged, not registered as a Native
 * Messaging Host, and is never imported by product code. It exercises the
 * compiled coordination layer (`dist/main/shelf-write-coordination.js`) from an
 * ordinary OS process so that exclusion, idempotency, crash recovery and receipt
 * durability are proven between processes rather than between in-process stubs.
 *
 * Commands:
 *   (default)          commit one Collector web quote
 *   crashAfterBook     exit between the Book publish and the Annotation publish
 *   swapAnnotationsTo  replace the Annotation directory with a junction mid-write
 *   holdLeaseMs        acquire the write lease, hold it, then assert it was kept
 *   reclaim            explicit recovery of a lease left by a dead holder
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

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reportFailure(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
  emit({
    ok: false,
    code,
    message: String(error && error.message ? error.message : error),
    // Recovery context (lease token / holder) is coordination metadata, so a test
    // or recovery UI can name the exact stuck lock without reading internal files.
    ...(error && typeof error === "object" && error.context ? { context: error.context } : {})
  });
  process.exit(code.startsWith("shelf-write-") ? 3 : 1);
}

if (command.reclaim !== undefined) {
  // Explicit recovery only. Nothing in the commit path reclaims a lease, so this
  // is the operator/procedure step that follows `shelf-write-lease-stale`.
  try {
    const result = await coordination.reclaimStaleShelfWriteLease({
      coordinationRoot: command.coordinationRoot,
      shelfId: command.expectedShelfId,
      expectedToken: command.reclaim.expectedToken
    });
    emit({ ok: true, reclaimed: result.reclaimed, holder: result.holder });
  } catch (error) {
    reportFailure(error);
  }
  process.exit(0);
}

if (typeof command.holdLeaseMs === "number") {
  // Lease-holding mode: proves that a live holder cannot be displaced, and reports
  // whether its lease still belonged to it after the contender ran.
  try {
    const lease = await coordination.acquireShelfWriteLease({
      coordinationRoot: command.coordinationRoot,
      shelfId: command.expectedShelfId,
      processLabel: command.processLabel ?? "poc-holder",
      ...(command.leaseTtlMs === undefined ? {} : { leaseTtlMs: command.leaseTtlMs }),
      ...(command.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: command.acquireTimeoutMs })
    });
    emit({ ok: true, acquired: true, pid: process.pid, token: lease.token });
    await new Promise((resolve) => { setTimeout(resolve, command.holdLeaseMs); });
    let assertedHeld = true;
    try {
      await lease.assertHeld();
    } catch {
      assertedHeld = false;
    }
    await lease.release();
    emit({ ok: true, acquired: true, assertedHeld, released: true });
    process.exit(assertedHeld ? 0 : 4);
  } catch (error) {
    reportFailure(error);
  }
}

const faults = {};
if (command.crashAfterBook === true) {
  // Simulates a power loss between the add-only Book publish and the Annotation
  // publish. process.exit skips finally blocks, so the lease file is left behind
  // exactly as a crashed process would leave it.
  faults.beforeAnnotationPublish = () => {
    emit({ ok: false, code: "simulated-crash" });
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
    ...(command.commentField === undefined ? {} : { commentField: command.commentField }),
    processLabel: command.processLabel ?? "poc-worker",
    ...(command.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: command.acquireTimeoutMs }),
    ...(command.leaseTtlMs === undefined ? {} : { leaseTtlMs: command.leaseTtlMs }),
    ...(Object.keys(faults).length === 0 ? {} : { faults })
  });
  emit({ ok: true, receipt });
} catch (error) {
  reportFailure(error);
}
