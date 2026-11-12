import { createWriteStream } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNdlocrRuntime } from "./build-ndlocr-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const packagingRoot = path.join(desktopRoot, "packaging");
const runtimeRoot = path.join(packagingRoot, "runtime");
const stagingRoot = path.join(packagingRoot, ".stage", "windows-runtime");
const versions = JSON.parse(await readFile(path.join(packagingRoot, "runtime-versions.json"), "utf8"));

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows runtime packaging currently requires a Windows x64 build host.");
}
if (!process.env.npm_execpath) throw new Error("Run this script through the repository npm script so its pinned npm runtime is available.");

await rm(runtimeRoot, { recursive: true, force: true });
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await mkdir(runtimeRoot, { recursive: true });

await buildReviewer();
await buildNdlocrRuntime({ repositoryRoot, packagingRoot, runtimeRoot, stagingRoot, versions });
await installPandoc();
await copyContractsAndTutorial();
await writeFile(path.join(runtimeRoot, "runtime-build.json"), `${JSON.stringify({
  schemaVersion: 1,
  builtAt: new Date().toISOString(),
  host: `${process.platform}-${process.arch}`,
  reviewerPython: versions.reviewerPython,
  ndlocrPython: versions.ndlocrPython,
  ndlocrLite: JSON.parse(await readFile(path.join(repositoryRoot, "sidecars", "reviewer", "ndlocr-lite-1.3.1.lock.json"), "utf8")),
  pyinstaller: versions.pyinstaller,
  pandoc: versions.pandoc,
}, null, 2)}\n`, "utf8");
process.stdout.write(`Windows runtime staged in ${runtimeRoot}\n`);

async function buildReviewer() {
  const sidecarRoot = path.join(repositoryRoot, "sidecars", "reviewer");
  const entry = path.join(stagingRoot, "reviewer-entry.py");
  const outputRoot = path.join(stagingRoot, "reviewer-output");
  const workRoot = path.join(stagingRoot, "pyinstaller-work");
  await mkdir(outputRoot, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  await writeFile(entry, "from marginalia_reviewer.__main__ import main\n\nif __name__ == '__main__':\n    main()\n", "utf8");
  const args = [
    "run", "--project", sidecarRoot, "--group", "packaging", "--python", versions.reviewerPython,
    "python", "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "marginalia-reviewer", "--distpath", outputRoot, "--workpath", workRoot,
    "--specpath", workRoot, "--paths", path.join(sidecarRoot, "src"),
    "--collect-all", "fastapi", "--collect-all", "starlette", "--collect-all", "uvicorn",
    "--collect-all", "jsonschema", "--collect-all", "jsonschema_specifications", "--collect-all", "referencing",
    "--collect-all", "keyring", "--collect-all", "PIL",
    "--hidden-import", "uvicorn.logging", "--hidden-import", "uvicorn.loops.auto",
    "--hidden-import", "uvicorn.protocols.http.auto", "--hidden-import", "uvicorn.lifespan.on",
    entry,
  ];
  await run("uv", args, repositoryRoot);
  const builtDirectory = path.join(outputRoot, "marginalia-reviewer");
  await access(path.join(builtDirectory, "marginalia-reviewer.exe"));
  await cp(builtDirectory, path.join(runtimeRoot, "reviewer"), { recursive: true });
  const pyinstallerMetadata = path.join(sidecarRoot, ".venv", "Lib", "site-packages", `pyinstaller-${versions.pyinstaller}.dist-info`);
  const pyinstallerLicense = path.join(pyinstallerMetadata, "licenses", "COPYING.txt");
  const pyinstallerLicenseOutput = path.join(runtimeRoot, "PyInstaller-LICENSES", "COPYING.txt");
  await mkdir(path.dirname(pyinstallerLicenseOutput), { recursive: true });
  await copyFile(pyinstallerLicense, pyinstallerLicenseOutput);
  await run("uv", ["sync", "--project", sidecarRoot, "--frozen", "--no-group", "packaging"], repositoryRoot);
}

async function installPandoc() {
  const archive = path.join(stagingRoot, versions.pandoc.asset);
  await download(versions.pandoc.url, archive);
  const archiveSha256 = await sha256(archive);
  if (archiveSha256.toLowerCase() !== versions.pandoc.sha256.toLowerCase()) {
    throw new Error(`Pandoc archive hash did not match the pinned value: ${archiveSha256}`);
  }
  const extracted = path.join(stagingRoot, "pandoc");
  await mkdir(extracted, { recursive: true });
  // Use the Windows bsdtar explicitly: a GNU tar earlier on PATH (e.g. Git Bash)
  // misreads drive-letter paths such as D:\ as remote hosts.
  const windowsTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  await run(windowsTar, ["-xf", archive, "-C", extracted], repositoryRoot);
  const sourceDirectory = path.join(extracted, `pandoc-${versions.pandoc.version}`);
  const destination = path.join(runtimeRoot, "pandoc");
  await mkdir(destination, { recursive: true });
  for (const filename of ["pandoc.exe", "COPYING.rtf", "COPYRIGHT.txt"]) {
    await copyFile(path.join(sourceDirectory, filename), path.join(destination, filename));
  }
}

async function copyContractsAndTutorial() {
  await cp(path.join(repositoryRoot, "sidecars", "contracts"), path.join(runtimeRoot, "contracts"), { recursive: true });
  const tutorialRoot = path.join(repositoryRoot, "Tutorial_sample_setup");
  const tutorialDestination = path.join(runtimeRoot, "tutorial-sample");
  await mkdir(tutorialDestination, { recursive: true });
  for (const entry of ["project-template", "private-shelf-seed", "resources", "installer-copy-manifest.json"]) {
    const source = path.join(tutorialRoot, entry);
    const destination = path.join(tutorialDestination, entry);
    if (entry.endsWith(".json")) await copyFile(source, destination);
    else await cp(source, destination, { recursive: true });
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`Could not download a pinned packaging input (${response.status}).`);
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${path.basename(command)} failed (${code ?? signal ?? "unknown"}).`)));
  });
}
