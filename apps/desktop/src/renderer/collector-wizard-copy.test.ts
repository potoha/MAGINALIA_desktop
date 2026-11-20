import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_BROWSERS,
  COLLECTOR_BROWSER_IDS,
  type CollectorBrowserId,
  type CollectorBrowserSpec,
  type CollectorDefaultBrowserKind,
} from "../collector-browser-table";
import { COLLECTOR_EXTENSION_ID } from "../collector-payload";
import {
  buildWizardCopy,
  wizardProgressLabel,
  wizardSupportedBrowserList,
  WIZARD_EXTENSION_ID,
  WIZARD_MESSAGE_IDS,
  WIZARD_MESSAGE_ROLE,
  type WizardCopyContext,
} from "./collector-wizard-copy";

/** Every string (and where it is) in a copy object. */
function collectStrings(value: unknown, path = "copy"): ReadonlyArray<readonly [string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectStrings(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => collectStrings(child, `${path}.${key}`));
  }
  return value === null ? [] : [[`${path}<${typeof value}>`, String(value)]];
}

const DEFAULT_KINDS: readonly CollectorDefaultBrowserKind[] = ["edge", "chrome", "vivaldi", "other-chromium", "other", "unknown"];
const VERSIONS: ReadonlyArray<readonly [string | null, string | null]> = [[null, null], ["0.3.0", "0.4.0"], ["0.3.0", null]];

function contexts(): WizardCopyContext[] {
  const browsers: Array<CollectorBrowserId | null> = [null, ...COLLECTOR_BROWSER_IDS];
  const list: WizardCopyContext[] = [];
  for (const browser of browsers) {
    for (const recommended of browsers) {
      for (const defaultBrowser of DEFAULT_KINDS) {
        for (const [loadedVersion, placedVersion] of VERSIONS) {
          list.push({ browser, recommended, preferred: browser, defaultBrowser, loadedVersion, placedVersion });
          list.push({ browser, recommended, preferred: null, blocked: [...COLLECTOR_BROWSER_IDS], defaultBrowser, loadedVersion, placedVersion });
        }
      }
    }
  }
  return list;
}

function withVerified(ids: readonly CollectorBrowserId[]): readonly CollectorBrowserSpec[] {
  return COLLECTOR_BROWSERS.map((row) => (ids.includes(row.id) ? ({ ...row, verification: "verified" } as CollectorBrowserSpec) : row));
}

const BASE: WizardCopyContext = { browser: "chrome", recommended: "chrome", preferred: null, defaultBrowser: "chrome", loadedVersion: null, placedVersion: null };

describe("wizard copy: no unresolved placeholder", () => {
  it("leaves no {placeholder}, undefined or empty string for any key x browser x context (current table)", () => {
    for (const context of contexts()) {
      for (const [path, text] of collectStrings(buildWizardCopy(context))) {
        expect(text, `${path} ${JSON.stringify(context)}`).not.toMatch(/\{[^}]*\}/u);
        expect(text, path).not.toMatch(/undefined|\[object/u);
        expect(text.trim(), path).not.toBe("");
      }
    }
  });

  it("holds as well when every row is verified (the table after Edge and Vivaldi are enabled)", () => {
    const table = withVerified(["edge", "chrome", "vivaldi"]);
    for (const context of contexts()) {
      for (const [path, text] of collectStrings(buildWizardCopy(context, table))) {
        expect(text, path).not.toMatch(/\{[^}]*\}/u);
        expect(text.trim(), path).not.toBe("");
      }
    }
  });

  it("covers every message id exactly once, each with a role", () => {
    const copy = buildWizardCopy(BASE);
    expect(Object.keys(copy.messages).sort()).toEqual([...WIZARD_MESSAGE_IDS].sort());
    expect(Object.keys(WIZARD_MESSAGE_ROLE).sort()).toEqual([...WIZARD_MESSAGE_IDS].sort());
    for (const id of WIZARD_MESSAGE_IDS) {
      expect(copy.messages[id].headline.length).toBeGreaterThan(0);
      expect(["status", "alert"]).toContain(WIZARD_MESSAGE_ROLE[id]);
    }
  });

  it("has a reason entry for every recommendation reason", () => {
    expect(Object.keys(buildWizardCopy(BASE).stepA.reasons).sort()).toEqual(
      ["default-not-installed", "default-supported", "default-unknown", "default-unsupported", "default-unverified", "detection-failed", "none-installed"],
    );
  });
});

