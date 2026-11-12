import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stageShelfMutexAddon } from "./shelf-mutex-addon.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const packagingRoot = path.join(desktopRoot, "packaging");
const runtimeRoot = path.join(packagingRoot, "runtime");
const stageRoot = path.join(packagingRoot, ".stage", "app");
const vendorRoot = path.join(stageRoot, "vendor");
const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));

if (!process.env.npm_execpath) throw new Error("Run this script through the repository npm script so its pinned npm runtime is available.");
await access(path.join(desktopRoot, "dist", "main", "main.js"));
await access(path.join(runtimeRoot, "reviewer", "marginalia-reviewer.exe"));
// α2: the installed Reviewer writer requires the native Shelf mutex; fail
// before staging anything if it is missing or not the expected /MT N-API build.
const shelfMutex = await stageShelfMutexAddon({ desktopRoot, repositoryRoot, runtimeRoot });
process.stdout.write(`Shelf mutex addon staged: sha256=${shelfMutex.sha256} bytes=${shelfMutex.bytes}\n`);
await rm(stageRoot, { recursive: true, force: true });
await mkdir(vendorRoot, { recursive: true });

const localPackages = [
  { name: "@maginalia/format", directory: "packages/format" },
  { name: "@maginalia/repository-core", directory: "packages/repository-core" },
  { name: "@maginalia/source-core", directory: "packages/source-core" },
  { name: "@maginalia/writing-core", directory: "packages/writing-core" },
];
const dependencies = {};
for (const entry of localPackages) {
  const directory = path.join(repositoryRoot, entry.directory);
  await access(path.join(directory, "dist", "index.js"));
  const packed = await runCaptured(process.execPath, [process.env.npm_execpath, "pack", "--json", "--pack-destination", vendorRoot], directory);
  const record = JSON.parse(packed.stdout)[0];
  dependencies[entry.name] = `file:./vendor/${record.filename}`;
}
for (const name of ["fflate", "isomorphic-git", "monaco-editor", "sharp", "yaml"]) {
  const version = lock.packages[`apps/desktop/node_modules/${name}`]?.version
    ?? lock.packages[`node_modules/${name}`]?.version;
  if (typeof version !== "string") throw new Error(`The workspace lockfile has no exact runtime version for ${name}.`);
  dependencies[name] = version;
}

