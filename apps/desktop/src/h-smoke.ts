import * as path from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { ProjectService } from "./project-service.js";
import type { LocalRepositoryService } from "./repository-service.js";
import type { WorkdeskService } from "./workdesk-service.js";

/**
 * Real Electron coverage of Workdesk creation, child Project ownership,
 * parent History isolation, byte-preserving copy, navigation return, and
 * restart restore. UI actions use visible renderer controls; contextBridge
 * APIs stay isolated and are never copied into the main world.
 */
const RENDERER_TIMEOUT_MS = 15_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRenderer(window: BrowserWindow, predicate: string, description: string): Promise<void> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    lastValue = await window.webContents.executeJavaScript(predicate, true);
    if (lastValue) return;
    await delay(25);
  }
  throw new Error(`Workdesk smoke timed out waiting for ${description}: ${JSON.stringify(lastValue)}.`);
}

async function waitForLastActiveProject(
  workdesks: WorkdeskService,
  workdesk: Awaited<ReturnType<WorkdeskService["open"]>>,
  projectIdentityId: string,
): Promise<void> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  let lastActive = await workdesks.lastActiveContext(workdesk);
  while (Date.now() < deadline) {
    if (lastActive.kind === "project"
      && lastActive.projectIdentityId.toLowerCase() === projectIdentityId.toLowerCase()) return;
    await delay(25);
    lastActive = await workdesks.lastActiveContext(workdesk);
  }
  throw new Error(`The real Project was not saved as the last active Workdesk context: ${JSON.stringify(lastActive)}.`);
}

async function runRendererAction(window: BrowserWindow, script: string, description: string): Promise<void> {
  const result = await window.webContents.executeJavaScript(script, true);
  if (result !== true) throw new Error(`Workdesk smoke could not perform ${description}.`);
}

async function runOverflowAction(window: BrowserWindow, actionId: string, description: string): Promise<void> {
  await runRendererAction(window, `(() => {
    const trigger = document.querySelector("#project-overflow");
    const menu = document.querySelector("#project-overflow-menu");
    const action = document.querySelector(${JSON.stringify(`#${actionId}`)});
    if (!(trigger instanceof HTMLButtonElement) || !(menu instanceof HTMLElement)
      || !(action instanceof HTMLButtonElement) || action.hidden) return false;
    if (menu.hidden) trigger.click();
    if (menu.hidden || trigger.getAttribute("aria-expanded") !== "true") return false;
    action.click();
    return true;
  })()`, description);
}

async function openPaletteShortcut(window: BrowserWindow, kind: "commands" | "files"): Promise<void> {
  const commandMode = kind === "commands";
  const modifier = process.platform === "darwin" ? "metaKey" : "ctrlKey";
  await runRendererAction(window, `(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "p",
      ${modifier}: true,
      shiftKey: ${commandMode},
      bubbles: true,
      cancelable: true
    }));
    return true;
  })()`, `opening the ${kind === "commands" ? "Command Palette" : "Quick Open"} by shortcut`);
  await waitForRenderer(window,
    `document.querySelector(".command-palette > input") === document.activeElement`,
    `${kind === "commands" ? "Command Palette" : "Quick Open"} shortcut focus`);
  const initialValue = await window.webContents.executeJavaScript(
    `document.querySelector(".command-palette > input")?.value ?? null`, true
  ) as string | null;
  const expectedPrefix = commandMode ? ">" : "file:";
  if (initialValue === null || !initialValue.startsWith(expectedPrefix)) {
    throw new Error(`${kind} shortcut opened with an unexpected initial query: ${JSON.stringify(initialValue)}.`);
  }
}

async function searchPalette(window: BrowserWindow, query: string): Promise<{
  readonly rows: number;
  readonly title: string | null;
  readonly commandId: string | null;
  readonly providerId: string | null;
  readonly category: string | null;
}> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(".command-palette > input");
    if (!(input instanceof HTMLInputElement)) return null;
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const selected = document.querySelector(".command-palette-item[aria-selected='true']");
    return {
      rows: document.querySelectorAll(".command-palette-item").length,
      title: selected?.querySelector(".command-palette-command-title")?.textContent?.trim() ?? null,
      commandId: selected?.dataset.commandId ?? null,
      providerId: selected?.dataset.providerId ?? null,
      category: selected?.querySelector(".command-palette-category")?.textContent?.trim() ?? null
    };
  })()`, true) as {
    readonly rows: number;
    readonly title: string | null;
    readonly commandId: string | null;
    readonly providerId: string | null;
    readonly category: string | null;
  } | null;
  return result ?? { rows: 0, title: null, commandId: null, providerId: null, category: null };
}

async function activatePaletteSelection(window: BrowserWindow, description: string): Promise<void> {
  await runRendererAction(window, `(() => {
    const input = document.querySelector(".command-palette > input");
    if (!(input instanceof HTMLInputElement)) return false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`, description);
  await waitForRenderer(window,
    `document.querySelector(".command-palette")?.hidden === true`,
    `${description} closing the Quick Pick`);
}