describe("wizard copy: Japanese text is intact (UTF-8)", () => {
  it("has no replacement character or mojibake, and the source files decode cleanly", () => {
    for (const path of ["collector-wizard-copy.ts", "collector-wizard-model.ts"]) {
      const bytes = readFileSync(new URL(`./${path}`, import.meta.url));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      expect(text).not.toContain("�");
      expect(text).not.toMatch(/縺|繧|郢/u);
    }
    for (const [path, text] of collectStrings(buildWizardCopy(BASE))) expect(text, path).not.toContain("�");
  });

  it("keeps the product wording of the design (spot checks)", () => {
    const copy = buildWizardCopy(BASE);
    expect(copy.dialogLabel).toBe("Collector 連携の設定");
    expect(copy.common.later).toBe("あとで設定");
    expect(copy.stepA.title).toBe("ブラウザーで集めた引用を本棚へ（MAGINALIA Collector）");
    expect(copy.messages["registered"].headline).toBe("MAGINALIA 連携プログラムを登録しました。");
    expect(copy.messages["foreign-confirmation"].detail).toContain("MAGINALIA に付属する連携プログラムに切り替えますか？");
    expect(copy.messages["destination-writes-disabled"].headline).toContain("Collector からの保存は無効のまま");
    expect(copy.stepE.timedOut.headline).toBe("まだ接続を確認できません。");
    expect(copy.done.title).toBe("MAGINALIA Collector の準備ができました。");
    expect(wizardProgressLabel(3)).toBe("手順 3 / 5");
  });

  it("never mentions or interpolates a machine path", () => {
    for (const context of contexts()) {
      for (const [path, text] of collectStrings(buildWizardCopy(context))) {
        expect(text, path).not.toMatch(/[A-Za-z]:\\|\\\\|\/Users\/|%[A-Za-z]+%/u);
      }
    }
  });

  it("pins the extension id to the product constant", () => {
    expect(WIZARD_EXTENSION_ID).toBe(COLLECTOR_EXTENSION_ID);
    expect(buildWizardCopy(BASE).stepE.timedOut.checklist.join("\n")).toContain(COLLECTOR_EXTENSION_ID);
  });
});

describe("wizard copy: step A (multi-browser design 2.3)", () => {
  it("lists only verified browsers", () => {
    expect(wizardSupportedBrowserList()).toBe("Google Chrome");
    expect(wizardSupportedBrowserList(withVerified(["edge", "chrome"]))).toBe("Microsoft Edge、Google Chrome");
    expect(buildWizardCopy(BASE).stepA.body).toContain("Google Chrome で使えます");
    const both = buildWizardCopy(BASE, withVerified(["edge", "chrome"]));
    expect(both.stepA.body).toContain("Microsoft Edge、Google Chrome で使えます");
    expect(both.stepA.bullets[0]).toContain("Microsoft Edge と Google Chrome のどちらでも使えるように登録します。");
    expect(buildWizardCopy(BASE).stepA.bullets[0]).not.toContain("のどちらでも");
  });

  it("fills the recommended and default browser names", () => {
    const copy = buildWizardCopy({ ...BASE, browser: "edge", recommended: "edge", preferred: "edge", defaultBrowser: "edge" }, withVerified(["edge", "chrome"]));
    expect(copy.stepA.reasons["default-supported"].lead).toBe("ふだんお使いのブラウザー（Microsoft Edge）で使えます。");
    expect(copy.stepA.reasons["default-supported"].detail).toBe("Microsoft Edge に Collector を入れることをおすすめします。");
    expect(copy.stepA.reasons["default-unsupported"].detail).toContain("Microsoft Edge をおすすめします。引用を集めるときは、Microsoft Edge で Web ページを開いてください。");
    expect(copy.stepA.reasons["default-unverified"].detail).toContain("確認済みの Microsoft Edge をおすすめします。");
    expect(copy.stepA.reasons["default-not-installed"].lead).toContain("既定のブラウザーとして Microsoft Edge が設定されています");
    expect(copy.stepA.reasons["none-installed"].lead).toBe("対応しているブラウザー（Microsoft Edge、Google Chrome）が見つかりませんでした。");
    expect(copy.stepA.downloadButtons.chrome).toBe("Google Chrome のダウンロードページを開く");
    expect(copy.stepA.previouslyChosen).toBe("前回は Microsoft Edge を選びました。");
  });

  it("falls back to neutral names when no browser is known", () => {
    const copy = buildWizardCopy({ ...BASE, browser: null, recommended: null, defaultBrowser: "other" });
    expect(copy.stepA.reasons["default-unsupported"].detail).toContain("対応しているブラウザー をおすすめします");
    expect(copy.stepA.reasons["default-not-installed"].lead).toContain("別のブラウザー が設定");
  });
});