const stagedManifest = {
  name: desktopPackage.name,
  version: desktopPackage.version,
  private: true,
  main: desktopPackage.main,
  dependencies,
};
await writeFile(path.join(stageRoot, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`, "utf8");
await cp(path.join(desktopRoot, "dist"), path.join(stageRoot, "dist"), { recursive: true });
await runCaptured(process.execPath, [process.env.npm_execpath, "install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], stageRoot);
await writeThirdPartyNotices();
process.stdout.write(`Allowlisted app staged in ${stageRoot}\n`);

async function writeThirdPartyNotices() {
  const noticesRoot = path.join(runtimeRoot, "THIRD-PARTY-NOTICES");
  await rm(noticesRoot, { recursive: true, force: true });
  await mkdir(noticesRoot, { recursive: true });
  for (const filename of ["LICENSE", "NOTICE"]) {
    const source = path.join(repositoryRoot, filename);
    try { await cp(source, path.join(noticesRoot, `MAGINALIA-${filename}`)); } catch { /* NOTICE is optional in the current repository. */ }
  }
  await collectNpmNotices(path.join(stageRoot, "node_modules"), path.join(noticesRoot, "node"));
  await collectPythonNotices(path.join(repositoryRoot, "sidecars", "reviewer", ".venv", "Lib", "site-packages"), path.join(noticesRoot, "python"));
  await collectPythonNotices(path.join(repositoryRoot, "sidecars", "reviewer", "ndlocr-runtime", ".venv", "Lib", "site-packages"), path.join(noticesRoot, "python-ndlocr"));
  await cp(path.join(runtimeRoot, "ndlocr", "licenses"), path.join(noticesRoot, "NDLOCR-Lite-1.3.1"), { recursive: true });
  const runtimeVersions = JSON.parse(await readFile(path.join(packagingRoot, "runtime-versions.json"), "utf8"));
  const pyinstallerNoticeDirectory = path.join(noticesRoot, "python", `PyInstaller-${runtimeVersions.pyinstaller}`);
  await mkdir(pyinstallerNoticeDirectory, { recursive: true });
  await cp(path.join(runtimeRoot, "PyInstaller-LICENSES", "COPYING.txt"), path.join(pyinstallerNoticeDirectory, "COPYING.txt"));
  await writeFile(path.join(pyinstallerNoticeDirectory, "DEPENDENCY.json"), `${JSON.stringify({
    name: "PyInstaller",
    version: runtimeVersions.pyinstaller,
    license: "GPLv2-or-later with the PyInstaller special exception; see COPYING.txt",
  }, null, 2)}\n`, "utf8");
  for (const filename of ["COPYING.rtf", "COPYRIGHT.txt"]) {
    await cp(path.join(runtimeRoot, "pandoc", filename), path.join(noticesRoot, `Pandoc-${filename}`));
  }
  for (const filename of ["LICENSE", "LICENSES.chromium.html"]) {
    const source = path.join(repositoryRoot, "node_modules", "electron", "dist", filename);
    try { await cp(source, path.join(noticesRoot, `Electron-${filename}`)); } catch { /* Some Electron releases ship one combined license file. */ }
  }
}

async function collectNpmNotices(nodeModulesRoot, outputRoot) {
  const packages = [];
  async function visit(current, relative = "") {
    let entries;
    try { entries = await (await import("node:fs/promises")).readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageDirectory = path.join(current, entry.name);
      if (entry.name.startsWith("@")) {
        await visit(packageDirectory, path.join(relative, entry.name));
        continue;
      }
      const packageJsonPath = path.join(packageDirectory, "package.json");
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
        packages.push({ name: packageJson.name ?? path.join(relative, entry.name), version: packageJson.version ?? "unknown", license: typeof packageJson.license === "string" ? packageJson.license : JSON.stringify(packageJson.license ?? "unspecified") });
        const destination = path.join(outputRoot, `${String(packageJson.name ?? entry.name).replaceAll("/", "_")}-${packageJson.version ?? "unknown"}`);
        await mkdir(destination, { recursive: true });
        await copyLicenseFiles(packageDirectory, destination, true);
      } catch { /* Not every folder is a package. */ }
      const nested = path.join(packageDirectory, "node_modules");
      await visit(nested, path.join(relative, entry.name));
    }
  }
  await visit(nodeModulesRoot);
  packages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  await writeFile(path.join(outputRoot, "DEPENDENCIES.json"), `${JSON.stringify(packages, null, 2)}\n`, "utf8");
}

async function collectPythonNotices(sitePackages, outputRoot) {
  const { readdir } = await import("node:fs/promises");
  let entries;
  try { entries = await readdir(sitePackages, { withFileTypes: true }); } catch { throw new Error("Reviewer Python environment is missing; build the Windows runtime before staging the app."); }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
    const directory = path.join(sitePackages, entry.name);
    const metadata = await readFile(path.join(directory, "METADATA"), "utf8").catch(() => "");
    const name = metadata.match(/^Name:\s*(.+)$/imu)?.[1]?.trim() ?? entry.name;
    const version = metadata.match(/^Version:\s*(.+)$/imu)?.[1]?.trim() ?? "unknown";
    const license = metadata.match(/^License-Expression:\s*(.+)$/imu)?.[1]?.trim()
      ?? metadata.match(/^License:\s*(.+)$/imu)?.[1]?.trim()
      ?? "unspecified";
    packages.push({ name, version, license });
    const destination = path.join(outputRoot, `${name}-${version}`.replaceAll(/[<>:"/\\|?*]/gu, "_"));
    await mkdir(destination, { recursive: true });
    await copyLicenseFiles(directory, destination, false);
  }
  packages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  await writeFile(path.join(outputRoot, "DEPENDENCIES.json"), `${JSON.stringify(packages, null, 2)}\n`, "utf8");
}

async function copyLicenseFiles(source, destination, packageRootOnly) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" && packageRootOnly) continue;
      if (/^(?:licenses?|third[-_ ]party|legal)$/iu.test(entry.name) || !packageRootOnly) {
        await copyLicenseFiles(path.join(source, entry.name), path.join(destination, entry.name), packageRootOnly);
      }
      continue;
    }
    if (!entry.isFile() || !/^(?:license|licence|copying|notice|copyright)(?:[._-].*)?$/iu.test(entry.name)) continue;
    await cp(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

function runCaptured(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} failed (${code ?? signal ?? "unknown"}): ${stderr}`)));
  });
}
