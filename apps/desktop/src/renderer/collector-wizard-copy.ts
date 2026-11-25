/**
 * Japanese copy of the Collector integration wizard (S8 / WP-7 slice B, step B2).
 *
 * Sources: docs/collector-wizard-integration-design.md 4.2-4.6 (parent design) as amended by
 * docs/collector-multi-browser-design.md 2.3 / 2.4 / 7.6 (the amendment wins where they differ), and
 * the spike facts in docs/collector-multi-browser-spike-results.md 4 and 5.
 *
 * Pure data and pure functions: no DOM, no Electron, no IPC. Browser names, UI labels and extension
 * page addresses come from the browser table (the single source of browser facts). The renderer
 * never receives a path: this copy never mentions or interpolates one.
 *
 * `buildWizardCopy(context)` resolves every string for one situation. It contains only strings,
 * arrays of strings and records of them, so a test can walk the whole result and prove that no
 * `{placeholder}` is left (see collector-wizard-copy.test.ts).
 */
import {
  COLLECTOR_BROWSERS,
  type CollectorBrowserId,
  type CollectorBrowserSpec,
  type CollectorDefaultBrowserKind,
  type CollectorRecommendationReason,
} from "../collector-browser-table";

/** The extension identity shown in the timeout checklist (a test pins it to the product constant). */
export const WIZARD_EXTENSION_ID = "blgmoddncpknfnikdfnjelmdmphfgknf";

export const WIZARD_STEP_COUNT = 5;

/**
 * The browsers the step A radiogroup always offers by name, in display order (owner decision
 * 2026-11-23: 「Chrome で登録」 then 「Edge で登録」). Any other verified browser appears only as
 * the single 「通常のブラウザーで登録」 choice, and only when it is the OS default browser.
 */
export const WIZARD_NAMED_BROWSER_IDS = ["chrome", "edge"] as const;
export type WizardNamedBrowserId = (typeof WIZARD_NAMED_BROWSER_IDS)[number];

/** 「手順 n / 5」 as text (not colour only). */
export function wizardProgressLabel(stepNumber: number): string {
  return `手順 ${stepNumber} / ${WIZARD_STEP_COUNT}`;
}

// ----- Message ids (shared with the model) ------------------------------------------------------

/**
 * One id per result or notice the wizard can show. The model decides WHICH id applies; this module
 * owns the words and the live-region role (`status` = polite, `alert` = failure that needs action).
 */
export const WIZARD_MESSAGE_IDS = [
  // any step
  "busy",
  "request-failed",
  "unavailable-e2e-isolation",
  "unavailable-payload-unavailable",
  "unavailable-startup-failed",
  // step A
  "inspect-failed",
  "download-opened",
  "download-failed",
  "download-not-offered",
  "all-browsers-policy-blocked",
  // step B
  "registered-not-effective",
  "registered",
  "registered-verified",
  "already-ready",
  "refreshed",
  "foreign-confirmation",
  "foreign-declined",
  "policy-blocked",
  "policy-blocked-browser",
  "registry-denied",
  "folder-unsafe",
  "file-locked",
  "self-check-failed",
  "register-failed",
  "outdated-pending",
  "outdated-remove-paused",
  "remove-cancelled",
  "remove-not-requested",
  "remove-already-done",
  "remove-cancel-failed",
  // blocking request without an answer for a long time (watchdog)
  "inflight-slow",
  // step C
  "destination-configured",
  "destination-writes-disabled",
  "destination-cancelled",
  "destination-error",
  "destination-busy",
  // step D
  "extension-not-placed",
  "check-incomplete",
  "browser-opened",
  "browser-not-opened",
  "address-copied",
  "address-copy-failed",
  "path-copied",
  "path-copy-failed",
  "folder-open-failed",
] as const;
export type WizardMessageId = (typeof WIZARD_MESSAGE_IDS)[number];

export type WizardMessageRole = "status" | "alert";

export const WIZARD_MESSAGE_ROLE: Readonly<Record<WizardMessageId, WizardMessageRole>> = Object.freeze({
  "busy": "alert",
  "request-failed": "alert",
  "unavailable-e2e-isolation": "alert",
  "unavailable-payload-unavailable": "alert",
  "unavailable-startup-failed": "alert",
  "inspect-failed": "alert",
  "download-opened": "status",
  "download-failed": "alert",
  "download-not-offered": "alert",
  "all-browsers-policy-blocked": "alert",
  "registered-not-effective": "alert",
  "registered": "status",
  "registered-verified": "status",
  "already-ready": "status",
  "refreshed": "status",
  "foreign-confirmation": "alert",
  "foreign-declined": "status",
  "policy-blocked": "alert",
  "policy-blocked-browser": "alert",
  "registry-denied": "alert",
  "folder-unsafe": "alert",
  "file-locked": "alert",
  "self-check-failed": "alert",
  "register-failed": "alert",
  "outdated-pending": "status",
  "outdated-remove-paused": "status",
  "remove-cancelled": "status",
  "remove-not-requested": "status",
  "remove-already-done": "status",
  "remove-cancel-failed": "alert",
  "inflight-slow": "alert",
  "destination-configured": "status",
  "destination-writes-disabled": "alert",
  "destination-cancelled": "status",
  "destination-error": "alert",
  "destination-busy": "alert",
  "extension-not-placed": "alert",
  "check-incomplete": "alert",
  "browser-opened": "status",
  "browser-not-opened": "alert",
  "address-copied": "status",
  "address-copy-failed": "alert",
  "path-copied": "status",
  "path-copy-failed": "alert",
  "folder-open-failed": "alert",
});

