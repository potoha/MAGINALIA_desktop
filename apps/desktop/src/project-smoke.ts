import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 15_000;

interface ProjectRendererState {
  readonly ready: boolean;
  readonly projectName: string;
  readonly files: readonly string[];
  readonly activeFile: string | null;
  readonly text: string;
  readonly status: string;
  readonly saveEnabled: boolean;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const project = document.querySelector("#workspace-document-name");
  const list = document.querySelector("#explorer-tree");
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  if (!editor || editor.dataset.smokeReady !== "project" || !project || !list || !status || !save) return null;
  const buttons = [...list.querySelectorAll("button[data-explorer-file-id]")];
  const active = buttons.find((button) => button.getAttribute("aria-current") === "page");
  return {
    ready: true,
    projectName: project.textContent ?? "",
    files: buttons.map((button) => button.dataset.explorerFileName ?? button.textContent ?? ""),
    activeFile: active?.dataset.explorerFileName ?? active?.textContent ?? null,
    text: editor.dataset.smokeText ?? "",
    status: status.dataset.state ?? "",
    saveEnabled: !save.disabled
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readState(window: BrowserWindow): Promise<ProjectRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as ProjectRendererState | null;
  } catch (_error: unknown) {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: ProjectRendererState) => boolean,
  description: string,
): Promise<ProjectRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let last: ProjectRendererState | null = null;
  while (Date.now() < deadline) {
    last = await readState(window);
    if (last && predicate(last)) return last;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Project smoke timed out waiting for ${description}. Last state: ${last ? JSON.stringify(last) : "unavailable"}.`);
}

async function runScript(window: BrowserWindow, script: string, description = "renderer action"): Promise<void> {
  const result = await window.webContents.executeJavaScript(script, true) as boolean;
  if (!result) throw new Error(`Project smoke ${description} was unavailable.`);
}

async function assertProjectPanelFits(window: BrowserWindow): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector("#workspace-navigation");
    if (!(panel instanceof HTMLElement)) return { fits: false, reason: "panel-missing" };
    return {
      fits: panel.scrollWidth <= panel.clientWidth + 1,
      scrollWidth: panel.scrollWidth,
      clientWidth: panel.clientWidth,
      children: [...panel.children].map((child) => ({
        className: child instanceof HTMLElement ? child.className : "",
        scrollWidth: child.scrollWidth,
        clientWidth: child.clientWidth,
        width: child.getBoundingClientRect().width
      }))
    };
  })()`, true) as { fits: boolean; scrollWidth?: number; clientWidth?: number; reason?: string; children?: readonly unknown[] };
  if (!result.fits) {
    throw new Error(`Project panel overflow: ${result.reason ?? `${result.scrollWidth} > ${result.clientWidth}`}; children=${JSON.stringify(result.children ?? [])}`);
  }
}

async function setProjectSmokeViewport(window: BrowserWindow): Promise<void> {
  window.setSize(420, 640);
  // A hidden/minimized Electron window may never service a renderer
  // requestAnimationFrame. Force one synchronous layout read, then yield to
  // the host so the resize styles settle without making the smoke hang.
  await window.webContents.executeJavaScript("document.body?.offsetWidth ?? 0", true);
  await delay(50);
}