describe("wizard copy: step D per browser (multi-browser design 2.4, spike results 4 and 5)", () => {
  const table = withVerified(["edge", "chrome", "vivaldi"]);

  it("Chrome: right-top developer mode, the load-unpacked button, address typed because the button may not open the page", () => {
    const d = buildWizardCopy({ ...BASE, browser: "chrome" }, table).stepD;
    expect(d.title).toBe("Google Chrome に Collector を読み込む");
    expect(d.openExtensions).toBe("Google Chrome で拡張機能の画面を開く");
    expect(d.steps).toHaveLength(5);
    expect(d.steps[0]).toContain("［Google Chrome で拡張機能の画面を開く］を押します。");
    expect(d.steps[1]).toBe("画面の右上にある「デベロッパー モード」をオンにします。");
    expect(d.steps[2]).toBe("「パッケージ化されていない拡張機能を読み込む」を押します。");
    expect(d.addressNote).toContain("chrome://extensions");
    expect(d.addressNote).toContain("開かないことがあります");
    expect(d.alternative).toContain("（「デベロッパー モード」がオンのとき）");
    expect(d.cautions.join("\n")).toContain("「デベロッパー モード」はオンのままにしてください。");
    expect(d.cautions.join("\n")).not.toContain("今は実行しない");
  });

  it("Edge: bottom-left developer mode, icon under the developer options, and the startup question", () => {
    const d = buildWizardCopy({ ...BASE, browser: "edge", recommended: "edge" }, table).stepD;
    expect(d.title).toBe("Microsoft Edge に Collector を読み込む");
    expect(d.steps[1]).toBe("画面左のメニューの下部にある「開発者モード」をオンにします。");
    expect(d.steps[2]).toBe("「開発者向けオプション」の下にある、一番左のアイコンを押します（ポインターを合わせると「展開して読み込み」と表示されます）。");
    expect(d.addressNote).toContain("edge://extensions");
    expect(d.cautions.join("\n")).toContain("「開発者モードをオフにしますか？」");
    expect(d.cautions.join("\n")).toContain("「今は実行しない」");
    // Edge drag-and-drop was not measured (spike results 7): no claim there. Chrome and Vivaldi keep it.
    expect(d.alternative).toBeNull();
    expect(buildWizardCopy({ ...BASE, browser: "chrome" }, table).stepD.alternative).toContain("ドラッグ");
    expect(buildWizardCopy({ ...BASE, browser: "vivaldi" }, table).stepD.alternative).toContain("ドラッグ");
    expect(buildWizardCopy({ ...BASE, browser: null }, table).stepD.alternative).toBeNull();
  });

  it("Vivaldi: the same wording as Chrome, and the page opens by itself", () => {
    const chrome = buildWizardCopy({ ...BASE, browser: "chrome" }, table).stepD;
    const vivaldi = buildWizardCopy({ ...BASE, browser: "vivaldi" }, table).stepD;
    expect(vivaldi.steps[1]).toBe(chrome.steps[1]);
    expect(vivaldi.steps[2]).toBe(chrome.steps[2]);
    expect(vivaldi.addressNote).toBe("開かない場合は、Vivaldi のアドレスバーに vivaldi://extensions と入力して Enter キーを押してください。");
    expect(vivaldi.steps[0]).toContain("Vivaldi に「拡張機能」の画面が開きます。");
  });

  it("with no browser selected, the steps name every supported address and label instead of one browser", () => {
    const d = buildWizardCopy({ ...BASE, browser: null }, table).stepD;
    expect(d.title).toBe("ブラウザー に Collector を読み込む");
    expect(d.steps[0]).toContain("chrome://extensions（Google Chrome）");
    expect(d.steps[0]).toContain("edge://extensions（Microsoft Edge）");
    expect(d.steps[1]).toContain("「開発者モード」");
    expect(d.steps[1]).toContain("「デベロッパー モード」");
    expect(d.steps[0]).not.toContain("で拡張機能の画面を開く］");
    expect(d.addressNote).toContain("次のいずれか");
  });

  it("takes names, labels and addresses from the table, not from the copy", () => {
    const edited = table.map((row) => (row.id === "chrome"
      ? ({ ...row, displayName: "Chrome X", extensionsPage: { ...row.extensionsPage, displayUrl: "chrome://x" }, ui: { ...row.ui, developerModeLabel: "ラベルX" } } as CollectorBrowserSpec)
      : row));
    const d = buildWizardCopy({ ...BASE, browser: "chrome" }, edited).stepD;
    expect(d.title).toBe("Chrome X に Collector を読み込む");
    expect(d.addressNote).toContain("chrome://x");
    expect(d.steps[1]).toContain("「ラベルX」");
  });

  it("explains the folder without showing a path", () => {
    const d = buildWizardCopy(BASE).stepD;
    expect(d.pathNote).toContain("画面には表示しません");
    expect(d.steps[3]).toContain("パスをコピー");
  });

  it("the table carries the spike's Edge and Chrome facts", () => {
    const edge = COLLECTOR_BROWSERS.find((row) => row.id === "edge")!;
    expect(edge.ui).toEqual({
      developerModeLabel: "開発者モード",
      developerModeLocation: "画面左のメニューの下部",
      loadUnpackedLabel: "展開して読み込み",
      reloadLabel: "再読み込み",
    });
    const chrome = COLLECTOR_BROWSERS.find((row) => row.id === "chrome")!;
    expect(chrome.ui.developerModeLabel).toBe("デベロッパー モード");
    expect(chrome.ui.developerModeLocation).toBe("画面の右上");
    expect(chrome.ui.loadUnpackedLabel).toBe("パッケージ化されていない拡張機能を読み込む");
  });
});

