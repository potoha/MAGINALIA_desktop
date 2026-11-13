/**
 * Smoke test for the built standalone Collector Host (`npm run dist:collector-host`
 * first). It runs the single executable directly, without installing or registering
 * anything, sends framed requests on stdin and checks the framed responses.
 *
 * With no Desktop-written binding for this user, the Host must fail closed
 * (`writesEnabled: false`, `shelf_unconfigured`). When a real binding exists, the
 * unconfigured assertions are skipped and only identity checks run. The real
 * `%LOCALAPPDATA%\MAGINALIA` folder must be unchanged (existence and listing) after
 * the run.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payload = path.join(desktop, "release", "collector-host", "payload");
const executable = path.join(payload, "MAGINALIA-Collector-Host.exe");
const protocol = "maginalia.collector.experimental.v1";
const origin = "chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/";

function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function run(args, chunks, env = process.env, program = executable) {
  const child = spawn(program, args, { env, cwd: os.tmpdir() });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  for (const chunk of chunks) child.stdin.write(chunk);
  child.stdin.end();
  const code = await closed;
  const stderr = Buffer.concat(err).toString();
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  const bytes = Buffer.concat(out);
  const values = [];
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset);
    assert.ok(bytes.length >= offset + 4 + size, "stdout carries only complete frames");
    values.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + size).toString("utf8")));
    offset += 4 + size;
  }
  return values;
}

async function snapshot(directory) {
  try {
    await lstat(directory);
  } catch {
    return "absent";
  }
  return JSON.stringify((await readdir(directory, { recursive: true })).sort());
}

const localAppData = require(path.join(payload, "shelf_mutex.node")).getLocalAppDataPath();
const applicationRoot = path.join(localAppData, "MAGINALIA");
const before = await snapshot(applicationRoot);
const bound = before !== "absent" && before.includes("private-shelf-binding.json");
const temp = await mkdtemp(path.join(os.tmpdir(), "collector-host-smoke-"));
const results = [];
const check = async (name, body) => { await body(); results.push(`PASS ${name}`); };
try {
  await check("health/configured_shelf/save fail closed without a binding (chunked frames)", async () => {
    const health = frame({ protocol, operation: "health" });
    const values = await run([origin, "--parent-window=0"], [
      health.subarray(0, 2), health.subarray(2),
      frame({ protocol, operation: "configured_shelf" }),
      frame({ protocol, operation: "save_web_quote", requestId: "00000000-0000-4000-8000-0000000000e1", quote: "smoke", url: "https://example.com/", getDate: "202611130000" })
    ]);
    assert.equal(values.length, 3);
    assert.equal(values[0].ok, true);
    if (!bound) {
      assert.deepEqual(values[0], { protocol, ok: true, experimental: true, operations: ["health", "configured_shelf"], writesEnabled: false });
      assert.deepEqual(values[1], { protocol, ok: false, error: "shelf_unconfigured" });
      assert.deepEqual(values[2], { protocol, ok: false, error: "shelf_unconfigured" });
    }
  });
  await check("wrong or missing caller origin is refused", async () => {
    assert.deepEqual(await run([`chrome-extension://${"a".repeat(32)}/`], [frame({ protocol, operation: "health" })]),
      [{ protocol, ok: false, error: "host_configuration_or_origin_invalid" }]);
    assert.deepEqual(await run([], [frame({ protocol, operation: "health" })]),
      [{ protocol, ok: false, error: "host_configuration_or_origin_invalid" }]);
  });
  await check("frame errors", async () => {
    assert.deepEqual(await run([origin], [frame(Buffer.from([0xff]))]), [{ protocol, ok: false, error: "invalid_json" }]);
    assert.deepEqual(await run([origin], [Buffer.from([1, 0])]), [{ protocol, ok: false, error: "truncated_frame" }]);
    assert.deepEqual(await run([origin], [Buffer.from([0, 0, 2, 0])]), [{ protocol, ok: false, error: "invalid_frame_length" }]);
  });
  await check("the addon is loaded only from next to the executable (missing addon fails closed)", async () => {
    const lonely = path.join(temp, "lonely");
    await mkdir(lonely);
    const copy = path.join(lonely, "MAGINALIA-Collector-Host.exe");
    await copyFile(executable, copy);
    const values = await run([origin], [frame({ protocol, operation: "health" }), frame({ protocol, operation: "configured_shelf" })], process.env, copy);
    assert.deepEqual(values, [
      { protocol, ok: true, experimental: true, operations: ["health", "configured_shelf"], writesEnabled: false },
      { protocol, ok: false, error: "configuration_unavailable" }
    ]);
  });
  await check("NODE_OPTIONS, runtime flags and Host env variables are ignored", async () => {
    const marker = path.join(temp, "injected.txt");
    const preload = path.join(temp, "preload.cjs");
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
    const env = {
      ...process.env,
      NODE_OPTIONS: `--require ${preload}`,
      MAGINALIA_COLLECTOR_TEST_ONLY: "1",
      MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR: path.join(temp, "descriptor.json"),
      MAGINALIA_SHELF_MUTEX_PATH: path.join(temp, "missing.node"),
      LOCALAPPDATA: temp
    };
    const values = await run([origin], [frame({ protocol, operation: "health" })], env);
    assert.equal(values[0].ok, true);
    const flag = await run(["--require", preload], [frame({ protocol, operation: "health" })]);
    assert.deepEqual(flag, [{ protocol, ok: false, error: "host_configuration_or_origin_invalid" }]);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
assert.equal(await snapshot(applicationRoot), before, "the real MAGINALIA LocalAppData folder is unchanged");
results.push(`PASS real LocalAppData MAGINALIA unchanged (${before === "absent" ? "absent before and after" : "present, listing unchanged"})`);
if (bound) results.push("NOTE a real binding exists; unconfigured assertions were skipped");
process.stdout.write(`${results.join("\n")}\n`);