async function createProjectFileThroughHeader(
  window: BrowserWindow,
  title: string,
  documentType: "memo" | "draft" | "body" | "other",
): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const plus = document.querySelector("#project-new");
    const type = document.querySelector('[data-document-type="${documentType}"]');
    const inline = document.querySelector("#project-inline-create");
    const inlineType = document.querySelector("#project-inline-document-type");
    const menu = document.querySelector("#project-new-menu");
    const fail = (step) => ({ ok: false, step });
    if (!(plus instanceof HTMLButtonElement) || !(type instanceof HTMLButtonElement)
      || !(inline instanceof HTMLElement) || !(inlineType instanceof HTMLElement) || !(menu instanceof HTMLElement)) return fail("elements");
    plus.click(); type.click();
    if (inline.hidden || !menu.hidden || inlineType.textContent !== ${JSON.stringify(documentType)}
      || inline.scrollWidth > inline.clientWidth + 1) {
      const detail = inline.hidden ? "hidden" : "overflow " + inline.scrollWidth + " > " + inline.clientWidth;
      return fail("inline " + detail + " " + inlineType.textContent);
    }
    const titleInput = document.querySelector("#new-file-title");
    if (!(titleInput instanceof HTMLInputElement)) return fail("title-input");
    titleInput.value = ${JSON.stringify(title)};
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    titleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return { ok: true };
  })()`, true) as { ok: boolean; step?: string };
  if (!result.ok) throw new Error(`Project create-file header smoke failed at ${result.step ?? "unknown"}.`);
}

async function exerciseProjectEscape(window: BrowserWindow): Promise<void> {
  await runScript(window, `(() => {
    const plus = document.querySelector("#project-new");
    const type = document.querySelector('[data-document-type="memo"]');
    const title = document.querySelector("#new-file-title");
    const inline = document.querySelector("#project-inline-create");
    if (!(plus instanceof HTMLButtonElement) || !(type instanceof HTMLButtonElement)
      || !(title instanceof HTMLInputElement) || !(inline instanceof HTMLElement)) return false;
    plus.click(); type.click(); title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const overflow = document.querySelector("#project-overflow");
    const overflowMenu = document.querySelector("#project-overflow-menu");
    if (!(overflow instanceof HTMLButtonElement) || !(overflowMenu instanceof HTMLElement)) return false;
    overflow.click(); overflowMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return inline.hidden && !plus.disabled && overflowMenu.hidden
      && overflow.getAttribute("aria-expanded") === "false"
      && document.activeElement === overflow;
  })()`, "escape action");
}

async function exerciseProjectMenuKeyboard(window: BrowserWindow): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const plus = document.querySelector("#project-new");
    const newMenu = document.querySelector("#project-new-menu");
    const overflow = document.querySelector("#project-overflow");
    const overflowMenu = document.querySelector("#project-overflow-menu");
    const fail = (step) => ({ ok: false, step });
    if (!(plus instanceof HTMLButtonElement) || !(newMenu instanceof HTMLElement)
      || !(overflow instanceof HTMLButtonElement) || !(overflowMenu instanceof HTMLElement)) return fail("elements");
    const items = (menu) => [...menu.querySelectorAll('button[role="menuitem"]')];
    const keydown = (element, key) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const newItems = items(newMenu);
    const overflowItems = items(overflowMenu).filter((item) => !item.hidden && !item.disabled);
    const allOverflowItems = items(overflowMenu);
    const documentTypes = newItems.map((item) => item.getAttribute("data-document-type")).filter(Boolean).sort();
    if (documentTypes.join(",") !== "body,draft,memo,other"
      || !newMenu.querySelector("#explorer-new-folder")
      || newItems.length !== 5
      || allOverflowItems.length !== 5
      || overflowItems.length !== 4) {
      return fail("menu-items:" + JSON.stringify({
        documentTypes,
        newItems: newItems.map((item) => ({ id: item.id, hidden: item.hidden, disabled: item.disabled })),
        hasNewFolder: Boolean(newMenu.querySelector("#explorer-new-folder")),
        allOverflowItems: allOverflowItems.map((item) => ({ id: item.id, hidden: item.hidden, disabled: item.disabled })),
        overflowItems: overflowItems.map((item) => item.id)
      }));
    }

    plus.focus();
    keydown(plus, "ArrowDown");
    return new Promise((resolve) => queueMicrotask(() => {
      if (newMenu.hidden || plus.getAttribute("aria-expanded") !== "true" || document.activeElement !== newItems[0]) return resolve(fail("new-arrow-down"));
      keydown(newItems[0], "ArrowDown");
      if (document.activeElement !== newItems[1]) return resolve(fail("new-item-arrow-down"));
      keydown(newItems[1], "End");
      if (document.activeElement !== newItems.at(-1)) return resolve(fail("new-end"));
      keydown(newItems.at(-1), "Home");
      if (document.activeElement !== newItems[0]) return resolve(fail("new-home"));
      keydown(newItems[0], "Escape");
      if (!newMenu.hidden || plus.getAttribute("aria-expanded") !== "false" || document.activeElement !== plus) return resolve(fail("new-escape"));

      overflow.focus();
      keydown(overflow, "ArrowUp");
      queueMicrotask(() => {
        if (overflowMenu.hidden || overflow.getAttribute("aria-expanded") !== "true" || document.activeElement !== overflowItems.at(-1)) return resolve(fail("overflow-arrow-up"));
        keydown(overflowItems.at(-1), "Home");
        if (document.activeElement !== overflowItems[0]) return resolve(fail("overflow-home"));
        keydown(overflowItems[0], "End");
        if (document.activeElement !== overflowItems.at(-1)) return resolve(fail("overflow-end"));
        keydown(overflowItems.at(-1), "Escape");
        if (!overflowMenu.hidden || overflow.getAttribute("aria-expanded") !== "false" || document.activeElement !== overflow) {
          return resolve(fail("overflow-escape"));
        }
        overflow.click();
        document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        resolve(overflowMenu.hidden && overflow.getAttribute("aria-expanded") === "false"
          ? { ok: true }
          : fail("outside-dismissal"));
      });
    }));
  })()`, true) as { ok: boolean; step?: string };
  if (!result.ok) throw new Error(`Project menu keyboard smoke failed at ${result.step ?? "unknown"}.`);
}