describe("wizard copy: step B, E and messages", () => {
  it("names the browser in the policy message and keeps a generic one", () => {
    const copy = buildWizardCopy({ ...BASE, browser: "chrome" });
    expect(copy.messages["policy-blocked-browser"].headline).toBe("組織の管理設定により、Google Chrome はこの種類の連携プログラムを使えないようになっています。");
    expect(copy.messages["policy-blocked"].headline).toContain("ブラウザーがこの種類の連携プログラムを使えない");
    expect(copy.stepD.policyWarning).toBe("組織の管理設定により、Google Chrome で拡張機能を読み込めない可能性があります。");
  });

  it("fills the versions and the reload label of the selected browser", () => {
    const copy = buildWizardCopy({ ...BASE, browser: "chrome", loadedVersion: "0.3.0", placedVersion: "0.4.0" });
    expect(copy.stepE.versionDiffers.headline).toBe("ブラウザーに読み込まれている Collector（0.3.0）が、MAGINALIA に付属する版（0.4.0）と異なります。");
    expect(copy.stepE.versionDiffers.detail).toContain("［更新］を押してから");
    expect(buildWizardCopy({ ...BASE, loadedVersion: null, placedVersion: null }).stepE.versionDiffers.headline).toContain("（不明）");
  });

  it("does not name a browser on step E (the contact record does not say which one)", () => {
    const e = buildWizardCopy({ ...BASE, browser: "chrome" }).stepE;
    expect(e.waiting.headline).toBe("ブラウザーの Collector からの接続を待っています…");
    expect(e.connected.headline).toBe("MAGINALIA Collector から接続を確認しました。");
  });
});