// ----- Context ----------------------------------------------------------------------------------

export interface WizardCopyContext {
  /** The browser the user selected, or `null` (continuing without a detected browser: generic wording). */
  readonly browser: CollectorBrowserId | null;
  /** Verified browsers an organization policy blocks (names for the all-blocked message). Default: none. */
  readonly blocked?: readonly CollectorBrowserId[];
  /** The browser the user chose last time (remembered by the main process), or `null`. */
  readonly preferred: CollectorBrowserId | null;
  /** A classification only (never a ProgId). */
  readonly defaultBrowser: CollectorDefaultBrowserKind;
  /** Step E, `extension-version-differs`: the version Chrome loaded (`null`: not known). */
  readonly loadedVersion: string | null;
  /** Step E: the version MAGINALIA placed (`null`: not known). */
  readonly placedVersion: string | null;
}

export interface WizardMessageCopy {
  readonly headline: string;
  readonly detail: string | null;
}

export interface WizardReasonCopy {
  readonly lead: string;
  readonly detail: string | null;
}

// ----- Table-derived phrases --------------------------------------------------------------------

const GENERIC_BROWSER = "ブラウザー";
const UNKNOWN_VERSION = "不明";

type Table = readonly CollectorBrowserSpec[];

function rowOf(table: Table, id: CollectorBrowserId | null | undefined): CollectorBrowserSpec | undefined {
  return id === null || id === undefined ? undefined : table.find((row) => row.id === id);
}

/** Display order of browsers in lists and buttons (owner decision 2026-11-24): Chrome, Edge, then the rest. */
const DISPLAY_ORDER: readonly string[] = ["chrome", "edge", "vivaldi"];

function displayRank(id: string): number {
  const index = DISPLAY_ORDER.indexOf(id);
  return index < 0 ? DISPLAY_ORDER.length : index;
}

/** Rows in display order (stable: rows outside the list keep their table order, after the listed ones). */
export function wizardDisplayOrder<T extends { readonly id: string }>(rows: readonly T[]): readonly T[] {
  return [...rows].sort((a, b) => displayRank(a.id) - displayRank(b.id));
}

function verifiedRows(table: Table): Table {
  return wizardDisplayOrder(table.filter((row) => row.verification === "verified"));
}

/** 「Google Chrome、Microsoft Edge、Vivaldi」: verified rows in display order. */
export function wizardSupportedBrowserList(table: Table = COLLECTOR_BROWSERS): string {
  const names = verifiedRows(table).map((row) => row.displayName);
  return names.length === 0 ? "対応しているブラウザー" : names.join("、");
}

function unique(values: readonly string[]): readonly string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function browserName(table: Table, id: CollectorBrowserId | null): string {
  return rowOf(table, id)?.displayName ?? GENERIC_BROWSER;
}

/** The address to type, or (no selection) every verified browser's address with its name. */
function addressPhrase(table: Table, id: CollectorBrowserId | null): string {
  const row = rowOf(table, id);
  if (row !== undefined) return row.extensionsPage.displayUrl;
  return verifiedRows(table).map((entry) => `${entry.extensionsPage.displayUrl}（${entry.displayName}）`).join("、");
}

function defaultBrowserName(table: Table, kind: CollectorDefaultBrowserKind): string {
  return rowOf(table, kind as CollectorBrowserId)?.displayName ?? "別のブラウザー";
}

/** `{name}` style templates. Unknown keys are left in place so the placeholder test can see them. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z]+)\}/gu, (whole, key: string) => values[key] ?? whole);
}

// ----- Step D: browser-dependent instructions (spike results 4 and 5) ---------------------------

/**
 * How step 3 reads. Chrome and Vivaldi have a text button; Edge has a row of icons under
 * 「開発者向けオプション」 and the label is only the tooltip (spike results 4). `Record` over the
 * browser ids: a new table row does not compile until its wording is chosen here.
 */
