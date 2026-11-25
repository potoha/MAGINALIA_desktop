import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(scriptPath), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const electronExecutable = path.join(
  repositoryRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron"
);
const marker = "MAGINALIA_ELECTRON_WORKBENCH_UI_SMOKE_OK";
const storageKey = "maginalia.workbench.layout.v1";

function assertTrue(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function runElectron(userDataPath) {
  const child = spawn(electronExecutable, [scriptPath, "--workbench-ui-child", userDataPath], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Electron workbench UI smoke timed out."));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runParent() {
  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-workbench-ui-smoke-"));
    const result = await runElectron(temporaryDirectory);
    if (result.code !== 0 || !result.stdout.includes(marker)) {
      throw new Error(
        `Electron workbench UI smoke failed (exit ${result.code ?? result.signal}).\n${result.stdout}${result.stderr}`
      );
    }
    process.stdout.write(`${result.stdout}${result.stderr}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function waitFor(window, predicate, description) {
  const deadline = Date.now() + 15_000;
  let lastValue;
  while (Date.now() < deadline) {
    const value = await window.webContents.executeJavaScript(predicate, true);
    if (value) return;
    lastValue = value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Workbench UI smoke timed out while waiting for ${description}; last value: ${JSON.stringify(lastValue)}.`);
}

async function reload(window) {
  const loaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  window.webContents.reload();
  await loaded;
  await waitFor(window, "Boolean(document.querySelector('#workbench'))", "the reloaded workbench");
}

async function sendRealPrimaryShortcut(window, selector, key) {
  const setup = await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return false;
    target.focus();
    window.__maginaliaSmokeExpectedKey = ${JSON.stringify(key.toLowerCase())};
    window.__maginaliaSmokeKeyEvents = [];
    if (!window.__maginaliaSmokeKeyProbeInstalled) {
      const originalPreventDefault = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function(...args) {
        const result = originalPreventDefault.apply(this, args);
        if (this instanceof KeyboardEvent
          && this.key.toLowerCase() === window.__maginaliaSmokeExpectedKey
          && (this.ctrlKey || this.metaKey)) {
          window.__maginaliaSmokeKeyEvents.push({
            key: this.key,
            defaultPrevented: this.defaultPrevented,
            targetId: this.target instanceof HTMLElement
              ? (this.target.id || this.target.getAttribute('data-secondary-view-tab'))
              : null,
            via: 'preventDefault'
          });
        }
        return result;
      };
      window.addEventListener('keydown', (event) => {
        if (event instanceof KeyboardEvent
          && event.key.toLowerCase() === window.__maginaliaSmokeExpectedKey
          && (event.ctrlKey || event.metaKey)) {
          window.__maginaliaSmokeKeyEvents.push({
            key: event.key,
            defaultPrevented: event.defaultPrevented,
            targetId: event.target instanceof HTMLElement
              ? (event.target.id || event.target.getAttribute('data-secondary-view-tab'))
              : null,
            via: 'window-capture'
          });
        }
      }, true);
      window.__maginaliaSmokeKeyProbeInstalled = true;
    }
    return document.activeElement === target;
  })()`, true);
  assertTrue(setup, `Could not focus ${selector} for a real Electron keyboard event.`);

  window.show();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const retainedFocus = await window.webContents.executeJavaScript(
    `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      target?.focus();
      return document.activeElement === target;
    })()`, true);
  assertTrue(retainedFocus, `Electron focus left ${selector} before the real keyboard event.`);
  const modifiers = process.platform === "darwin" ? ["meta"] : ["control"];
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: key.toUpperCase(), modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: key.toUpperCase(), modifiers });
  await new Promise((resolve) => setTimeout(resolve, 40));
  return await window.webContents.executeJavaScript("window.__maginaliaSmokeKeyEvents ?? []", true);
}

async function checkQuickOpenNativeFallback(window) {
  const disabledQuickOpen = await sendRealPrimaryShortcut(window, "#library-query", "p");
  assertTrue(disabledQuickOpen.some((event) => event.targetId === "library-query" && event.defaultPrevented),
    `No-Project Quick Open from the Shelf search input must consume Ctrl/Cmd+P: ${JSON.stringify(disabledQuickOpen)}.`);
  const textEditing = await sendRealPrimaryShortcut(window, "#library-query", "a");
  assertTrue(textEditing.some((event) => event.targetId === "library-query" && !event.defaultPrevented),
    `Ctrl/Cmd+A must remain native in the Shelf search input: ${JSON.stringify(textEditing)}.`);

  await window.webContents.executeJavaScript(`localStorage.setItem('maginalia.keybindings.v1', JSON.stringify({
    version: 1,
    overrides: { 'maginalia.workbench.showQuickOpen': 'Mod+Alt+P' }
  }))`, true);
  await reload(window);
  await waitFor(window, "Boolean(document.querySelector('#library-query'))", "the remapped Quick Open search field");
  const remappedDefault = await sendRealPrimaryShortcut(window, "#secondary-view-tabs [data-secondary-view-tab='menu']", "p");
  assertTrue(remappedDefault.some((event) => event.targetId === "secondary-tab-menu" && event.defaultPrevented),
    `Remapped Quick Open must consume its old Ctrl/Cmd+P default on a non-editor surface: ${JSON.stringify(remappedDefault)}.`);
  const remappedUnavailable = await sendRealPrimaryShortcut(window, "#library-query", "p");
  assertTrue(remappedUnavailable.some((event) => event.targetId === "library-query" && event.defaultPrevented),
    `Unavailable remapped Quick Open must not leak its active shortcut from a search field: ${JSON.stringify(remappedUnavailable)}.`);

  await window.webContents.executeJavaScript(`localStorage.setItem('maginalia.keybindings.v1', JSON.stringify({
    version: 1,
    overrides: { 'maginalia.workbench.showQuickOpen': null }
  }))`, true);
  await reload(window);
  await waitFor(window, "Boolean(document.querySelector('#library-query'))", "the unbound Quick Open search field");
  const unboundDefault = await sendRealPrimaryShortcut(window, "#library-query", "p");
  assertTrue(unboundDefault.some((event) => event.targetId === "library-query" && event.defaultPrevented),
    `Unbound Quick Open must consume its old Ctrl/Cmd+P default from a search field: ${JSON.stringify(unboundDefault)}.`);
  const paletteStayedClosed = await window.webContents.executeJavaScript(
    "document.querySelector('.command-palette')?.hidden === true", true);
  assertTrue(paletteStayedClosed, "Quick Open's disabled or shadowed shortcut must not open the Command Palette.");

  await window.webContents.executeJavaScript("localStorage.removeItem('maginalia.keybindings.v1')", true);
  await reload(window);
  await waitFor(window, "Boolean(document.querySelector('#library-query'))", "default Quick Open bindings after the regression test");
}

async function readState(window) {
  return await window.webContents.executeJavaScript(`(() => {
    const region = (selector) => document.querySelector(selector);
    const visual = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        display: style.display,
        visibility: style.visibility,
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        width: rect.width,
        left: rect.left,
        right: rect.right
      };
    };
    const root = region('#workbench');
    const toolbar = region('#workbench-toolbar');
    const activity = region('#activity-bar');
    const primary = region('#primary-sidebar');
    const secondary = region('#secondary-sidebar');
    const secondaryResizer = region('#secondary-sidebar-resizer');
    const editor = region('.editor-area');
    const repositoryPanel = region('#repository-navigation');
    const menuPanel = region('#menu-navigation');
    const secondaryViewTabs = [...document.querySelectorAll('#secondary-view-tabs [role="tab"]')];
    if (!root || !toolbar || !activity || !primary || !secondary || !secondaryResizer || !editor || !repositoryPanel) return null;
    return {
      preloadBridge: typeof window.maginalia?.openMarkdown === 'function',
      editorOnly: root.dataset.editorOnly,
      activityHidden: activity.hidden,
      primaryHidden: primary.hidden,
      secondaryHidden: secondary.hidden,
      primaryWidth: Number(primary.dataset.width),
      secondaryWidth: Number(secondary.dataset.width),
      toolbar: visual(toolbar),
      activity: visual(activity),
      primary: visual(primary),
      secondary: visual(secondary),
      secondaryResizer: visual(secondaryResizer),
      editor: visual(editor),
      activityViewIds: [...document.querySelectorAll('[data-workbench-view]')].map((button) => button.dataset.workbenchView),
      secondaryTabIds: secondaryViewTabs.map((tab) => tab.dataset.secondaryViewTab),
      selectedSecondaryTab: secondaryViewTabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.secondaryViewTab ?? null,
      menuPanelVisible: visual(menuPanel).visible,
      menuContainsDocumentActions: Boolean(menuPanel?.querySelector('#open-markdown, #save-markdown, #export-pdf')),
      toolbarContainsDocumentActions: Boolean(toolbar.querySelector('#open-markdown, #save-markdown, #export-pdf')),
      homeAction: (() => {
        const button = document.querySelector('#workdesk-home');
        return button instanceof HTMLButtonElement
          ? { inToolbar: toolbar.contains(button), disabled: button.disabled, label: button.textContent?.trim() ?? '' }
          : null;
      })(),
      repositoryActivityButton: Boolean(document.querySelector('[data-workbench-view="repository"]')),
      repositoryPanelVisible: visual(repositoryPanel).visible,
      activePrimaryPanel: primary.querySelector('.view-panel-active')?.dataset.workbenchViewPanel ?? null,
      activeSecondaryPanel: secondary.querySelector('.view-panel-active')?.dataset.workbenchViewPanel ?? null,
      viewportWidth: window.innerWidth,
      storedLayout: window.localStorage.getItem(${JSON.stringify(storageKey)})
    };
  })()`, true);
}

async function setStoredLayout(window, state) {
  await window.webContents.executeJavaScript(
    `window.localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(state))})`,
    true
  );
}

async function clickCommand(window, command) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-workbench-command=${JSON.stringify(command)}]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`, true);
  assertTrue(clicked, `Workbench UI smoke could not click ${command}.`);
}

