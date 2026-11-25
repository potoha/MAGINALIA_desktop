import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addonBuildPath,
  assertBindingConfiguration,
  findDynamicCrtImports,
  inspectPortableExecutable,
  stageShelfMutexAddon,
} from "../scripts/shelf-mutex-addon.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakePe({ machine = 0x8664, characteristics = 0x2022, magic = 0x20b } = {}) {
  const bytes = Buffer.alloc(0x200);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(characteristics, 0x96);
  bytes.writeUInt16LE(magic, 0x98);
  return bytes;
}

test("PE inspection accepts only x64 PE32+ DLLs", () => {
  assert.deepEqual(inspectPortableExecutable(fakePe()), { machine: "x64", dll: true });
  assert.throws(() => inspectPortableExecutable(Buffer.from("not a pe")), /MZ/u);
  assert.throws(() => inspectPortableExecutable(fakePe({ machine: 0x14c })), /not x64/u);
  assert.throws(() => inspectPortableExecutable(fakePe({ characteristics: 0x0022 })), /not a DLL/u);
  assert.throws(() => inspectPortableExecutable(fakePe({ magic: 0x10b })), /PE32\+/u);
});

test("dynamic CRT imports are detected by DLL name", () => {
  assert.deepEqual(findDynamicCrtImports(Buffer.from("KERNEL32.dll\0ADVAPI32.dll\0node.exe\0")), []);
  assert.deepEqual(findDynamicCrtImports(Buffer.from("KERNEL32.dll\0VCRUNTIME140.dll\0api-ms-win-crt-runtime-l1-1-0.dll\0MSVCP140.dll\0")).sort(),
    ["api-ms-win-crt-runtime-l1-1-0.dll", "msvcp140.dll", "vcruntime140.dll"]);
});

test("binding.gyp declares N-API 8 and the static CRT", async () => {
  await assertBindingConfiguration(desktopRoot);
});

test("staging fails closed when the addon is missing, and stages a verified /MT addon otherwise", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "maginalia-stage-mutex-"));
  try {
    await assert.rejects(stageShelfMutexAddon({ desktopRoot: scratch, repositoryRoot: scratch, runtimeRoot: path.join(scratch, "runtime") }), /build:native/u);
    let built = true;
    try { await access(addonBuildPath(desktopRoot)); } catch { built = false; }
    if (!built || process.platform !== "win32") return;
    const runtimeRoot = path.join(scratch, "runtime");
    const provenance = await stageShelfMutexAddon({ desktopRoot, repositoryRoot: path.resolve(desktopRoot, "..", ".."), runtimeRoot });
    assert.equal(provenance.napiVersion, 8);
    assert.equal(provenance.crt, "static (/MT)");
    assert.match(provenance.sha256, /^[0-9a-f]{64}$/u);
    const staged = await readFile(path.join(runtimeRoot, "shelf-mutex", "shelf_mutex.node"));
    assert.equal(staged.length, provenance.bytes);
    assert.deepEqual(findDynamicCrtImports(staged), []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