const LOAD_UNPACKED_INSTRUCTION: Readonly<Record<CollectorBrowserId, (row: CollectorBrowserSpec) => string>> = {
  chrome: (row) => `「${row.ui.loadUnpackedLabel}」を押します。`,
  vivaldi: (row) => `「${row.ui.loadUnpackedLabel}」を押します。`,
  edge: (row) => `「開発者向けオプション」の下にある、一番左のアイコンを押します（ポインターを合わせると「${row.ui.loadUnpackedLabel}」と表示されます）。`,
};

/**
 * Whether the button is expected to open the extensions page itself. In the user's normal profile
 * Chrome and Edge only bring a new window forward (spike results 5), so the typed address is part of
 * the instructions rather than a fallback. Vivaldi opens the page.
 */
const OPEN_BUTTON_OPENS_PAGE: Readonly<Record<CollectorBrowserId, boolean>> = {
  chrome: false,
  edge: false,
  vivaldi: true,
};

/**
 * Whether loading by dragging the folder onto the extensions page was observed. Edge drag-and-drop
 * was not measured (spike results 7), so the alternative is not offered there.
 */
const DRAG_LOAD_MEASURED: Readonly<Record<CollectorBrowserId, boolean>> = {
  chrome: true,
  edge: false,
  vivaldi: true,
};

/** Edge asks 「開発者モードをオフにしますか？」 at every start (spike results 4). */
const STARTUP_DEVELOPER_MODE_NOTE: Readonly<Record<CollectorBrowserId, string | null>> = {
  chrome: null,
  edge: "Microsoft Edge の起動時に「開発者モードをオフにしますか？」と表示されたときは、「今は実行しない」を選んでください。オフにすると Collector が無効になります。",
  vivaldi: null,
};

function developerModeLabelPhrase(table: Table, id: CollectorBrowserId | null): string {
  const row = rowOf(table, id);
  if (row !== undefined) return `「${row.ui.developerModeLabel}」`;
  return unique(verifiedRows(table).map((entry) => entry.ui.developerModeLabel)).map((label) => `「${label}」`).join("または");
}

function developerModeInstruction(table: Table, id: CollectorBrowserId | null): string {
  const row = rowOf(table, id);
  if (row !== undefined) return `${row.ui.developerModeLocation}にある「${row.ui.developerModeLabel}」をオンにします。`;
  return `拡張機能の画面にある${developerModeLabelPhrase(table, null)}をオンにします。`;
}

function loadUnpackedInstruction(table: Table, id: CollectorBrowserId | null): string {
  const row = rowOf(table, id);
  if (row !== undefined) return LOAD_UNPACKED_INSTRUCTION[row.id](row);
  const labels = unique(verifiedRows(table).map((entry) => entry.ui.loadUnpackedLabel)).map((label) => `「${label}」`).join("または");
  return `${labels}を押します。`;
}

function reloadPhrase(table: Table, id: CollectorBrowserId | null): string {
  const row = rowOf(table, id);
  if (row !== undefined) return `［${row.ui.reloadLabel}］`;
  return unique(verifiedRows(table).map((entry) => entry.ui.reloadLabel)).map((label) => `［${label}］`).join("または");
}

// ----- The copy ---------------------------------------------------------------------------------