async function clickSecondaryTab(window, viewId) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const tab = document.querySelector('#secondary-view-tabs [data-secondary-view-tab=${JSON.stringify(viewId)}]');
    if (!(tab instanceof HTMLButtonElement)) return false;
    tab.click();
    return true;
  })()`, true);
  assertTrue(clicked, `Workbench UI smoke could not select the ${viewId} secondary tab.`);
  try {
    await waitFor(window,
      `document.querySelector('#secondary-view-tabs [data-secondary-view-tab=${JSON.stringify(viewId)}]')?.getAttribute('aria-selected') === 'true'`,
      `${viewId} secondary tab selection`);
  } catch (error) {
    const state = await window.webContents.executeJavaScript(`(() => ({
      tabs: [...document.querySelectorAll('#secondary-view-tabs [role="tab"]')].map((tab) => ({
        id: tab.dataset.secondaryViewTab, selected: tab.getAttribute('aria-selected')
      })),
      activityMenuPressed: document.querySelector('#activity-view-menu')?.getAttribute('aria-pressed') ?? null,
      documentStatus: document.querySelector('#document-status')?.textContent ?? null,
      activePanel: document.querySelector('#secondary-sidebar .view-panel-active')?.dataset.workbenchViewPanel ?? null,
      storedLayout: window.localStorage.getItem(${JSON.stringify(storageKey)})
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Diagnostic: ${JSON.stringify(state)}`);
  }
}

async function checkExplorerActionLayout(window) {
  const result = await window.webContents.executeJavaScript(`(() => {
    const list = document.createElement('ul');
    list.className = 'explorer-tree';
    list.style.cssText = 'position:fixed;left:0;top:0;width:260px;z-index:9999;background:#fff';
    const node = document.createElement('li');
    node.className = 'explorer-node';
    const row = document.createElement('div');
    row.className = 'explorer-row';
    const file = document.createElement('button');
    file.className = 'explorer-entry-button';
    file.type = 'button';
    file.innerHTML = '<span class="explorer-entry-icon" aria-hidden="true">📄</span><span class="explorer-entry-title">A very long Unicode filename — 日本語の文書タイトル.md</span><small class="explorer-file-type">MEMO</small>';
    const actions = document.createElement('div');
    actions.className = 'explorer-row-actions';
    const sync = document.createElement('button');
    sync.className = 'project-header-action explorer-row-action';
    sync.type = 'button';
    sync.textContent = 'Sync';
    const remove = document.createElement('button');
    remove.className = 'project-header-action explorer-row-action';
    remove.type = 'button';
    remove.textContent = 'Delete';
    actions.append(sync, remove);
    row.append(file, actions);
    node.append(row);
    list.append(node);
    document.body.append(list);
    const hiddenByDefault = getComputedStyle(actions).display === 'none';
    file.focus();
    const visibleOnFocusWithin = getComputedStyle(actions).display === 'flex';
    const fileRect = file.getBoundingClientRect();
    const actionRect = actions.getBoundingClientRect();
    const noOverlap = fileRect.right <= actionRect.left + 1;
    const compactActions = [...actions.querySelectorAll('button')].every((button) => Number.parseFloat(getComputedStyle(button).fontSize) <= 12);
    list.remove();
    return { hiddenByDefault, visibleOnFocusWithin, noOverlap, compactActions };
  })()`, true);
  assertTrue(result.hiddenByDefault, 'Explorer row actions must be quiet by default.');
  assertTrue(result.visibleOnFocusWithin, 'Explorer row actions must appear for keyboard focus within the row.');
  assertTrue(result.noOverlap, 'Explorer row actions must not overlap the file button.');
  assertTrue(result.compactActions, 'Explorer row action typography must remain compact.');
}

async function checkCommandPalette(window) {
  const opened = await window.webContents.executeJavaScript(`(() => {
    const focusTarget = document.querySelector('#secondary-view-tabs [data-secondary-view-tab="library"]');
    focusTarget?.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', bubbles: true, cancelable: true,
      ctrlKey: ${process.platform !== "darwin"}, metaKey: ${process.platform === "darwin"}, shiftKey: true
    }));
    return { active: focusTarget === document.activeElement, hasPalette: Boolean(document.querySelector('.command-palette')) };
  })()`, true);
  assertTrue(opened.hasPalette, 'Command Palette must be mounted in Electron.');
  await waitFor(window, `document.querySelector('.command-palette')?.hidden === false`, 'Ctrl+Shift+P opening the command palette');
  await waitFor(window, `document.querySelector('.command-palette > input') === document.activeElement`, 'Command Palette input focus');

  const paletteState = await window.webContents.executeJavaScript(`(() => {
    const palette = document.querySelector('.command-palette');
    const input = palette?.querySelector('input');
    if (!(palette instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return null;
    input.value = '> palette';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const option = palette.querySelector('.command-palette-item[aria-selected="true"]');
    if (!(option instanceof HTMLElement)) return null;
    const category = option.querySelector('.command-palette-category');
    const description = option.querySelector('.command-palette-description');
    const shortcut = option.querySelector('kbd');
    const match = option.querySelector('mark.command-palette-match');
    const rgb = (value) => {
      const parts = value.match(/[\\d.]+/g)?.map(Number) ?? [];
      return parts.length >= 3 ? parts.slice(0, 3).map((part) => part / 255) : null;
    };
    const luminance = (color) => color?.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0) ?? null;
    const contrast = (foreground, background) => {
      const left = luminance(rgb(foreground));
      const right = luminance(rgb(background));
      return left === null || right === null ? null : (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    };
    const style = (element) => element ? getComputedStyle(element) : null;
    const paletteStyle = style(palette);
    const inputStyle = style(input);
    const optionStyle = style(option);
    const categoryStyle = style(category);
    const descriptionStyle = style(description);
    const shortcutStyle = style(shortcut);
    const matchStyle = style(match);
    const ratios = {
      palette: contrast(paletteStyle.color, paletteStyle.backgroundColor),
      input: contrast(inputStyle.color, inputStyle.backgroundColor),
      message: contrast(style(palette.querySelector('.command-palette-message')).color, paletteStyle.backgroundColor),
      title: contrast(style(option.querySelector('.command-palette-command-title')).color, optionStyle.backgroundColor),
      category: contrast(categoryStyle.color, categoryStyle.backgroundColor),
      description: contrast(descriptionStyle.color, optionStyle.backgroundColor),
      shortcut: contrast(shortcutStyle.color, shortcutStyle.backgroundColor),
      match: contrast(matchStyle.color, matchStyle.backgroundColor),
      focus: contrast(inputStyle.outlineColor, paletteStyle.backgroundColor)
    };
    return {
      rows: [...palette.querySelectorAll('.command-palette-item')].length,
      selected: option.getAttribute('aria-selected'),
      title: option.querySelector('.command-palette-command-title')?.textContent?.trim() ?? '',
      category: category?.textContent?.trim() ?? '',
      description: description?.textContent?.trim() ?? '',
      shortcut: shortcut?.textContent?.trim() ?? '',
      hasHighlight: match !== null,
      ratios,
      activeDescendant: input.getAttribute('aria-activedescendant')
    };
  })()`, true);
  assertTrue(paletteState && paletteState.rows > 0, 'Command Palette must show command results.');
  assertEqual(paletteState.selected, 'true', 'Initial result must be visibly selected.');
  assertTrue(paletteState.title.includes('Command Palette'), 'Command title must be readable.');
  assertTrue(paletteState.category.length > 0, 'Command category must be visible.');
  assertTrue(paletteState.description.length > 0, 'Command description must be visible.');
  assertTrue(paletteState.shortcut.length > 0, 'Effective keyboard shortcut must be visible.');
  assertTrue(paletteState.hasHighlight, 'Matched text must be visibly highlighted.');
  process.stdout.write(`Command Palette contrast ratios: ${JSON.stringify(paletteState.ratios)}\n`);
  for (const [surface, ratio] of Object.entries(paletteState.ratios)) {
    assertTrue(ratio !== null && ratio >= (surface === 'focus' ? 3 : 4.5), `${surface} contrast ${ratio} is below its accessibility target.`);
  }
  const imeKeyConsumed = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.command-palette > input');
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  })()`, true);
  assertEqual(imeKeyConsumed, false, 'IME composition Enter must not activate the selected palette result.');

  const screenshotDirectory = process.env.MAGINALIA_COMMAND_PALETTE_EVIDENCE_DIR;
  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    window.show();
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
    await writeFile(path.join(screenshotDirectory, 'command-palette-selected.png'), (await window.capturePage()).toPNG());
  }

  const navigationState = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.command-palette > input');
    input.value = '> ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const items = [...document.querySelectorAll('.command-palette-item')];
    if (items.length < 2) return { moved: false, rows: items.length, scrolledToSelection: false };
    const list = document.querySelector('.command-palette-results');
    const firstId = document.querySelector('.command-palette-item[aria-selected="true"]')?.id;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const nextId = document.querySelector('.command-palette-item[aria-selected="true"]')?.id;
    for (let index = 1; index < items.length; index += 1) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    }
    const active = document.querySelector('.command-palette-item[aria-selected="true"]');
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    return {
      moved: Boolean(firstId && nextId && firstId !== nextId),
      rows: items.length,
      activeIsLast: active === items.at(-1),
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      activeTop: activeRect.top,
      activeBottom: activeRect.bottom,
      listTop: listRect.top,
      listBottom: listRect.bottom,
      scrolledToSelection: activeRect.top >= listRect.top - 1 && activeRect.bottom <= listRect.bottom + 1
    };
  })()`, true);
  assertTrue(navigationState.moved && navigationState.rows > 1, 'Arrow keys must move the selected result.');
  assertTrue(navigationState.activeIsLast && navigationState.scrolledToSelection, `The selected result must scroll into view: ${JSON.stringify(navigationState)}.`);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.command-palette > input');
    input.value = 'file: no-such-document';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  const emptyState = await window.webContents.executeJavaScript(`({
    rows: document.querySelectorAll('.command-palette-item').length,
    message: document.querySelector('.command-palette-message')?.textContent ?? '',
    visible: document.querySelector('.command-palette-message')?.hidden === false
  })`, true);
  assertEqual(emptyState.rows, 0, 'Unavailable document picker must not return command or file rows.');
  assertTrue(emptyState.visible && emptyState.message.includes('active Project'), 'Empty file mode must explain its active-Project scope.');
  if (screenshotDirectory) {
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
    await writeFile(path.join(screenshotDirectory, 'command-palette-empty.png'), (await window.capturePage()).toPNG());
  }

  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.command-palette > input');
    input.value = '?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  const help = await window.webContents.executeJavaScript(`document.querySelector('.command-palette-message')?.textContent ?? ''`, true);
  assertTrue(help.includes('project:') && help.includes('file:'), 'Quick Pick help must explain both name modes.');
  await window.webContents.executeJavaScript(`document.querySelector('.command-palette > input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`, true);
  await waitFor(window, `document.querySelector('.command-palette')?.hidden === true`, 'Escape cancelling the command palette');
  const restoredFocus = await window.webContents.executeJavaScript(`document.activeElement === document.querySelector('#secondary-view-tabs [data-secondary-view-tab="library"]')`, true);
  assertTrue(restoredFocus, 'Escape must restore focus to the control that opened the palette.');

  await window.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'p', bubbles: true, cancelable: true,
    ctrlKey: ${process.platform !== "darwin"}, metaKey: ${process.platform === "darwin"}, shiftKey: true
  }))`, true);
  await waitFor(window, `document.querySelector('.command-palette')?.hidden === false`, 'reopening the command palette');
  await waitFor(window, `document.querySelector('.command-palette > input') === document.activeElement`, 'reopened Command Palette input focus');
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.command-palette > input');
    input.value = '> settings';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const target = document.querySelector('.command-palette-item[data-command-id="maginalia.settings.open"]');
    const options = [...document.querySelectorAll('.command-palette-item')];
    const targetIndex = options.indexOf(target);
    for (let index = 0; index < targetIndex; index += 1) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`, true);
  await waitFor(window, `document.querySelector('#settings-center')?.open === true`, 'Enter executing a registered Settings command');
  await window.webContents.executeJavaScript(`document.querySelector('#settings-center')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`, true);
  await waitFor(window, `document.querySelector('#settings-center')?.open === false`, 'Settings Escape cancellation');
}

