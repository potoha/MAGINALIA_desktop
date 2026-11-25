import { Menu, type BrowserWindow, type MenuItem } from "electron";

const TIMEOUT_MS = 15_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate<T>(window: BrowserWindow, source: string): Promise<T> {
  return await window.webContents.executeJavaScript(source, true) as T;
}

async function waitFor(window: BrowserWindow, source: string, label: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(window, source)) return;
    await delay(30);
  }
  const probe = await evaluate(window, `({dialogOpen:document.querySelector('#settings-center')?.open,active:document.activeElement?.outerHTML?.slice(0,250),status:document.querySelector('.settings-center-status')?.textContent})`);
  throw new Error(`Settings smoke timed out: ${label}; ${JSON.stringify(probe)}`);
}

async function click(window: BrowserWindow, selector: string): Promise<void> {
  const clicked = await evaluate<boolean>(window, `(() => {
    const item = document.querySelector(${JSON.stringify(selector)});
    if (!(item instanceof HTMLElement) || (item instanceof HTMLButtonElement && item.disabled)) return false;
    item.click(); return true;
  })()`);
  if (!clicked) throw new Error(`Settings smoke control unavailable: ${selector}`);
}

async function search(window: BrowserWindow, text: string): Promise<void> {
  await evaluate(window, `(() => {
    const input = document.querySelector('#settings-search');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing Settings search');
    input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
}

async function key(window: BrowserWindow, keyCode: string, modifiers: Array<"control" | "shift" | "alt" | "meta"> = []): Promise<void> {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await delay(100);
}

function menuItem(id: string): MenuItem {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id);
  if (item === undefined || item === null) throw new Error(`Settings smoke menu item missing: ${id}`);
  return item;
}

async function nativeClick(window: BrowserWindow, id: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!menuItem(id).enabled && Date.now() < deadline) await delay(30);
  const item = menuItem(id);
  if (!item.enabled) throw new Error(`Settings smoke menu command is disabled: ${id}`);
  item.click(undefined, window, {});
}

async function closeSettings(window: BrowserWindow): Promise<void> {
  await key(window, "ESCAPE");
  await waitFor(window, "!document.querySelector('#settings-center')?.open", "close Settings with Escape");
}

const commandRow = (id: string): string => `#settings-center [data-command-id="${id}"]`;
const action = (id: string, name: string): string => `${commandRow(id)} [data-action="${name}"]`;
const direction = (expected: string): string => `JSON.parse(localStorage.getItem('maginalia.renderer.preferences.v1') || '{}').defaultWritingDirection === ${JSON.stringify(expected)}`;

async function focusNormalSearch(window: BrowserWindow): Promise<void> {
  await nativeClick(window, "maginalia.view.show.library");
  await evaluate(window, `(() => {
    const input = document.querySelector('#library-query');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing normal Shelf search');
    input.value = '検索欄の文字を保持'; input.focus();
  })()`);
  await waitFor(window, "document.activeElement?.id === 'library-query'", "normal search input focus");
}

async function assertInputChordCancelled(window: BrowserWindow, keyName: string, shift = false): Promise<void> {
  const cancelled = await evaluate<boolean>(window, `(() => {
    const input = document.querySelector('#library-query');
    input.focus();
    const event = new KeyboardEvent('keydown', {key:${JSON.stringify(keyName)}, ctrlKey:true, shiftKey:${shift}, bubbles:true, cancelable:true});
    input.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  if (!cancelled) throw new Error(`Managed ${keyName} fell through to native input/browser behavior`);
}

async function assignShortcut(window: BrowserWindow, id: string, keyCode: string): Promise<void> {
  await nativeClick(window, "maginalia.settings.shortcuts");
  await search(window, id);
  await click(window, action(id, "record-binding"));
  await waitFor(window, "document.activeElement?.id === 'shortcut-recorder'", "focused regression key recorder");
  await key(window, keyCode, ["control", "shift"]);
  await click(window, "#settings-center [data-action='save-binding']");
  await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(id))})?.textContent.includes('Ctrl+Shift+${keyCode}')`, "effective regression assignment");
  await closeSettings(window);
}

async function exerciseNormalInputShortcuts(window: BrowserWindow): Promise<void> {
  console.log("MAGINALIA_SETTINGS_STAGE normal-input-shortcuts");
  await focusNormalSearch(window);
  await key(window, "P", ["control", "shift"]);
  await waitFor(window, "!document.querySelector('.command-palette')?.hidden", "default Palette shortcut from a normal search field");
  await key(window, "ESCAPE");
  await waitFor(window, "document.querySelector('.command-palette')?.hidden && document.activeElement?.id === 'library-query'", "Palette restored search focus");

  await assignShortcut(window, "maginalia.workbench.showCommandPalette", "F8");
  await focusNormalSearch(window);
  await key(window, "P", ["control", "shift"]);
  if (!await evaluate<boolean>(window, "document.querySelector('.command-palette').hidden")) throw new Error("Old Palette shortcut bypassed its override");
  await key(window, "F8", ["control", "shift"]);
  await waitFor(window, "!document.querySelector('.command-palette')?.hidden", "effective overridden Palette shortcut from a search field");
  await key(window, "ESCAPE");
  await assignShortcut(window, "maginalia.workbench.showCommandPalette", "Z");
  await focusNormalSearch(window);
  await key(window, "Z", ["control", "shift"]);
  if (!await evaluate<boolean>(window, "document.querySelector('.command-palette').hidden")) throw new Error("Global override intercepted native alternate redo");
  await nativeClick(window, "maginalia.settings.shortcuts");
  await search(window, "maginalia.workbench.showCommandPalette");
  await click(window, action("maginalia.workbench.showCommandPalette", "reset-binding"));
  await closeSettings(window);

  await focusNormalSearch(window);
  await assertInputChordCancelled(window, "s");
  await key(window, "S", ["control"]);
  await assignShortcut(window, "maginalia.document.save", "F7");
  await focusNormalSearch(window);
  await assertInputChordCancelled(window, "s");
  await assertInputChordCancelled(window, "F7", true);
  await key(window, "F7", ["control", "shift"]);
  await nativeClick(window, "maginalia.settings.shortcuts");
  await search(window, "maginalia.document.save");
  await click(window, action("maginalia.document.save", "unbind"));
  await closeSettings(window);
  await focusNormalSearch(window);
  await assertInputChordCancelled(window, "s");
  await nativeClick(window, "maginalia.settings.shortcuts");
  await search(window, "maginalia.document.save");
  await click(window, action("maginalia.document.save", "reset-binding"));
  await closeSettings(window);
  await focusNormalSearch(window);
  const editsRemainNative = await evaluate<boolean>(window, `(() => {
    const input = document.querySelector('#library-query');
    return ['z','y'].every(key => {
      const event = new KeyboardEvent('keydown', {key,ctrlKey:true,bubbles:true,cancelable:true});
      input.dispatchEvent(event); return !event.defaultPrevented;
    }) && input.value === '検索欄の文字を保持';
  })()`);
  if (!editsRemainNative) throw new Error("Normal input editing was intercepted");
}

async function exerciseStorageFailures(window: BrowserWindow): Promise<void> {
  console.log("MAGINALIA_SETTINGS_STAGE throwing-storage-ui");
  await nativeClick(window, "maginalia.settings.open");
  await search(window, "maginalia.export.paper-size");
  await evaluate(window, `(() => {
    globalThis.__settingsSmokeOriginalSetItem = Storage.prototype.setItem;
    globalThis.__settingsSmokePreferences = localStorage.getItem('maginalia.renderer.preferences.v1');
    globalThis.__settingsSmokeBindings = localStorage.getItem('maginalia.keybindings.v1');
    Storage.prototype.setItem = function() { throw new DOMException('Smoke write failure', 'QuotaExceededError'); };
    const control = document.querySelector('[data-setting-control][data-setting-id="maginalia.export.paper-size"]');
    globalThis.__settingsSmokePaper = control.value;
    control.value = control.value === 'A5' ? 'A4' : 'A5';
    control.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  try {
    await waitFor(window, "document.querySelector('.settings-center-status')?.textContent.includes('設定を保存できませんでした')", "visible preference persistence failure");
    if (!await evaluate<boolean>(window, `localStorage.getItem('maginalia.renderer.preferences.v1') === globalThis.__settingsSmokePreferences
      && document.querySelector('[data-setting-control][data-setting-id="maginalia.export.paper-size"]').value === globalThis.__settingsSmokePaper
      && document.querySelector('#export-paper-size').value === globalThis.__settingsSmokePaper`)) throw new Error("Failed preference write changed persisted or active export settings");

    await search(window, "maginalia.renderer.default-writing-direction");
    await evaluate(window, `(() => {
      globalThis.__settingsSmokeVertical = document.querySelector('#document-vertical').getAttribute('aria-pressed');
      const control = document.querySelector('[data-setting-control][data-setting-id="maginalia.renderer.default-writing-direction"]');
      control.value = control.value === 'vertical' ? 'horizontal' : 'vertical';
      control.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await waitFor(window, "!!document.querySelector('#settings-center .settings-inline-error')", "visible direction persistence failure");
    if (!await evaluate<boolean>(window, "document.querySelector('#document-vertical').getAttribute('aria-pressed') === globalThis.__settingsSmokeVertical && localStorage.getItem('maginalia.renderer.preferences.v1') === globalThis.__settingsSmokePreferences")) throw new Error("Failed strict direction write changed presentation");

    await click(window, "#settings-center [data-settings-tab='shortcuts']");
    await search(window, "maginalia.renderer.setHorizontal");
    await click(window, action("maginalia.renderer.setHorizontal", "record-binding"));
    await key(window, "F6", ["control", "shift"]);
    await click(window, "#settings-center [data-action='save-binding']");
    await waitFor(window, "document.querySelector('.settings-center-status')?.textContent.includes('保存できませんでした')", "visible shortcut persistence failure");
    if (!await evaluate<boolean>(window, "localStorage.getItem('maginalia.keybindings.v1') === globalThis.__settingsSmokeBindings && !document.querySelector('[data-command-id=\"maginalia.renderer.setHorizontal\"]').textContent.includes('Ctrl+Shift+F6')")) throw new Error("Failed shortcut write changed active or persisted overrides");
  } finally {
    await evaluate(window, "Storage.prototype.setItem = globalThis.__settingsSmokeOriginalSetItem; delete globalThis.__settingsSmokeOriginalSetItem");
    await closeSettings(window);
  }
}

/** Real Electron acceptance: native Menu callbacks, renderer IPC, OS key events and a second process profile restore. */
export async function runSettingsSmoke(window: BrowserWindow, restore: boolean): Promise<void> {
  window.show(); window.focus(); window.webContents.focus();
  await waitFor(window, "document.querySelector('#editor')?.dataset.smokeReady === 'true' && !!document.querySelector('#settings-center')", "Workbench and Settings ready");
  const groups = Menu.getApplicationMenu()?.items ?? [];
  if (groups.length < 7) throw new Error("Settings smoke requires all seven application menu groups");
  if (menuItem("maginalia.document.save").enabled) throw new Error("Save was enabled without a document");
  await focusNormalSearch(window);
  await assertInputChordCancelled(window, "s");
  await nativeClick(window, "maginalia.document.open");
  await waitFor(window, "document.querySelector('#document-status')?.dataset.state === 'saved'", "native Open Document handler");
  const originalText = await evaluate<string>(window, "document.querySelector('#editor').dataset.smokeText");
  await nativeClick(window, "maginalia.settings.shortcuts");
  await waitFor(window, "document.querySelector('#settings-center')?.open", "native Shortcut Editor");
  const boundCommand = "maginalia.renderer.setVertical";
  await search(window, boundCommand);
  await waitFor(window, `!!document.querySelector(${JSON.stringify(commandRow(boundCommand))})`, "bindable command without a default");

  if (!restore) {
    console.log("MAGINALIA_SETTINGS_STAGE assign");
    await click(window, action(boundCommand, "record-binding"));
    await waitFor(window, "document.activeElement?.id === 'shortcut-recorder'", "focused key recorder");
    await key(window, "F9", ["control", "shift"]);
    await click(window, "#settings-center [data-action='save-binding']");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "saved no-default assignment");
    await closeSettings(window);
    console.log("MAGINALIA_SETTINGS_STAGE shared-commands");
    await evaluate(window, "document.querySelector('#editor').dispatchEvent(new Event('maginalia-smoke-focus'))");
    await key(window, "F9", ["control", "shift"]);
    await waitFor(window, direction("vertical"), "effective binding in Monaco context");
    if (!/^(?:Ctrl|Control)\+Shift\+F9$/u.test(String(menuItem(boundCommand).accelerator))) throw new Error("Native menu did not display the effective shortcut");
    if (menuItem(boundCommand).registerAccelerator) throw new Error("Native accelerator would duplicate renderer key dispatch");

    await nativeClick(window, "maginalia.renderer.setHorizontal");
    await waitFor(window, direction("horizontal"), "native orientation command");
    await key(window, "P", ["control", "shift"]);
    await waitFor(window, "!document.querySelector('.command-palette')?.hidden", "effective palette shortcut");
    await evaluate(window, `(() => { const input = document.querySelector('.command-palette input'); input.value = 'Set Vertical Writing'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await key(window, "ENTER");
    await waitFor(window, direction("vertical"), "palette shares orientation handler");
    await nativeClick(window, "maginalia.help.cheatSheet");
    await search(window, "Ctrl+Shift+F9");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "Cheat Sheet effective assignment search");
    await closeSettings(window);

    console.log("MAGINALIA_SETTINGS_STAGE conflict-cancel");
    await nativeClick(window, "maginalia.settings.shortcuts");
    await search(window, boundCommand);
    await click(window, action(boundCommand, "record-binding"));
    await key(window, "S", ["control"]);
    await click(window, "#settings-center [data-action='save-binding']");
    await waitFor(window, "!!document.querySelector('#settings-center [data-action=replace-binding]')", "explicit shortcut conflict");
    await click(window, "#settings-center [data-action='cancel-binding']");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "cancel preserves previous assignment");
    await closeSettings(window);
  } else {
    console.log("MAGINALIA_SETTINGS_STAGE restart-unbind-reset");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "override survived process restart");
    await click(window, action(boundCommand, "unbind"));
    await closeSettings(window);
    await nativeClick(window, "maginalia.renderer.setHorizontal");
    await key(window, "F9", ["control", "shift"]);
    if (!await evaluate<boolean>(window, direction("horizontal"))) throw new Error("Unbound shortcut still executed");
    await nativeClick(window, "maginalia.settings.shortcuts");
    await search(window, boundCommand);
    await click(window, action(boundCommand, "reset-binding"));
    await closeSettings(window);
  }

  await exerciseNormalInputShortcuts(window);
  await exerciseStorageFailures(window);

  await nativeClick(window, "maginalia.settings.open");
  await search(window, "用紙");
  await waitFor(window, "!!document.querySelector('#settings-center [data-setting-id]')", "Japanese Settings metadata search");
  const dialogContainsFocus = await evaluate<boolean>(window, "document.querySelector('#settings-center').contains(document.activeElement)");
  if (!dialogContainsFocus) throw new Error("Settings dialog did not receive focus");
  await key(window, "TAB", ["shift"]);
  if (!await evaluate<boolean>(window, "document.querySelector('#settings-center').contains(document.activeElement)")) throw new Error("Keyboard focus escaped the modal");
  await closeSettings(window);
  const finalText = await evaluate<string>(window, "document.querySelector('#editor').dataset.smokeText");
  if (finalText !== originalText) throw new Error("Settings or command discovery modified the manuscript");
  console.log(`MAGINALIA_SETTINGS_EVIDENCE ${JSON.stringify({ restore, nativeMenu: true, keyboard: true, focus: true, unchangedManuscript: true, normalInputShortcuts: true, storageFailuresVisible: true })}`);
}