async function exerciseProjectRowKeyboard(window: BrowserWindow): Promise<void> {
  await runScript(window, `(() => {
    const buttons = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")];
    if (buttons.length < 2 || !(buttons[0] instanceof HTMLButtonElement) || !(buttons.at(-1) instanceof HTMLButtonElement)) return false;
    const activeId = buttons.find((button) => button.getAttribute("aria-current") === "page")?.dataset.explorerFileId;
    const keydown = (element, key) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    buttons[0].focus();
    keydown(buttons[0], "ArrowDown");
    if (buttons[0].classList.contains("selected") || !buttons[1].classList.contains("selected")) return false;
    keydown(buttons[1], "Home");
    if (!buttons[0].classList.contains("selected")) return false;
    keydown(buttons[0], "End");
    if (!buttons.at(-1)?.classList.contains("selected")) return false;
    return buttons.find((button) => button.dataset.explorerFileId === activeId)?.getAttribute("aria-current") === "page";
  })()`);
}

async function exerciseExplorerActions(window: BrowserWindow): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const file = document.querySelector('#explorer-tree button[data-explorer-file-id]');
    const row = file?.closest('.explorer-row');
    const actions = row?.querySelector('.explorer-row-actions');
    if (!(file instanceof HTMLButtonElement) || !(row instanceof HTMLDivElement) || !(actions instanceof HTMLElement)) return null;
    const labels = [...actions.querySelectorAll('button')].map((button) => button.textContent?.trim());
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const hiddenByDefault = getComputedStyle(actions).display === 'none';
    file.focus();
    const fileRect = file.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    return {
      labels,
      hiddenByDefault,
      visibleOnFocusWithin: getComputedStyle(actions).display === 'flex',
      noOverlap: fileRect.right <= actionsRect.left + 1,
      compact: [...actions.querySelectorAll('button')].every((button) => Number.parseFloat(getComputedStyle(button).fontSize) <= 12)
    };
  })()`, true) as {
    labels: readonly (string | undefined)[];
    hiddenByDefault: boolean;
    visibleOnFocusWithin: boolean;
    noOverlap: boolean;
    compact: boolean;
  } | null;
  if (!result) throw new Error("Project smoke could not locate the real Project Explorer row actions.");
  if (JSON.stringify(result.labels) !== JSON.stringify(["Sync", "Delete"])) {
    throw new Error(`Project Explorer row actions changed unexpectedly: ${JSON.stringify(result.labels)}.`);
  }
  if (!result.hiddenByDefault || !result.visibleOnFocusWithin || !result.noOverlap || !result.compact) {
    throw new Error(`Project Explorer row action layout failed: ${JSON.stringify(result)}.`);
  }
}

export async function runProjectSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const rootName = path.basename(path.resolve(fixtureRoot));
  const fixture = path.join(fixtureRoot, "starter.md");
  const initialText = await readFile(fixture, "utf8");

  await setProjectSmokeViewport(window);
  await waitForState(window, (state) => state.ready && state.status === "empty", "Project renderer readiness");
  await assertProjectPanelFits(window);
  await runScript(window, `(() => {
    const overflow = document.querySelector("#project-overflow");
    const button = document.querySelector("#open-project");
    if (!(overflow instanceof HTMLButtonElement) || !(button instanceof HTMLButtonElement) || button.disabled) return false;
    overflow.click(); button.click(); return true;
  })()`, "open-project overflow action");
  await waitForState(window, (state) => state.projectName === rootName && state.activeFile === "starter.md" && state.text === initialText, "Project and first file");
  const hierarchy = await window.webContents.executeJavaScript(`(() => ({
    label: document.querySelector("#workspace-label")?.textContent?.trim() ?? null,
    newLabel: document.querySelector("#project-new")?.textContent?.trim() ?? null,
    sections: [...document.querySelectorAll("#explorer-tree [data-explorer-section]")].map((item) => item.dataset.explorerSection),
    menuName: document.querySelector("#project-overflow")?.getAttribute("aria-label") ?? null,
    legacyCreate: document.querySelector("#project-create") !== null
  }))()`, true) as { label: string | null; newLabel: string | null; sections: string[]; menuName: string | null; legacyCreate: boolean };
  if (hierarchy.label !== "Project" || hierarchy.newLabel !== "+ New"
    || hierarchy.sections.join(",") !== "files" || hierarchy.menuName !== "More Project actions" || hierarchy.legacyCreate) {
    throw new Error(`Project Explorer hierarchy did not match the normal-user layout: ${JSON.stringify(hierarchy)}.`);
  }
  await assertProjectPanelFits(window);
  await exerciseProjectMenuKeyboard(window);

  await createProjectFileThroughHeader(window, "Smoke memo", "memo");
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.files.includes("Smoke memo.md") && state.status === "saved", "New File open");

  await runScript(window, `(() => { document.querySelector("#editor")?.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\\n追記" })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.status === "modified" && state.saveEnabled, "New File edit");
  await window.webContents.executeJavaScript("document.querySelector('#save-markdown')?.click();", true);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.status === "saved" && !state.saveEnabled, "New File save");

  const saved = await readFile(path.join(fixtureRoot, "Smoke memo.md"), "utf8");
  if (!saved.includes("type: memo") || !saved.includes("追記")) throw new Error("Project smoke saved file did not retain metadata and edit.");
  await exerciseExplorerActions(window);
  await exerciseProjectRowKeyboard(window);
  await runScript(window, `(() => { const button = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].find((candidate) => candidate.dataset.explorerFileName === "starter.md"); if (!(button instanceof HTMLButtonElement)) return false; button.focus(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "starter.md" && state.text === initialText && state.status === "saved", "existing file reopen");
}

export async function runProjectRestoreSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const rootName = path.basename(path.resolve(fixtureRoot));
  const restoredFile = path.join(fixtureRoot, "Smoke memo.md");
  const restoredText = await readFile(restoredFile, "utf8");
  await setProjectSmokeViewport(window);
  await waitForState(
    window,
    (state) => state.ready
      && state.projectName === rootName
      && state.activeFile === "Smoke memo.md"
      && state.text === restoredText
      && state.status === "saved",
    "remembered Project and saved file after restart"
  );
  const readTreeResult = () => window.webContents.executeJavaScript(`(() => {
    const tree = document.querySelector("#explorer-tree");
    const target = [...(tree?.querySelectorAll("button[data-explorer-file-name]") ?? [])]
      .find((button) => button.dataset.explorerFileName === "資料/執筆/深い/研究ノート.md");
    if (!(tree instanceof HTMLUListElement) || !(target instanceof HTMLButtonElement)) return null;
    const ancestors = [];
    let parentList = target.closest(".explorer-node")?.parentElement;
    while (parentList instanceof HTMLUListElement && parentList !== tree) {
      const folder = parentList.parentElement;
      if (!(folder instanceof HTMLLIElement) || !folder.dataset.explorerFolderId) return null;
      ancestors.push(folder.querySelector(":scope > .explorer-row .explorer-entry-title")?.textContent?.trim() ?? "");
      parentList = folder.parentElement;
    }
    const title = target.querySelector(".explorer-entry-title");
    return {
      ancestors: ancestors.join("/"),
      title: getComputedStyle(title).textOverflow,
      whiteSpace: getComputedStyle(title).whiteSpace
    };
  })()`, true) as Promise<{ ancestors: string; title: string; whiteSpace: string } | null>;
  const treeDeadline = Date.now() + STATE_TIMEOUT_MS;
  let treeResult: { ancestors: string; title: string; whiteSpace: string } | null = null;
  while (Date.now() < treeDeadline) {
    treeResult = await readTreeResult();
    if (treeResult?.ancestors === "深い/執筆/資料") break;
    await delay(POLL_INTERVAL_MS);
  }
  if (!treeResult || treeResult.ancestors !== "深い/執筆/資料" || treeResult.title !== "ellipsis" || treeResult.whiteSpace !== "nowrap") {
    throw new Error(`Project Explorer hierarchy or label truncation failed: ${JSON.stringify(treeResult)}.`);
  }
  await runScript(window, `(() => { const button = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].find((candidate) => candidate.dataset.explorerFileName === "Smoke memo.md"); if (!(button instanceof HTMLButtonElement)) return false; button.focus(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.text === restoredText && state.status === "saved", "reopen saved file after restart");
}