async function resize(window, region, startX, endX) {
  const resized = await window.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('[data-workbench-resize=${JSON.stringify(region)}]');
    if (!(handle instanceof HTMLElement)) return false;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: ${startX} }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${endX} }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${endX} }));
    return true;
  })()`, true);
  assertTrue(resized, `Workbench UI smoke could not resize ${region}.`);
}

async function press(window, key, options = {}) {
  await window.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    ctrlKey: ${Boolean(options.ctrlKey)}, shiftKey: ${Boolean(options.shiftKey)}
  }))`, true);
}

async function runChild(userDataPath) {
  const { app, BrowserWindow, ipcMain } = await import("electron");
  app.setPath("userData", userDataPath);
  await app.whenReady();
  ipcMain.handle("maginalia:update-application-menu", () => undefined);

  const createWindow = () => new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(desktopRoot, "dist", "main", "preload.js")
    }
  });
  let window = createWindow();

  try {
    await window.loadFile(path.join(desktopRoot, "dist", "renderer", "index.html"), {
      query: { smoke: "workbench" }
    });
    await waitFor(window, "Boolean(document.querySelector('#workbench'))", "the workbench");
    await waitFor(window, "Boolean(document.querySelector('.command-palette'))", "Workbench command registration");
    await checkCommandPalette(window);
    await checkQuickOpenNativeFallback(window);

    let state = await readState(window);
    assertTrue(state?.preloadBridge, "Workbench did not receive the existing preload bridge.");
    assertEqual(state.primaryWidth, 300, "Initial primary sidebar width");
    assertEqual(state.secondaryWidth, 300, "Initial secondary sidebar width");
    assertEqual(state.toolbar.visible, true, "Initial toolbar visibility");
    assertEqual(state.activity.visible, true, "Initial activity bar visibility");
    assertEqual(state.primary.visible, true, "Initial primary sidebar visibility");
    assertEqual(state.secondary.visible, true, "Initial secondary sidebar visibility");
    assertTrue(state.editor.visible && state.editor.width > 0, "Initial editor area must have visible width.");
    assertEqual(JSON.stringify(state.activityViewIds), JSON.stringify(["workspace", "library", "menu", "properties"]), "Normal Activity Bar views");
    assertEqual(JSON.stringify(state.secondaryTabIds), JSON.stringify(["library", "menu", "properties"]), "Secondary sidebar tabs");
    assertEqual(state.selectedSecondaryTab, "library", "Initial Shelf tab selection");
    assertEqual(state.menuContainsDocumentActions, true, "Document operations must be mounted in Menu");
    assertEqual(state.toolbarContainsDocumentActions, false, "The top toolbar must not duplicate document operations");
    assertEqual(state.homeAction?.inToolbar, true, "The Workdesk Home action must live in the global toolbar");
    assertEqual(state.homeAction?.disabled, true, "Workdesk Home stays disabled without a remembered primary Workdesk");
    assertEqual(state.homeAction?.label, "← Workdesk", "The global Home action must be explicitly labeled");
    assertEqual(state.repositoryActivityButton, false, "Repository must not have a normal Activity Bar button");
    assertEqual(state.repositoryPanelVisible, false, "Repository panel must be hidden from normal UI");

    await clickSecondaryTab(window, "menu");
    state = await readState(window);
    assertEqual(state.activeSecondaryPanel, "menu", "Menu tab must activate the Menu view");
    assertEqual(state.menuPanelVisible, true, "Menu tab must display its panel");
    await window.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('#secondary-view-tabs [data-secondary-view-tab="menu"]');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    })()`, true);
    await waitFor(window, `document.querySelector('#secondary-view-tabs [data-secondary-view-tab="properties"]')?.getAttribute('aria-selected') === 'true'`, "keyboard tab navigation to Properties");
    await window.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('#secondary-view-tabs [data-secondary-view-tab="properties"]');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    })()`, true);
    await waitFor(window, `document.querySelector('#secondary-view-tabs [data-secondary-view-tab="library"]')?.getAttribute('aria-selected') === 'true'`, "keyboard tab navigation back to Shelf");
    await checkExplorerActionLayout(window);

    await setStoredLayout(window, {
      activityBarVisible: true,
      primarySidebarVisible: true,
      primarySidebarWidth: 300,
      secondarySidebarVisible: true,
      secondarySidebarWidth: 300,
      activePrimaryView: "repository",
      activeSecondaryView: "removed-secondary-view"
    });
    await reload(window);
    state = await readState(window);
    const normalizedUnknownViews = JSON.parse(state.storedLayout ?? "null");
    assertEqual(normalizedUnknownViews.activePrimaryView, "workspace", "Repository view fallback after manifest removal");
    assertEqual(normalizedUnknownViews.activeSecondaryView, "library", "Unknown persisted secondary view fallback");
    assertEqual(state.activePrimaryPanel, "workspace", "Unknown primary view must show the fallback panel");
    assertEqual(state.activeSecondaryPanel, "library", "Unknown secondary view must show the fallback panel");

    await resize(window, "primary-sidebar", 100, 221);
    await resize(window, "secondary-sidebar", 800, 740);
    state = await readState(window);
    assertEqual(state.primaryWidth, 421, "Resized primary sidebar width");
    assertEqual(state.secondaryWidth, 360, "Resized secondary sidebar width");

    await clickCommand(window, "maginalia.view.togglePrimarySidebar");
    state = await readState(window);
    assertEqual(state.primaryHidden, true, "Primary sidebar toggle");
    assertEqual(state.secondaryHidden, false, "Primary toggle must leave secondary sidebar visible");
    assertEqual(state.primary.display, "none", "Primary sidebar must be visually removed");
    assertEqual(state.secondary.visible, true, "Secondary sidebar must remain visually present");

    await clickCommand(window, "maginalia.view.toggleSecondarySidebar");
    state = await readState(window);
    assertEqual(state.primaryHidden, true, "Secondary toggle must preserve primary sidebar state");
    assertEqual(state.secondaryHidden, true, "Secondary sidebar toggle");
    assertEqual(state.primary.display, "none", "Primary sidebar remains visually removed");
    assertEqual(state.secondary.display, "none", "Secondary sidebar must be visually removed");

    await clickCommand(window, "maginalia.view.toggleActivityBar");
    state = await readState(window);
    assertEqual(state.activityHidden, true, "Activity bar toggle");
    assertEqual(state.editorOnly, "true", "All regions hidden should reduce to editor-only mode");
    assertEqual(state.activity.display, "none", "Activity bar must be visually removed");
    assertTrue(state.editor.visible && state.editor.width > 0, "Editor-only mode must retain a visible editor area.");
    const persisted = JSON.parse(state.storedLayout ?? "null");
    assertEqual(persisted.primarySidebarWidth, 421, "Persisted primary sidebar width");
    assertEqual(persisted.secondarySidebarWidth, 360, "Persisted secondary sidebar width");

    await reload(window);
    state = await readState(window);
    assertEqual(state.activityHidden, true, "Reloaded activity bar visibility");
    assertEqual(state.primaryHidden, true, "Reloaded primary sidebar visibility");
    assertEqual(state.secondaryHidden, true, "Reloaded secondary sidebar visibility");
    assertEqual(state.primaryWidth, 421, "Reloaded primary sidebar width");
    assertEqual(state.secondaryWidth, 360, "Reloaded secondary sidebar width");
    assertEqual(state.toolbar.display, "none", "Reloaded editor-only toolbar visibility");
    assertEqual(state.activity.display, "none", "Reloaded editor-only activity visibility");
    assertEqual(state.primary.display, "none", "Reloaded editor-only primary visibility");
    assertEqual(state.secondary.display, "none", "Reloaded editor-only secondary visibility");
    assertTrue(state.editor.visible && state.editor.width > 0, "Reloaded editor-only mode must retain a visible editor area.");

    await press(window, "Escape");
    state = await readState(window);
    assertEqual(state.editorOnly, "false", "Escape must exit a manually hidden shell");
    assertTrue(state.editor.visible && state.editor.width > 0, "Manual-shell Escape must not leave a blank editor.");
    assertTrue(state.toolbar.visible || state.activity.visible, "Manual-shell Escape must restore a usable shell control.");

    await clickCommand(window, "maginalia.view.togglePrimarySidebar");
    await clickCommand(window, "maginalia.view.toggleEditorOnly");
    state = await readState(window);
    assertEqual(state.editorOnly, "true", "Editor-only command");
    assertEqual(state.toolbar.display, "none", "Editor-only command must hide toolbar");
    assertEqual(state.activity.display, "none", "Editor-only command must hide activity bar");
    assertEqual(state.primary.display, "none", "Editor-only command must hide primary sidebar");
    assertEqual(state.secondary.display, "none", "Editor-only command must hide secondary sidebar");
    assertTrue(state.editor.visible && state.editor.width > 0, "Editor-only command must leave only a visible editor area.");

    await press(window, "Escape");
    state = await readState(window);
    assertEqual(state.editorOnly, "false", "Editor-only restoration");
    assertEqual(state.activityHidden, false, "Editor-only restores activity visibility");
    assertEqual(state.primaryHidden, true, "Editor-only restores primary visibility");
    assertEqual(state.secondaryHidden, false, "Editor-only restores secondary visibility");
    assertEqual(state.toolbar.visible, true, "Editor-only restoration must show toolbar");
    assertEqual(state.activity.visible, true, "Editor-only restoration must show activity bar");
    assertEqual(state.primary.display, "none", "Editor-only restoration must preserve primary hidden state");
    assertEqual(state.secondary.visible, true, "Editor-only restoration must preserve secondary visible state");
    assertTrue(state.editor.visible && state.editor.width > 0, "Editor-only restoration must retain editor width.");

    await clickCommand(window, "maginalia.view.togglePrimarySidebar");
    const previousWindow = window;
    window = createWindow();
    await window.loadFile(path.join(desktopRoot, "dist", "renderer", "index.html"), {
      query: { smoke: "workbench" }
    });
    await waitFor(window, "Boolean(document.querySelector('#workbench'))", "the recreated workbench");
    previousWindow.destroy();
    state = await readState(window);
    assertEqual(state.activityHidden, false, "Final activity bar persistence");
    assertEqual(state.primaryHidden, false, "Final primary sidebar persistence");
    assertEqual(state.secondaryHidden, false, "Final secondary sidebar persistence");
    assertEqual(state.primaryWidth, 421, "Final primary width persistence");
    assertEqual(state.secondaryWidth, 360, "Final secondary width persistence");
    assertEqual(state.toolbar.visible, true, "Final toolbar visibility");
    assertEqual(state.activity.visible, true, "Final activity bar visibility");
    assertEqual(state.primary.visible, true, "Final primary sidebar visibility");
    assertEqual(state.secondary.visible, true, "Final secondary sidebar visibility");
    assertTrue(state.editor.visible && state.editor.width > 0, "Final restored editor area must have visible width.");

    window.setSize(420, 480);
    await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
    state = await readState(window);
    assertTrue(state.viewportWidth <= 420, "Tiny-window viewport width");
    assertTrue(
      state.editor.visible && state.editor.width > 0 && state.editor.left < state.viewportWidth && state.editor.right > 0,
      "Tiny window must retain an editor area visible within the viewport."
    );
    const secondaryWithinViewport = state.secondary.right <= state.viewportWidth + 1;
    const secondaryResizerReachable = state.secondaryResizer.visible
      && state.secondaryResizer.left >= 0
      && state.secondaryResizer.right <= state.viewportWidth;
    assertTrue(
      secondaryWithinViewport && secondaryResizerReachable,
      `Tiny window secondary geometry: sidebar=[${state.secondary.left},${state.secondary.right}], `
        + `resizer=[${state.secondaryResizer.left},${state.secondaryResizer.right}], viewport=${state.viewportWidth} (1px edge tolerance).`
    );

    process.stdout.write(`${marker}\n`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  }
}

if (process.argv.includes("--workbench-ui-child")) {
  const userDataPath = process.argv.at(-1);
  if (!userDataPath || userDataPath === "--workbench-ui-child") {
    process.stderr.write("Workbench UI smoke user-data path was not provided.\n");
    process.exitCode = 1;
  } else {
    runChild(userDataPath).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
} else {
  await runParent();
}