export interface WizardCopy {
  readonly dialogLabel: string;
  readonly common: {
    readonly loading: string;
    readonly back: string;
    readonly next: string;
    readonly later: string;
    readonly close: string;
    readonly retry: string;
    readonly recheck: string;
    readonly finish: string;
    /** The watchdog action: stop waiting for a request that has not answered (nothing is rolled back). */
    readonly cancelWait: string;
  };
  readonly stepA: {
    readonly title: string;
    readonly body: string;
    readonly bullets: readonly string[];
    readonly menuNote: string;
    readonly radiogroupLabel: string;
    /** Shown beside a disabled 「次へ」 while no browser is selected (B3 addition: the reason a button is disabled). */
    readonly selectBrowserFirst: string;
    readonly optionRecommendedSuffix: string;
    /** Appended to a browser's name for a browser offered only because nothing else can be chosen (not the default, not Chrome/Edge). */
    readonly optionRegisterOtherSuffix: string;
    /** Note under a browser that has no registration of its own and whose borrowed registration is blocked by policy. */
    readonly optionBorrowedBlocked: string;
    /** Radio labels of the two browsers that are always offered by name. */
    readonly optionRegisterNamed: Readonly<Record<WizardNamedBrowserId, string>>;
    /** Radio label of 「通常のブラウザー」: the OS default browser, named (only offered when it is neither Chrome nor Edge). */
    readonly optionRegisterDefault: string;
    readonly optionPolicyBlocked: string;
    readonly optionDetectionUnknown: string;
    readonly previouslyChosen: string;
    readonly continueWithoutBrowser: string;
    readonly continueWithSelectedBrowser: string;
    readonly downloadButtons: Readonly<Record<CollectorBrowserId, string>>;
    readonly reasons: Readonly<Record<CollectorRecommendationReason, WizardReasonCopy>>;
  };
  readonly stepB: {
    readonly title: string;
    readonly intro: string;
    readonly register: string;
    readonly switchForeign: string;
    readonly declineForeign: string;
    /** Step B, remove paused: withdraws the unfinished remove (the same `cancelRemove` intent as the menu command). */
    readonly cancelRemove: string;
  };
  readonly stepC: {
    readonly title: string;
    readonly intro: string;
    readonly detail: string;
    readonly confirm: string;
    readonly confirmAgain: string;
    readonly chooseAgain: string;
    readonly cancelSetup: string;
    readonly nextWritesDisabled: string;
  };
  readonly stepD: {
    readonly title: string;
    readonly intro: string;
    readonly pathNote: string;
    readonly openExtensions: string;
    readonly copyAddress: string;
    readonly copyPath: string;
    readonly revealFolder: string;
    readonly loaded: string;
    readonly stepsLabel: string;
    readonly steps: readonly string[];
    readonly addressNote: string;
    /** `null` when drag-and-drop loading was not observed for the selected browser (Edge) or no browser is selected. */
    readonly alternative: string | null;
    readonly cautionsLabel: string;
    readonly cautions: readonly string[];
    readonly multiBrowserSummary: string;
    readonly multiBrowserNote: string;
    readonly policyWarning: string;
    readonly checkingFolder: string;
  };
  readonly stepE: {
    readonly title: string;
    readonly waiting: WizardMessageCopy;
    readonly howToOpenSummary: string;
    readonly howToOpenDetail: string;
    readonly connected: WizardMessageCopy;
    readonly destinationConfigured: string;
    readonly destinationNotConfigured: string;
    readonly versionDiffers: WizardMessageCopy;
    readonly protocolDiffers: WizardMessageCopy;
    readonly timedOut: { readonly headline: string; readonly checklistLabel: string; readonly checklist: readonly string[] };
    readonly unavailable: WizardMessageCopy;
    readonly userConfirmed: WizardMessageCopy;
    readonly waitAgain: string;
    readonly confirmReady: string;
    readonly recheck: string;
  };
  readonly done: {
    readonly title: string;
    readonly body: string;
    readonly unverifiedTitle: string;
    readonly unverifiedBody: string;
  };
  readonly messages: Readonly<Record<WizardMessageId, WizardMessageCopy>>;
}