export async function runHSmoke(options: {
  readonly window: BrowserWindow;
  readonly fixtureRoot: string;
  readonly restore: boolean;
  readonly workdesks: WorkdeskService;
  readonly repositories: LocalRepositoryService;
  readonly projects: ProjectService;
  readonly workdeskPickerInvocationCount: () => number;
  readonly projectPickerInvocationCount: () => number;
  readonly registrationPromptInvocationCount: () => number;
  readonly rememberWorkdeskRoot: (rootPath: string) => void;
  readonly rememberProjectRoot: (rootPath: string) => void;
}): Promise<void> {
  if (options.restore) {
    const restored = await options.workdesks.restorePrimary();
    if (!restored) throw new Error("The primary Workdesk did not restore.");
    if ("kind" in restored) throw new Error(`The primary Workdesk needs identity recovery: ${restored.message}`);
    const projects = await options.workdesks.listRegisteredProjects(restored);
    const projectB = projects.find((project) => project.title === "H Smoke Project B");
    if (projects.length !== 4 || !projectB) {
      throw new Error("The restored Workdesk did not retain its four Project registrations.");
    }
    const lastActive = await options.workdesks.lastActiveContext(restored);
    if (lastActive.kind !== "project" || lastActive.projectIdentityId !== projectB.projectIdentityId) {
      throw new Error("The last active Project context was not persisted across restart.");
    }
    const restoredProjectB = await options.workdesks.resolveRegisteredProject(restored, projectB.projectIdentityId);
    try {
      await waitForRenderer(options.window,
        `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === ${JSON.stringify(path.basename(restoredProjectB.canonicalRoot))}`,
        "Project B restore through the normal startup path");
    } catch (error) {
      const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
        label: document.querySelector("#workspace-label")?.textContent ?? null,
        name: document.querySelector("#workspace-document-name")?.textContent ?? null,
        error: document.querySelector("#workspace-error")?.textContent ?? null,
        expectedProjectFolder: ${JSON.stringify(path.basename(restoredProjectB.canonicalRoot))}
      }))()`, true);
      throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
    }
    if (options.workdeskPickerInvocationCount() !== 0 || options.projectPickerInvocationCount() !== 0) {
      throw new Error("Startup restore opened a folder picker.");
    }
    return;
  }

  const owner = Object.freeze({});
  const created = await options.repositories.createForOwner(owner, options.fixtureRoot, "workbench", "H Smoke Desk");
  if (created.kind !== "opened") throw new Error(`Workdesk creation failed: ${created.message}`);
  const resolved = await options.repositories.resolveForOwner(owner, created.repository.repositoryId);
  if (resolved.kind !== "resolved") throw new Error(`Workdesk resolution failed: ${resolved.message}`);
  const workdesk = await options.workdesks.open(resolved.canonicalRoot);
  await options.workdesks.setPrimary(workdesk);
  options.rememberWorkdeskRoot(workdesk.canonicalRoot);

  const loose = await options.projects.openForOwner(owner, workdesk.canonicalRoot);
  if (loose.kind !== "opened") throw new Error(`Workdesk loose documents failed to open: ${loose.message}`);
  const memo = await options.projects.createFileForOwner(owner, loose.project.projectId, "memo.md", "H Smoke Memo", "memo");
  if (memo.kind !== "created") throw new Error(`Workdesk memo creation failed: ${memo.message}`);

  const projectParent = await options.workdesks.prepareChildProjectDirectory(workdesk);
  const createChildProject = async (title: string) => {
    const childOwner = Object.freeze({});
    const childCreated = await options.repositories.createForOwner(childOwner, projectParent, "project", title, {
      parentWorkdeskId: workdesk.identity.id,
    });
    if (childCreated.kind !== "opened") throw new Error(`Child Project creation failed: ${childCreated.message}`);
    const childResolved = await options.repositories.resolveForOwner(childOwner, childCreated.repository.repositoryId);
    if (childResolved.kind !== "resolved") throw new Error(`Child Project resolution failed: ${childResolved.message}`);
    const child = await options.workdesks.validateDirectChildProject(workdesk, childResolved.canonicalRoot);
    await options.workdesks.registerProjectLocation(workdesk, child);
    return child;
  };
  const projectB = await createChildProject("H Smoke Project B");
  await createChildProject("H Smoke Project A");
  const externalCreated = await options.projects.createForWorkdesk(
    options.fixtureRoot,
    "H Smoke 外部 Project",
    workdesk.identity.id,
  );
  if (externalCreated.kind !== "created") throw new Error(`External Project fixture creation failed: ${externalCreated.message}`);
  options.rememberProjectRoot(externalCreated.canonicalRoot);
  const cancelledExternalCreated = await options.projects.createForWorkdesk(
    options.fixtureRoot,
    "H Smoke Cancel Project",
    workdesk.identity.id,
  );
  if (cancelledExternalCreated.kind !== "created") throw new Error(`Cancel Project fixture creation failed: ${cancelledExternalCreated.message}`);
  options.rememberProjectRoot(cancelledExternalCreated.canonicalRoot);
  const unregisteredExternalCreated = await options.projects.createForWorkdesk(
    options.fixtureRoot,
    "H Smoke Unregistered Project",
    workdesk.identity.id,
  );
  if (unregisteredExternalCreated.kind !== "created") throw new Error(`Unregistered Project fixture creation failed: ${unregisteredExternalCreated.message}`);
  options.rememberProjectRoot(unregisteredExternalCreated.canonicalRoot);

  const source = await options.projects.readCopySourceForOwner(owner, loose.project.projectId, memo.file.fileId);
  if (!("text" in source)) throw new Error(`Workdesk copy source failed: ${source.message}`);
  const destinationOwner = Object.freeze({});
  const destination = await options.projects.openForOwner(destinationOwner, projectB.canonicalRoot);
  if (destination.kind !== "opened") throw new Error(`Child Project failed to open: ${destination.message}`);
  const copied = await options.projects.copySourceToProjectForOwner(destinationOwner, destination.project.projectId, source, "memo");
  if (copied.kind !== "created") throw new Error(`Workdesk copy failed: ${copied.message}`);
  const copiedSource = await options.projects.readCopySourceForOwner(destinationOwner, destination.project.projectId, copied.file.fileId);
  if (!("text" in copiedSource) || copiedSource.text !== source.text) {
    throw new Error("The child Project copy did not preserve the source Markdown bytes.");
  }

  const history = await options.repositories.createHistoryForOwner(owner, created.repository.repositoryId);
  if (history.kind !== "snapshot") throw new Error(`Parent Workdesk History did not safely capture: ${history.message}`);
  if (path.dirname(projectB.canonicalRoot) !== path.join(workdesk.canonicalRoot, "projects")) {
    throw new Error("Child Project was created outside the bounded Workdesk projects directory.");
  }

  await waitForRenderer(options.window,
    `document.querySelector("#editor")?.dataset.smokeReady === "workdesk"`,
    "the Workdesk smoke renderer");
  await runOverflowAction(options.window, "open-workdesk", "opening the Workdesk through Explorer actions");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && document.querySelector("[data-workdesk-project-shortcut]") !== null && [...document.querySelectorAll("#explorer-tree [data-explorer-section]")].map((item) => item.dataset.explorerSection).join(",") === "projects,files"`,
    "Workdesk shortcuts in the Explorer root");
  const workdeskHierarchy = await options.window.webContents.executeJavaScript(`(() => ({
    primaryActions: [...document.querySelectorAll("#project-primary-actions > .project-menu-anchor > #project-new, #workdesk-project-actions > #workdesk-new-project")].map((button) => button.textContent?.trim()),
    overflowName: document.querySelector("#project-overflow")?.getAttribute("aria-label") ?? null,
    addExistingVisible: document.querySelector("#workdesk-register-project")?.hidden === false,
    legacyCreate: document.querySelector("#project-create") !== null,
    title: document.querySelector("#workspace-document-name")?.textContent?.trim() ?? null
  }))()`, true) as { primaryActions: string[]; overflowName: string | null; addExistingVisible: boolean; legacyCreate: boolean; title: string | null };
  if (workdeskHierarchy.primaryActions.join(",") !== "+ New,New Project"
    || workdeskHierarchy.overflowName !== "More Workdesk actions"
    || !workdeskHierarchy.addExistingVisible || workdeskHierarchy.legacyCreate
    || workdeskHierarchy.title !== "H Smoke Desk") {
    throw new Error(`Workdesk Explorer hierarchy did not match the normal-user layout: ${JSON.stringify(workdeskHierarchy)}.`);
  }
  const originalSize = options.window.getSize();
  options.window.setSize(420, 640);
  await delay(60);
  const narrowWorkdesk = await options.window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector("#workspace-navigation");
    const actions = document.querySelector("#project-primary-actions");
    const trigger = document.querySelector("#project-overflow");
    const menu = document.querySelector("#project-overflow-menu");
    if (!(panel instanceof HTMLElement) || !(actions instanceof HTMLElement)
      || !(trigger instanceof HTMLButtonElement) || !(menu instanceof HTMLElement)) return false;
    trigger.click();
    const panelRect = panel.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const fits = panel.scrollWidth <= panel.clientWidth + 1
      && actions.scrollWidth <= actions.clientWidth + 1
      && !menu.hidden
      && menuRect.left >= panelRect.left - 1
      && menuRect.right <= panelRect.right + 1;
    trigger.click();
    return {
      fits: fits && menu.hidden && trigger.getAttribute("aria-expanded") === "false",
      panel: { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, left: panelRect.left, right: panelRect.right },
      actions: { scrollWidth: actions.scrollWidth, clientWidth: actions.clientWidth },
      menu: { left: menuRect.left, right: menuRect.right, hiddenAfterClose: menu.hidden }
    };
  })()`, true) as { fits: boolean; panel?: unknown; actions?: unknown; menu?: unknown };
  options.window.setSize(originalSize[0], originalSize[1]);
  await delay(60);
  if (!narrowWorkdesk.fits) throw new Error(`Workdesk Explorer overflowed or its anchored menu clipped at 420px width: ${JSON.stringify(narrowWorkdesk)}.`);
  const workdeskMenuKeyboard = await options.window.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector("#project-overflow");
    const menu = document.querySelector("#project-overflow-menu");
    const first = document.querySelector("#workdesk-register-project");
    if (!(trigger instanceof HTMLButtonElement) || !(menu instanceof HTMLElement) || !(first instanceof HTMLButtonElement)) return false;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    return new Promise((resolve) => queueMicrotask(() => {
      const opened = !menu.hidden && trigger.getAttribute("aria-expanded") === "true" && document.activeElement === first;
      if (!opened) return resolve(false);
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      resolve(menu.hidden && trigger.getAttribute("aria-expanded") === "false" && document.activeElement === trigger);
    }));
  })()`, true) as boolean;
  if (!workdeskMenuKeyboard) throw new Error("Workdesk overflow keyboard focus or Escape dismissal failed.");

  const projectPickerCountBeforeNew = options.projectPickerInvocationCount();
  const workdeskPickerCountBeforeNew = options.workdeskPickerInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-new-project"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "starting New Project from Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#project-create-form")?.hidden === false`,
    "the inline New Project title form");
  await runRendererAction(options.window,
    `(() => { const input = document.querySelector("#create-project-title"); const form = document.querySelector("#project-create-form"); if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false; input.value = "H Smoke Project C"; form.requestSubmit(); return true; })()`,
    "creating a Project with the Workdesk title form");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === "H Smoke Project C" && [...document.querySelectorAll("#explorer-tree [data-explorer-section]")].map((item) => item.dataset.explorerSection).join(",") === "files"`,
    "New Project opening immediately");
  if (options.projectPickerInvocationCount() !== projectPickerCountBeforeNew
    || options.workdeskPickerInvocationCount() !== workdeskPickerCountBeforeNew) {
    throw new Error("New Project opened a folder picker.");
  }
  const registrationsAfterNew = await options.workdesks.listRegisteredProjects(workdesk);
  const projectCEntry = registrationsAfterNew.find((project) => project.title === "H Smoke Project C");
  if (!projectCEntry) throw new Error("New Project was not registered with the Workdesk.");
  const projectC = await options.workdesks.resolveRegisteredProject(workdesk, projectCEntry.projectIdentityId);
  const { parseFolderMarkerText } = await import("@maginalia/repository-core");
  const projectCMarker = parseFolderMarkerText(await readFile(path.join(projectC.canonicalRoot, "project.magi"), "utf8"));
  if (projectCMarker.type !== "project" || projectCMarker.parent !== workdesk.identity.id) {
    throw new Error("New Project did not retain the current Workdesk parent identity.");
  }

  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk after New Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk after New Project");
  const projectPickerCountBeforeAdd = options.projectPickerInvocationCount();
  const registrationPromptCountBeforeAdd = options.registrationPromptInvocationCount();
  await runOverflowAction(options.window, "workdesk-register-project", "adding an existing Project from Workdesk");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === "H Smoke 外部 Project"`,
      "opening the added existing Project immediately");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      error: document.querySelector("#workspace-error")?.textContent ?? null,
      projectPickerCount: ${options.projectPickerInvocationCount()},
      shortcuts: [...document.querySelectorAll("[data-workdesk-project-shortcut]")].map((button) => button.textContent)
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }
  if (options.projectPickerInvocationCount() !== projectPickerCountBeforeAdd + 1) {
    throw new Error("Add existing Project did not use exactly one folder selection.");
  }
  if (options.registrationPromptInvocationCount() !== registrationPromptCountBeforeAdd + 1) {
    throw new Error("Add existing Project did not ask for Workdesk registration confirmation.");
  }
  const registrationsAfterAdd = await options.workdesks.listRegisteredProjects(workdesk);
  if (registrationsAfterAdd.length !== 4
    || !registrationsAfterAdd.some((project) => project.title === "H Smoke 外部 Project" && project.available)) {
    throw new Error("Add existing Project did not persist its portable registration and local mapping.");
  }
  const projectPickerCountAfterAdd = options.projectPickerInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk after Add existing Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk after Add existing Project");
  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes("H Smoke 外部 Project")); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "reopening the added Project from its Workdesk registration");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === "H Smoke 外部 Project"`,
    "the registered Project opening without a folder picker");
  if (options.projectPickerInvocationCount() !== projectPickerCountAfterAdd) {
    throw new Error("Opening a registered Project prompted for a folder again.");
  }
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk after reopening the registered Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk before the existing navigation checks");

  const registrationsBeforeNo = await options.workdesks.listRegisteredProjects(workdesk);
  const pickerCountBeforeNo = options.projectPickerInvocationCount();
  const promptCountBeforeNo = options.registrationPromptInvocationCount();
  await runOverflowAction(options.window, "workdesk-register-project", "choosing No in the existing Project registration prompt");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "staying on Workdesk after choosing No");
  const registrationsAfterNo = await options.workdesks.listRegisteredProjects(workdesk);
  if (options.projectPickerInvocationCount() !== pickerCountBeforeNo + 1
    || options.registrationPromptInvocationCount() !== promptCountBeforeNo + 1
    || registrationsAfterNo.length !== registrationsBeforeNo.length
    || registrationsAfterNo.some((entry) => entry.title === "H Smoke Cancel Project")) {
    throw new Error("Choosing No opened or registered the selected Project.");
  }

  const pickerCountBeforeUnregisteredOpen = options.projectPickerInvocationCount();
  const promptCountBeforeUnregisteredOpen = options.registrationPromptInvocationCount();
  await runOverflowAction(options.window, "workdesk-register-project", "choosing Open without registration in the existing Project prompt");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
    "opening a Project without registering it");
  if (options.projectPickerInvocationCount() !== pickerCountBeforeUnregisteredOpen + 1
    || options.registrationPromptInvocationCount() !== promptCountBeforeUnregisteredOpen + 1) {
    throw new Error("Opening without registration skipped folder selection or registration confirmation.");
  }
  const registrationsAfterUnregisteredOpen = await options.workdesks.listRegisteredProjects(workdesk);
  if (registrationsAfterUnregisteredOpen.length !== registrationsBeforeNo.length
    || registrationsAfterUnregisteredOpen.some((entry) => entry.title === "H Smoke Unregistered Project")) {
    throw new Error("Open without registration added the Project to Workdesk.");
  }
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning Home after opening an unregistered Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk after returning from an unregistered Project");
  if ((await options.workdesks.lastActiveContext(workdesk)).kind !== "home") {
    throw new Error("Open without registration did not leave Workdesk as the saved startup context.");
  }

  await runRendererAction(options.window,
    `(() => { const file = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].find((button) => button.dataset.explorerFileName === "memo.md"); if (!(file instanceof HTMLButtonElement)) return false; file.click(); return true; })()`,
    "opening the Workdesk memo");
  await waitForRenderer(options.window,
    `document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName === "memo.md"`,
    "the active Workdesk memo");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#editor")?.dataset.smokeText?.includes("H Smoke Memo")`,
      "the open Workdesk document");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      fileButtons: [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].map((button) => button.dataset.explorerFileName),
      activeFile: document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName ?? null,
      editorText: document.querySelector("#editor")?.dataset.smokeText ?? null,
      documentStatus: document.querySelector("#document-status")?.textContent ?? null,
      error: document.querySelector("#workspace-error")?.textContent ?? null
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }

  const parentText = await options.window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dataset.smokeText ?? null`, true
  ) as string | null;
  if (parentText === null) throw new Error("The Workdesk memo text was unavailable to the smoke harness.");
  const dirtyParentText = `${parentText}\nH Smoke unsaved update`;
  await runRendererAction(options.window,
    `(() => { const editor = document.querySelector("#editor"); if (!(editor instanceof HTMLElement)) return false; editor.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\\nH Smoke unsaved update" })); return true; })()`,
    "editing the open Workdesk document");
  await waitForRenderer(options.window,
    `document.querySelector("#editor")?.dataset.smokeText === ${JSON.stringify(dirtyParentText)}`,
    "the dirty Workdesk document text");

  await openPaletteShortcut(options.window, "commands");
  const projectQuickPick = await searchPalette(options.window, "project: H Smoke Project B");
  if (projectQuickPick?.rows !== 1
    || projectQuickPick.title !== "「H Smoke Project B」を開く"
    || projectQuickPick.commandId !== "maginalia.workdesk.openProject"
    || projectQuickPick.providerId !== "project"
    || projectQuickPick.category !== "Workdesk Project") {
    throw new Error(`Quick Open did not expose the available registered Project by display name: ${JSON.stringify(projectQuickPick)}.`);
  }
  await activatePaletteSelection(options.window, "opening Project B from the Project name picker");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
      "Project B and the global Home action");
    await waitForRenderer(options.window,
      `[...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
      "Project B's uniquely copied memo");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      homeDisabled: document.querySelector("#workdesk-home")?.disabled ?? null,
      shortcuts: [...document.querySelectorAll("[data-workdesk-project-shortcut]")].map((button) => ({
        id: button.dataset.workdeskProjectShortcut,
        text: button.textContent,
      })),
      error: document.querySelector("#workspace-error")?.textContent ?? null,
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }
  const projectBRegistration = (await options.workdesks.listRegisteredProjects(workdesk))
    .find((project) => project.title === "H Smoke Project B");
  if (!projectBRegistration?.available) throw new Error("The Quick Open target Project is no longer registered and available.");
  const projectBRoot = (await options.workdesks.resolveRegisteredProject(workdesk, projectBRegistration.projectIdentityId)).canonicalRoot;
  const memoPath = path.join(projectBRoot, "memo.md");
  const memoBytesBeforeQuickOpen = await readFile(memoPath);
  await openPaletteShortcut(options.window, "files");
  const fileQuickPick = await searchPalette(options.window, "file: memo.md");
  if (fileQuickPick?.rows !== 1
    || fileQuickPick.title !== "memo.md"
    || fileQuickPick.commandId !== "maginalia.project.openFile"
    || fileQuickPick.providerId !== "file"
    || fileQuickPick.category !== "Project document") {
    throw new Error(`Quick Open did not expose the active Project document by display name: ${JSON.stringify(fileQuickPick)}.`);
  }
  await activatePaletteSelection(options.window, "opening memo.md from Project Quick Open");
  await waitForRenderer(options.window,
    `document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName === "memo.md"`,
    "the Quick Open manuscript in the active Project");
  const tabsAfterFirstQuickOpen = await options.window.webContents.executeJavaScript(
    `document.querySelectorAll("#document-tabs .document-tab").length`, true
  ) as number;
  await openPaletteShortcut(options.window, "files");
  await searchPalette(options.window, "file: memo.md");
  await activatePaletteSelection(options.window, "reopening memo.md from Project Quick Open");
  await waitForRenderer(options.window,
    `document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName === "memo.md"`,
    "the already-open Quick Open manuscript");
  const tabsAfterRepeatedQuickOpen = await options.window.webContents.executeJavaScript(
    `document.querySelectorAll("#document-tabs .document-tab").length`, true
  ) as number;
  if (tabsAfterRepeatedQuickOpen !== tabsAfterFirstQuickOpen
    || !(await readFile(memoPath)).equals(memoBytesBeforeQuickOpen)) {
    throw new Error("Opening a Project document by name duplicated its tab or changed source bytes.");
  }

  const sourceTextBeforeFind = await options.window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dataset.smokeText ?? null`, true
  ) as string | null;
  if (sourceTextBeforeFind === null) throw new Error("The active Project source was unavailable for Find smoke.");
  await openPaletteShortcut(options.window, "commands");
  const findCommand = await searchPalette(options.window, "> 本文内を検索");
  if (findCommand?.commandId !== "maginalia.editor.findInDocument") {
    throw new Error(`The native Find command was missing from the action palette: ${JSON.stringify(findCommand)}.`);
  }
  await activatePaletteSelection(options.window, "running the registered native Find command");
  await waitForRenderer(options.window,
    `document.querySelector(".monaco-editor .find-widget")?.classList.contains("visible") === true`,
    "Monaco's native Find widget");
  await openPaletteShortcut(options.window, "commands");
  const replaceCommand = await searchPalette(options.window, "> 本文内を置換");
  if (replaceCommand?.commandId !== "maginalia.editor.replaceInDocument") {
    throw new Error(`The native Replace command was missing from the action palette: ${JSON.stringify(replaceCommand)}.`);
  }
  await activatePaletteSelection(options.window, "running the registered native Replace command");
  await waitForRenderer(options.window,
    `document.querySelector(".monaco-editor .find-widget")?.classList.contains("replaceToggled") === true`,
    "Monaco's native Find and Replace widget");
  const sourceTextAfterFind = await options.window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dataset.smokeText ?? null`, true
  ) as string | null;
  if (sourceTextAfterFind !== sourceTextBeforeFind || !(await readFile(memoPath)).equals(memoBytesBeforeQuickOpen)) {
    throw new Error("Opening native Find and Replace modified the manuscript source.");
  }
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#document-preview-mode"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "showing Preview after native Find and Replace");
  await waitForRenderer(options.window,
    `document.querySelector("#document-preview-mode")?.getAttribute("aria-pressed") === "true"`,
    "Preview mode after native Find and Replace");
  await openPaletteShortcut(options.window, "commands");
  const previewFindCommand = await searchPalette(options.window, "> 本文内を検索");
  if (previewFindCommand?.rows !== 0) {
    throw new Error(`Native source Find remained available in Preview mode: ${JSON.stringify(previewFindCommand)}.`);
  }
  await runRendererAction(options.window, `(() => {
    const input = document.querySelector(".command-palette > input");
    if (!(input instanceof HTMLInputElement)) return false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  })()`, "closing the Preview-mode command palette");
  await waitForRenderer(options.window,
    `document.querySelector(".command-palette")?.hidden === true`,
    "Preview-mode Command Palette Escape");
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#document-edit-mode"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "returning to source editing after Find and Replace smoke");
  await waitForRenderer(options.window,
    `document.querySelector("#document-edit-mode")?.getAttribute("aria-pressed") === "true"`,
    "source editing after Find and Replace smoke");

  const projectBDisplayName = await options.window.webContents.executeJavaScript(
    `document.querySelector("#workspace-document-name")?.textContent ?? ""`, true
  ) as string;
  if (!projectBDisplayName) throw new Error("Project B did not expose its active repository name.");
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk through the global Home action");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && document.querySelector("[data-workdesk-project-shortcut]") !== null && document.querySelector("#workdesk-home")?.disabled === true && document.querySelector("#workdesk-home")?.getAttribute("aria-pressed") === "true"`,
    "the returned Workdesk and its shortcuts");
  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes("H Smoke Project A")); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "opening Project A from the Workdesk after returning Home");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent !== ${JSON.stringify(projectBDisplayName)} && ![...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
    "Project A after returning from Project B");
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk before reopening the memo");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "the Workdesk before reactivating the memo");
  await runRendererAction(options.window,
    `(() => { const file = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].find((button) => button.dataset.explorerFileName === "memo.md"); if (!(file instanceof HTMLButtonElement)) return false; file.click(); return true; })()`,
    "reactivating the Workdesk memo after return");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName === "memo.md" && document.querySelector("#editor")?.dataset.smokeText === ${JSON.stringify(dirtyParentText)}`,
      "the unchanged Workdesk memo text after return");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      fileButtons: [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].map((button) => button.dataset.explorerFileName),
      activeFile: document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName ?? null,
      shortcuts: document.querySelectorAll("[data-workdesk-project-shortcut]").length,
      homeDisabled: document.querySelector("#workdesk-home")?.disabled ?? null,
      homeSelected: document.querySelector("#workdesk-home")?.getAttribute("aria-pressed") ?? null,
      editorText: document.querySelector("#editor")?.dataset.smokeText ?? null,
      expectedText: ${JSON.stringify(dirtyParentText)},
      error: document.querySelector("#workspace-error")?.textContent ?? null
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }

  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes("H Smoke Project B")); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "reopening Project B for unavailable-root coverage");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === ${JSON.stringify(projectBDisplayName)} && document.querySelector("#workdesk-home")?.disabled === false && [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
    "Project B Home action before root invalidation");
  const pickerCountBeforeRestoreFailure = options.workdeskPickerInvocationCount();
  const identityPath = path.join(workdesk.canonicalRoot, "workdesk.magi");
  const identityBytes = await readFile(identityPath);
  await unlink(identityPath);
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "returning after the remembered Workdesk loses its marker");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-recovery")?.hidden === false && document.querySelector("#workspace-repair")?.hidden === false && Boolean(document.querySelector("#workspace-recovery-message")?.textContent?.includes("ファイルはそのまま利用できます")) && document.querySelector("#workspace-error")?.hidden !== false`,
    "the visible Workdesk identity recovery message");
  await waitForRenderer(options.window,
    `[...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
    "the readable loose Workdesk memo in identity recovery");
  if (options.workdeskPickerInvocationCount() !== pickerCountBeforeRestoreFailure) {
    throw new Error("Returning to a Workdesk missing its marker opened a folder picker.");
  }
  try {
    await readFile(identityPath);
    throw new Error("Ordinary return recreated the missing Workdesk marker.");
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeFile(identityPath, identityBytes);
}

/**
 * Acceptance path against caller-provided real folders. The folder picker is
 * injected by the Electron smoke host, while every open/register/navigation
 * action runs through the normal renderer and IPC path.
 */
export async function runHNavigationAcceptanceSmoke(options: {
  readonly window: BrowserWindow;
  readonly workdeskRoot: string;
  readonly projectRoot: string;
  readonly restore: boolean;
  readonly workdesks: WorkdeskService;
  readonly workdeskPickerInvocationCount: () => number;
  readonly projectPickerInvocationCount: () => number;
  readonly registrationPromptInvocationCount: () => number;
}): Promise<void> {
  const workdesk = await options.workdesks.open(options.workdeskRoot);
  const project = await options.workdesks.validateExternalProject(options.projectRoot, {
    expectedWorkdeskIdentityId: workdesk.identity.id,
    requireExistingMarker: true,
  });
  const projectTitle = project.projectIdentity.title;
  const projectId = project.projectIdentity.id;
  if (project.projectIdentity.kind !== "project" || !projectTitle) {
    throw new Error("The real acceptance folder is not a valid Project marker.");
  }

  if (options.restore) {
    const restoredWorkdesk = await options.workdesks.restorePrimary();
    if (!restoredWorkdesk || "kind" in restoredWorkdesk
      || restoredWorkdesk.identity.id !== workdesk.identity.id
      || path.resolve(restoredWorkdesk.canonicalRoot) !== path.resolve(options.workdeskRoot)) {
      throw new Error("The real Workdesk did not restore from the saved local mapping.");
    }
    const registrations = await options.workdesks.listRegisteredProjects(restoredWorkdesk);
    const registered = registrations.find((entry) => entry.projectIdentityId === projectId);
    if (!registered?.available || registrations.filter((entry) => entry.projectIdentityId === projectId).length !== 1) {
      throw new Error("The real Project registration was missing, unavailable, or duplicated after restart.");
    }
    const lastActive = await options.workdesks.lastActiveContext(restoredWorkdesk);
    if (lastActive.kind !== "project" || lastActive.projectIdentityId !== projectId) {
      throw new Error("The last active real Project was not restored after restart.");
    }
    try {
      await waitForRenderer(options.window,
        `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
        "the real Project restored on application startup");
    } catch (error) {
      const ui = await options.window.webContents.executeJavaScript(`(() => ({
        label: document.querySelector("#workspace-label")?.textContent ?? null,
        title: document.querySelector("#workspace-document-name")?.textContent ?? null,
        error: document.querySelector("#workspace-error")?.textContent ?? null,
        recovery: document.querySelector("#workspace-recovery-message")?.textContent ?? null,
        homeDisabled: document.querySelector("#workdesk-home")?.disabled ?? null,
        shortcuts: [...document.querySelectorAll("[data-workdesk-project-shortcut]")].map((item) => item.textContent?.trim())
      }))()`, true);
      const lastActiveContext = await options.workdesks.lastActiveContext(restoredWorkdesk);
      const mapping = await options.workdesks.resolveRegisteredProject(restoredWorkdesk, projectId).then(
        (value) => ({ kind: "resolved", canonicalRoot: value.canonicalRoot }),
        (failure: unknown) => ({ kind: "error", message: failure instanceof Error ? failure.message : String(failure) })
      );
      throw new Error(`${error instanceof Error ? error.message : String(error)} UI=${JSON.stringify(ui)} context=${JSON.stringify(lastActiveContext)} mapping=${JSON.stringify(mapping)}.`);
    }
    if (options.workdeskPickerInvocationCount() !== 0 || options.projectPickerInvocationCount() !== 0) {
      throw new Error("Startup restore opened a folder picker.");
    }

    await runRendererAction(options.window,
      `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
      "returning to the real Workdesk after restart");
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Workdesk" && [...document.querySelectorAll("[data-workdesk-project-shortcut]")].some((button) => button.textContent?.includes(${JSON.stringify(projectTitle)}))`,
      "the saved Project in the restored Workdesk list");
    await runRendererAction(options.window,
      `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes(${JSON.stringify(projectTitle)})); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
      "opening the real Project from its saved Workdesk registration");
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
      "the real Project opening without a folder picker after restart");
    if (options.workdeskPickerInvocationCount() !== 0 || options.projectPickerInvocationCount() !== 0) {
      throw new Error("Opening a saved Project after restart opened a folder picker.");
    }
    return;
  }

  await waitForRenderer(options.window,
    `document.querySelector("#editor")?.dataset.smokeReady === "workdesk"`,
    "the Workdesk acceptance renderer");
  const workdeskPickersBeforeOpen = options.workdeskPickerInvocationCount();
  await runOverflowAction(options.window, "open-workdesk", "opening the real Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && document.querySelector("#workdesk-register-project") !== null`,
    "the real Workdesk Home");
  if (options.workdeskPickerInvocationCount() !== workdeskPickersBeforeOpen + 1) {
    throw new Error("Opening the real Workdesk did not use exactly one folder picker.");
  }

  const beforeAdd = await options.workdesks.listRegisteredProjects(workdesk);
  const projectPickersBeforeAdd = options.projectPickerInvocationCount();
  const registrationPromptsBeforeAdd = options.registrationPromptInvocationCount();
  await runOverflowAction(options.window, "workdesk-register-project", "adding the real Project to Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
    "the real Project opening immediately after Add existing Project");
  if (options.projectPickerInvocationCount() !== projectPickersBeforeAdd + 1) {
    throw new Error("Add existing Project did not use exactly one folder picker.");
  }
  if (options.registrationPromptInvocationCount() !== registrationPromptsBeforeAdd + 1) {
    throw new Error("Add existing Project did not ask for Workdesk registration confirmation.");
  }
  const afterAdd = await options.workdesks.listRegisteredProjects(workdesk);
  const registered = afterAdd.filter((entry) => entry.projectIdentityId === projectId);
  if (registered.length !== 1 || !registered[0]?.available
    || afterAdd.length !== beforeAdd.length + (beforeAdd.some((entry) => entry.projectIdentityId === projectId) ? 0 : 1)) {
    throw new Error("Adding the real Project did not persist one available registration.");
  }
  const resolved = await options.workdesks.resolveRegisteredProject(workdesk, projectId);
  if (path.resolve(resolved.canonicalRoot) !== path.resolve(options.projectRoot)) {
    throw new Error("The real Project registration resolved to a different folder.");
  }

  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to the real Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && [...document.querySelectorAll("[data-workdesk-project-shortcut]")].some((button) => button.textContent?.includes(${JSON.stringify(projectTitle)}))`,
    "the registered real Project in the Workdesk list");
  const projectPickersBeforeRegisteredOpen = options.projectPickerInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes(${JSON.stringify(projectTitle)})); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "opening the registered real Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
    "the registered real Project without another picker");
  if (options.projectPickerInvocationCount() !== projectPickersBeforeRegisteredOpen) {
    throw new Error("Opening the registered real Project prompted for a folder again.");
  }
  await waitForLastActiveProject(options.workdesks, workdesk, projectId);
}