/** `table` is the browser table; tests pass a modified one (for example with Edge verified). */
export function buildWizardCopy(context: WizardCopyContext, table: Table = COLLECTOR_BROWSERS): WizardCopy {
  const name = browserName(table, context.browser);
  const address = addressPhrase(table, context.browser);
  const defaultName = defaultBrowserName(table, context.defaultBrowser);
  const supported = wizardSupportedBrowserList(table);
  const verifiedNames = verifiedRows(table).map((row) => row.displayName);
  const loaded = context.loadedVersion ?? UNKNOWN_VERSION;
  const placed = context.placedVersion ?? UNKNOWN_VERSION;
  const devLabel = developerModeLabelPhrase(table, context.browser);
  const selectedRow = rowOf(table, context.browser);
  const startupNote = selectedRow === undefined ? null : STARTUP_DEVELOPER_MODE_NOTE[selectedRow.id];
  const opensPage = selectedRow !== undefined && OPEN_BUTTON_OPENS_PAGE[selectedRow.id];

  const blockedNames = (context.blocked ?? []).map((id) => browserName(table, id));
  const blockedList = blockedNames.length === 0 ? GENERIC_BROWSER : blockedNames.join("、");
  const dragOk = selectedRow !== undefined && DRAG_LOAD_MEASURED[selectedRow.id];

  const downloadButtons = Object.fromEntries(
    table.map((row) => [row.id, `${row.displayName} のダウンロードページを開く`] as const),
  ) as Record<CollectorBrowserId, string>;

  return {
    dialogLabel: "Collector 連携の設定",
    common: {
      loading: "状態を確認しています…",
      back: "戻る",
      next: "次へ",
      later: "あとで設定",
      close: "閉じる",
      retry: "もう一度試す",
      recheck: "もう一度確認",
      cancelWait: "キャンセル",
      finish: "完了",
    },
    stepA: {
      title: "ブラウザーで集めた引用を本棚へ（MAGINALIA Collector）",
      body: fill(
        "MAGINALIA Collector は、Web ページの文章を MAGINALIA の Private Shelf（本棚）に保存するブラウザーの拡張機能です。{supported} で使えます。設定には 5 分ほどかかります。途中でブラウザーの画面を操作していただく手順があります。",
        { supported },
      ),
      bullets: [
        verifiedNames.length >= 2
          ? `このパソコンのあなたのユーザーだけに、MAGINALIA 連携プログラムを登録します（管理者権限は不要です）。${verifiedNames.join("、")} のいずれでも使えるように登録します。`
          : "このパソコンのあなたのユーザーだけに、MAGINALIA 連携プログラムを登録します（管理者権限は不要です）。",
        "拡張機能のフォルダーを用意し、ブラウザーに読み込む手順をご案内します。",
        "保存先の本棚を確認していただきます。本棚のファイルは変更しません。",
      ],
      menuNote: "あとからでも、メニューの「ファイル」→「Collector 連携を設定…」で始められます。",
      radiogroupLabel: "Collector を使うブラウザー",
      selectBrowserFirst: "ブラウザーを選ぶと、次へ進めます。",
      optionRecommendedSuffix: " — おすすめ",
      optionRegisterOtherSuffix: " で登録",
      optionBorrowedBlocked: "このブラウザーが使う登録先が、組織の管理設定により使えません",
      optionRegisterNamed: { chrome: "Chrome で登録", edge: "Edge で登録" },
      optionRegisterDefault: fill("通常のブラウザーで登録（{name}）", { name: defaultName }),
      optionPolicyBlocked: "組織の管理設定により使えません",
      optionDetectionUnknown: "確認できませんでした",
      previouslyChosen: fill("前回は {name} を選びました。", { name: browserName(table, context.preferred) }),
      continueWithoutBrowser: "ブラウザーは入っています（このまま続ける）",
      continueWithSelectedBrowser: "このブラウザーで続ける",
      downloadButtons,
      reasons: {
        "default-supported": {
          lead: fill("ふだんお使いのブラウザー（{name}）で使えます。", { name: defaultName }),
          detail: fill("{name} に Collector を入れることをおすすめします。", { name: defaultName }),
        },
        "default-unsupported": {
          lead: "ふだんお使いのブラウザーには、Collector を入れられません。",
          detail: "下の選択肢から、Collector を使うブラウザーを選んでください。",
        },
        "default-not-chromium": {
          lead: "ふだんお使いのブラウザーは、Collector に対応していません。",
          detail: "Collector は Chromium 系のブラウザーでだけ使えます。下の選択肢から、Collector を使うブラウザーを選んでください。",
        },
        "default-unverified": {
          lead: "ふだんお使いのブラウザーでは、Collector の動作をまだ確認していません。",
          detail: "下の選択肢から、Chrome か Edge を選んでください。",
        },
        "default-not-installed": {
          lead: fill("既定のブラウザーとして {name} が設定されていますが、プログラムが見つかりませんでした。", { name: defaultName }),
          detail: "下の選択肢から、Collector を使うブラウザーを選んでください。",
        },
        "default-unknown": {
          lead: "ふだんお使いのブラウザーを確認できませんでした。",
          detail: "下の選択肢から、Collector を使うブラウザーを選んでください。",
        },
        "none-installed": {
          lead: fill("対応しているブラウザー（{supported}）が見つかりませんでした。", { supported }),
          detail: "いずれかをインストールしてから、もう一度確認してください。",
        },
        "detection-failed": {
          lead: "ブラウザーの確認中に問題が起きました。",
          detail: "お使いのブラウザーを下から選んでください。",
        },
      },
    },
    stepB: {
      title: "連携プログラムを登録する",
      intro: "MAGINALIA とブラウザーをつなぐ連携プログラムを、このユーザーだけに登録します。本棚や引用データには触れません。",
      register: "連携プログラムを登録する",
      switchForeign: "切り替える",
      declineForeign: "やめる",
      cancelRemove: "解除を取りやめる",
    },
    stepC: {
      title: "保存先の本棚を確認する",
      intro: "Collector で保存した引用を書き込む本棚を確認します。",
      detail: "次に表示される確認画面で本棚の名前を確かめ、［この本棚に設定］を押してください。本棚のファイルや識別マーカーは変更されません。",
      confirm: "保存先を確認する",
      confirmAgain: "もう一度確認する",
      chooseAgain: "保存先を選び直す",
      cancelSetup: "Collector のセットアップをキャンセル",
      nextWritesDisabled: "次へ（保存は無効のまま）",
    },
    stepD: {
      title: fill("{name} に Collector を読み込む", { name }),
      intro: fill("拡張機能のフォルダーを用意しました。次の手順で {name} に読み込んでください。", { name }),
      pathNote: "フォルダーの場所は画面には表示しません。［パスをコピー］でクリップボードにコピーするか、［フォルダーを開く］で表示します。",
      openExtensions: fill("{name} で拡張機能の画面を開く", { name }),
      copyAddress: "アドレスをコピー",
      copyPath: "パスをコピー",
      revealFolder: "フォルダーを開く",
      loaded: "読み込みました",
      stepsLabel: "読み込みの手順",
      steps: [
        context.browser === null
          ? fill("お使いのブラウザーを開き、アドレスバーに次のいずれか（ブラウザーに合うもの）を入力して Enter キーを押します。{address}", { address })
          : fill("［{button}］を押します。{result}", {
            button: fill("{name} で拡張機能の画面を開く", { name }),
            result: opensPage
              ? fill("{name} に「拡張機能」の画面が開きます。", { name })
              : fill("{name} が前面に出ます。「拡張機能」の画面は、下の案内のとおりアドレスを入力して開きます。", { name }),
          }),
        developerModeInstruction(table, context.browser),
        loadUnpackedInstruction(table, context.browser),
        "フォルダーを選ぶ画面が開いたら、［パスをコピー］でコピーしたパスを「フォルダー:」欄に Ctrl＋V で貼り付けて、「フォルダーの選択」を押します。",
        "一覧に「MAGINALIA Collector」が表示されれば読み込み完了です。Collector の「はじめに」画面が自動で開きます。",
      ],
      addressNote: context.browser === null
        ? fill("{name}の拡張機能の画面は、アドレスバーに次のいずれか（ブラウザーに合うもの）を入力して開きます。{address}", { name, address })
        : opensPage
        ? fill("開かない場合は、{name} のアドレスバーに {address} と入力して Enter キーを押してください。", { name, address })
        : fill("ボタンを押しても拡張機能の画面が開かないことがあります。その場合は、{name} のアドレスバーに {address} と入力して Enter キーを押してください。", { name, address }),
      alternative: !dragOk ? null : fill(
        "ドラッグでも読み込めます。［フォルダーを開く］で表示される「extension」フォルダーを、{name} の拡張機能の画面にドラッグしてください（{label}がオンのとき）。",
        { name, label: devLabel },
      ),
      cautionsLabel: "ご注意",
      cautions: [
        fill("{name} を複数のユーザー（プロフィール）で使い分けている場合は、Collector を使うプロフィールの画面で読み込んでください。", { name }),
        fill("{label}はオンのままにしてください。", { label: devLabel }),
        ...(startupNote === null ? [] : [startupNote]),
        fill("読み込んだ Collector を {name} から削除しないでください。削除すると、まだ本棚に保存されていない（保留中の）引用も消えます。", { name }),
      ],
      multiBrowserSummary: "別のブラウザーにも入れたい場合",
      multiBrowserNote: "Collector は 1 つのブラウザーで使うことをおすすめします。2 つのブラウザーに入れると、保留中の引用はブラウザーごとに別々に保存されます。",
      policyWarning: fill("組織の管理設定により、{name} で拡張機能を読み込めない可能性があります。", { name }),
      checkingFolder: "拡張機能のフォルダーを確認しています…",
    },
    stepE: {
      title: "接続を確認する",
      waiting: {
        headline: "ブラウザーの Collector からの接続を待っています…",
        detail: "Collector の「はじめに」画面で［もう一度確認］を押すと、すぐに確認できます。",
      },
      howToOpenSummary: "「はじめに」画面を開く方法",
      howToOpenDetail: "ブラウザーのツールバーの Collector アイコンを押し、「はじめに」を選びます。",
      connected: {
        headline: "MAGINALIA Collector から接続を確認しました。",
        detail: null,
      },
      destinationConfigured: "保存先：設定済み",
      destinationNotConfigured: "保存先：未設定（保存は保留されます）",
      versionDiffers: {
        headline: fill("ブラウザーに読み込まれている Collector（{loaded}）が、MAGINALIA に付属する版（{placed}）と異なります。", { loaded, placed }),
        detail: fill(
          "ブラウザーの拡張機能の画面で MAGINALIA Collector の{reload}を押してから、もう一度確認してください。別のフォルダーから読み込んだ Collector がある場合は、保留中の引用がないことを確かめてから、その Collector を削除し、手順 4 / 5 の読み込みをやり直してください。",
          { reload: reloadPhrase(table, context.browser) },
        ),
      },
      protocolDiffers: {
        headline: "Collector と MAGINALIA の版が合わないため、接続できません。",
        detail: "MAGINALIA を最新の版に更新してください。",
      },
      timedOut: {
        headline: "まだ接続を確認できません。",
        checklistLabel: "次の点を確認してください",
        checklist: [
          "拡張機能の一覧に MAGINALIA Collector が表示されていますか",
          fill("表示されている ID が {id} ですか", { id: WIZARD_EXTENSION_ID }),
          "Collector の「はじめに」画面に何と表示されていますか",
        ],
      },
      unavailable: {
        headline: "設定フォルダーのアクセス権を確認できないため、接続を自動で確かめられません。",
        detail: "Collector の「はじめに」画面の表示を、ご自身で確認してください。",
      },
      userConfirmed: {
        headline: "ご確認ありがとうございます。",
        detail: "MAGINALIA からは接続を確認できていませんが、設定を終了します。保存できない場合は「Collector 連携を確認・修復…」をお使いください。",
      },
      waitAgain: "もう一度待つ",
      confirmReady: "Collector の「はじめに」画面に「準備ができました」と表示されている",
      recheck: "もう一度確認",
    },
    done: {
      title: "MAGINALIA Collector の準備ができました。",
      body: "Web ページで文章を選んで右クリックし、「本棚に追加」を選ぶと、この本棚に保存されます。MAGINALIA を閉じていても保存できます。",
      unverifiedTitle: "Collector の設定を終了しました。",
      unverifiedBody: "MAGINALIA からは接続を確認できていません。保存できない場合は「Collector 連携を確認・修復…」をお使いください。",
    },
    messages: {
      "busy": {
        headline: "別の Collector 連携の操作を実行中です。",
        detail: "終わってから、もう一度お試しください。",
      },
      "request-failed": {
        headline: "操作を実行できませんでした。",
        detail: "もう一度お試しください。解決しない場合は、メニューの「Collector 連携を確認・修復…」をお使いください。",
      },
      "unavailable-e2e-isolation": {
        headline: "Collector 連携は、この環境では使えません。",
        detail: "テスト用の分離環境で実行されているため、設定は行いません。",
      },
      "unavailable-payload-unavailable": {
        headline: "Collector 連携に必要なファイルが見つかりません。",
        detail: "MAGINALIA を最新の版に入れ直してください。",
      },
      "unavailable-startup-failed": {
        headline: "Collector 連携の準備ができていません。",
        detail: "MAGINALIA を再起動してから、もう一度お試しください。",
      },
      "inspect-failed": {
        headline: "ブラウザーの確認を完了できませんでした。",
        detail: "［もう一度確認］を押してください。",
      },
      "download-opened": {
        headline: "ダウンロードページを開きました。",
        detail: "インストールが終わったら、［もう一度確認］を押してください。",
      },
      "all-browsers-policy-blocked": {
        headline: fill("組織の管理設定により、{names} はこの種類の連携プログラムを使えないようになっています。", { names: blockedList }),
        detail: "このパソコンでは Collector から本棚へ保存できません。設定は行っていません。管理者にお問い合わせください。",
      },
      "registered-not-effective": {
        headline: fill("連携プログラムを登録しましたが、{name} がこの登録を使えない可能性があります。", { name }),
        detail: "このブラウザーが読む登録先に、別のプログラムの登録があるか、MAGINALIA の登録がありません（Chrome が組織の管理設定で使えない場合など）。このまま進むと、Collector から本棚へ保存できないことがあります。",
      },
      "download-failed": {
        headline: "ダウンロードページを開けませんでした。",
        detail: "ブラウザーの公式ダウンロードページを、直接開いてください。",
      },
      "download-not-offered": {
        headline: "このブラウザーのダウンロードページはご案内していません。",
        detail: null,
      },
      "registered": {
        headline: "MAGINALIA 連携プログラムを登録しました。",
        detail: "このユーザーだけに登録しました。本棚や引用データには触れていません。",
      },
      "registered-verified": {
        headline: "MAGINALIA 連携プログラムを登録しました。",
        detail: "このユーザーだけに登録しました。本棚や引用データには触れていません。連携プログラムの動作を確認しました。",
      },
      "already-ready": {
        headline: "MAGINALIA 連携プログラムは登録済みです（最新の状態です）。",
        detail: null,
      },
      "refreshed": {
        headline: "MAGINALIA 連携プログラムを新しい版に更新しました。",
        detail: null,
      },
      "foreign-confirmation": {
        headline: "別の場所にある連携プログラムが登録されています。",
        detail: "以前に別のインストーラーで入れた「MAGINALIA Collector Host」の可能性があります。MAGINALIA に付属する連携プログラムに切り替えますか？ 本棚や引用データは変更されません。",
      },
      "foreign-declined": {
        headline: "連携プログラムの切り替えをやめました。",
        detail: "設定は変更していません。Collector から本棚へ保存するには、切り替えが必要です。",
      },
      "policy-blocked": {
        headline: "組織の管理設定により、ブラウザーがこの種類の連携プログラムを使えないようになっています。",
        detail: "このパソコンでは Collector から本棚へ保存できません。設定は行っていません。管理者にお問い合わせください。",
      },
      "policy-blocked-browser": {
        headline: fill("組織の管理設定により、{name} はこの種類の連携プログラムを使えないようになっています。", { name }),
        detail: "このパソコンでは Collector から本棚へ保存できません。設定は行っていません。管理者にお問い合わせください。",
      },
      "registry-denied": {
        headline: "連携プログラムを登録できませんでした。",
        detail: "Windows の設定またはセキュリティソフトにより、登録が拒否された可能性があります。本棚や引用データは変更していません。",
      },
      "folder-unsafe": {
        headline: "連携プログラムを置くフォルダーのアクセス権を安全と確認できませんでした。",
        detail: "安全のため、登録を中止しました。フォルダーのアクセス権は変更していません。",
      },
      "file-locked": {
        headline: "連携プログラムのファイルが使用中のため、更新できませんでした。",
        detail: "ブラウザーをいったん閉じてから［もう一度試す］を押してください。",
      },
      "self-check-failed": {
        headline: "連携プログラムを起動できませんでした。",
        detail: "Windows のセキュリティ機能で起動が止められた可能性があります。保存しようとした引用は、ブラウザー内に保留されます。ウィザードをいったん閉じて開き直してください。",
      },
      "register-failed": {
        headline: "連携プログラムを登録できませんでした。",
        detail: "もう一度お試しください。解決しない場合は、メニューの「Collector 連携を確認・修復…」をお使いください。",
      },
      "outdated-remove-paused": {
        headline: "連携プログラムは登録済みですが、解除の途中で止まっています。",
        detail: "解除を取りやめるか完了するまで、連携プログラムの自動更新は止まっています。「解除を取りやめる」を押すと、自動更新が再開されます。このまま次へ進むこともできます。",
      },
      "remove-cancelled": {
        headline: "解除を取りやめました。",
        detail: "連携プログラムの新しい版へは、次回起動時に自動で更新されます。このまま次へ進めます。",
      },
      "remove-not-requested": {
        headline: "取りやめる解除はありませんでした。",
        detail: "解除はすでに予定されていません。連携プログラムの新しい版へは、次回起動時に自動で更新されます。このまま次へ進めます。",
      },
      "remove-already-done": {
        headline: "Collector 連携はすでに解除されています。",
        detail: "もう一度使うには、連携プログラムを登録してください。",
      },
      "remove-cancel-failed": {
        headline: "解除の取りやめを保存できませんでした。",
        detail: "解除はまだ取りやめられていません。もう一度お試しください。解決しない場合は、メニューの「Collector 連携を確認・修復…」をお使いください。",
      },
      "outdated-pending": {
        headline: "連携プログラムは登録済みです。",
        detail: "連携プログラムの新しい版へは、次回起動時に自動で更新されます。このまま次へ進めます。",
      },
      "inflight-slow": {
        headline: "応答に時間がかかっています。",
        detail: "このまま待つこともできます。待つのをやめるときは［キャンセル］を押してください。すでに登録された内容は元に戻りません。",
      },
      "destination-configured": {
        headline: "保存先を設定しました。",
        detail: null,
      },
      "destination-writes-disabled": {
        headline: "保存先は記録しましたが、設定フォルダーの所有者またはアクセス権を安全と確認できないため、Collector からの保存は無効のままです。",
        detail: "フォルダーのアクセス権は自動では変更しません。導入ガイドの「保存できないとき」をご覧ください。",
      },
      "destination-cancelled": {
        headline: "保存先は設定されていません。Collector で保存しようとした引用は、設定するまでブラウザー内に保留されます。",
        detail: null,
      },
      "destination-error": {
        headline: "本棚の識別マーカーを確認できないため、保存先を設定できませんでした。",
        detail: "マーカーの作成や修復は自動では行いません。Shelf 画面で本棚を確認してから、もう一度お試しください。",
      },
      "destination-busy": {
        headline: "別の確認画面が開いています。閉じてからもう一度お試しください。",
        detail: null,
      },
      "extension-not-placed": {
        headline: "拡張機能のフォルダーを確認できませんでした。",
        detail: "［戻る］は 1 つずつ前の手順（手順 3 / 5、手順 2 / 5）へ戻ります。手順 2 / 5 に戻り、連携プログラムの登録をやり直してください。",
      },
      "check-incomplete": {
        headline: "確認できませんでした。",
        detail: "［もう一度試す］を押して、拡張機能のフォルダーをもう一度確認してください。",
      },
      "browser-opened": {
        headline: fill("{name} を前面に表示しました。", { name }),
        detail: "拡張機能の画面が開いていないときは、手順の下のアドレスを入力してください。",
      },
      "browser-not-opened": {
        headline: fill("{name} を起動できませんでした。", { name }),
        detail: context.browser === null
          ? fill("アドレスバーに次のいずれか（ブラウザーに合うもの）を入力してください。{address}", { address })
          : fill("{name} のアドレスバーに {address} と入力してください。", { name, address }),
      },
      "address-copied": {
        headline: "アドレスをコピーしました",
        detail: null,
      },
      "address-copy-failed": {
        headline: "アドレスをコピーできませんでした。",
        detail: "お手数ですが、アドレスバーに手で入力してください。",
      },
      "path-copied": {
        headline: "パスをコピーしました",
        detail: null,
      },
      "path-copy-failed": {
        headline: "パスをコピーできませんでした。",
        detail: "［フォルダーを開く］から、フォルダーをドラッグして読み込んでください。",
      },
      "folder-open-failed": {
        headline: "フォルダーを開けませんでした。",
        detail: null,
      },
    },
  };
}
