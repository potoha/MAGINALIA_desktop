import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { MAGINALIA_APPLICATION_NAME } from "./application-identity";
import { renderBrandProgressHtml } from "./brand-progress";

export interface BrandProgressSmokeOptions {
  readonly splash: BrowserWindow;
  readonly mainWindow: BrowserWindow;
  readonly outputDirectory: string;
  readonly applicationName: string;
  readonly userDataPath: string;
  readonly expectedUserDataPath?: string;
  readonly update: (message: string, progress: number | null) => void;
  readonly complete: () => void;
}

/** Exercise the actual Electron splash DOM, accessible state, animation, and screenshots. */
export async function runBrandProgressElectronSmoke(options: BrandProgressSmokeOptions): Promise<void> {
  const { splash, mainWindow, outputDirectory, applicationName, userDataPath, expectedUserDataPath, update, complete } = options;
  if (splash.isDestroyed() || !splash.isVisible()) {
    throw new Error("The branded splash window was not visible during the Electron smoke.");
  }
  if (applicationName !== MAGINALIA_APPLICATION_NAME || !mainWindow.getTitle().includes(MAGINALIA_APPLICATION_NAME)) {
    throw new Error("The Electron app or main window did not expose the MAGINALIA α2 wild berry identity.");
  }
  if (expectedUserDataPath !== undefined && path.resolve(userDataPath) !== path.resolve(expectedUserDataPath)) {
    throw new Error("The branded application identity changed the selected Electron userData path.");
  }
  await mkdir(outputDirectory, { recursive: true });

  const zeroPercent = await inspectProgressAt(splash, update, 0);
  const twentyPercent = await inspectProgressAt(splash, update, 0.2);
  await writeFile(path.join(outputDirectory, "brand-progress-20.png"), (await splash.capturePage()).toPNG());
  const eightyPercent = await inspectProgressAt(splash, update, 0.8);
  await writeFile(path.join(outputDirectory, "brand-progress-80.png"), (await splash.capturePage()).toPNG());
  const completePercent = await inspectProgressAt(splash, update, 1);

  assertFullSizeReveal(zeroPercent, 0);
  assertFullSizeReveal(twentyPercent, 20);
  assertFullSizeReveal(eightyPercent, 80);
  assertFullSizeReveal(completePercent, 100);
  if (zeroPercent.accessibleValue !== "0" || twentyPercent.accessibleValue !== "20"
    || eightyPercent.accessibleValue !== "80" || completePercent.accessibleValue !== "100") {
    throw new Error("The branded progress bar did not expose its numeric value to assistive technology.");
  }
  await verifyBrandProgressFallback();

  complete();
  await delay(220);
  if (!mainWindow.isVisible() || (!splash.isDestroyed() && splash.isVisible())) {
    throw new Error("The startup splash did not hand over to the ready main window.");
  }
  const wordmark = await mainWindow.webContents.executeJavaScript(`(() => {
    const image = document.querySelector(".brand-wordmark");
    return { loaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 };
  })()`, true) as { readonly loaded: boolean };
  if (!wordmark.loaded) throw new Error("The supplied header wordmark did not render in the main window.");
  await writeFile(path.join(outputDirectory, "brand-main-window.png"), (await mainWindow.capturePage()).toPNG());
}

async function verifyBrandProgressFallback(): Promise<void> {
  const fallbackWindow = new BrowserWindow({
    width: 460,
    height: 320,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    const html = renderBrandProgressHtml({ logoDataUrl: null, markerDataUrl: null });
    await fallbackWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    const fallback = await fallbackWindow.webContents.executeJavaScript(`(() => {
      const brand = document.getElementById("brand-fallback");
      const paint = document.querySelector(".message-paint");
      const bar = document.getElementById("startup-progress");
      window.maginaliaBrandProgress.update({ message: "処理中", progress: null });
      return {
        visible: !!brand && getComputedStyle(brand).display !== "none",
        markerFallback: !!paint && getComputedStyle(paint).backgroundImage.includes("linear-gradient"),
        accessibleProgress: bar?.getAttribute("role") === "progressbar",
        indeterminate: document.getElementById("brand-progress")?.classList.contains("is-indeterminate") ?? false,
        valueOmitted: bar !== null && !bar.hasAttribute("aria-valuenow"),
        statusMessage: document.getElementById("startup-message")?.textContent ?? "",
        fullSizeStroke: paint !== null && Math.abs(paint.getBoundingClientRect().width - paint.parentElement.getBoundingClientRect().width) < 1,
      };
    })()`, true) as {
      readonly visible: boolean;
      readonly markerFallback: boolean;
      readonly accessibleProgress: boolean;
      readonly indeterminate: boolean;
      readonly valueOmitted: boolean;
      readonly statusMessage: string;
      readonly fullSizeStroke: boolean;
    };
    if (!fallback.visible || !fallback.markerFallback || !fallback.accessibleProgress
      || !fallback.indeterminate || !fallback.valueOmitted || !fallback.fullSizeStroke || fallback.statusMessage !== "処理中") {
      throw new Error("The branded progress fallback did not remain readable and accessible without images.");
    }
  } finally {
    if (!fallbackWindow.isDestroyed()) fallbackWindow.close();
  }
}

async function inspectProgressAt(
  splash: BrowserWindow,
  update: BrandProgressSmokeOptions["update"],
  progress: number,
): Promise<{
  readonly accessibleValue: string | null;
  readonly messageReveal: number;
  readonly trackReveal: number;
  readonly messageClipPath: string;
  readonly trackClipPath: string;
  readonly messageWidthRatio: number;
  readonly trackWidthRatio: number;
  readonly messageTransform: string;
  readonly trackTransform: string;
  readonly messageVisible: boolean;
  readonly hasProgressbar: boolean;
  readonly message: string;
}> {
  const percent = Math.round(progress * 100);
  update(`MAGINALIA α2 wild berry を起動しています · ${percent}%`, progress);
  await delay(260);
  const result = await splash.webContents.executeJavaScript(`(() => {
    const message = document.getElementById("startup-message");
    const bar = document.getElementById("startup-progress");
    const paint = document.querySelector(".message-paint");
    const stroke = document.querySelector(".progress-stroke");
    const reveal = (element) => {
      const clipPath = getComputedStyle(element).clipPath;
      const parts = clipPath.slice(clipPath.indexOf("(") + 1, clipPath.lastIndexOf(")")).trim().split(" ").filter(Boolean);
      const rightInset = parts[1] ?? "";
      return rightInset.endsWith("%") ? 100 - Number.parseFloat(rightInset) : Number.NaN;
    };
    const ratio = (element, parent) => parent.getBoundingClientRect().width === 0
      ? Number.NaN
      : element.getBoundingClientRect().width / parent.getBoundingClientRect().width;
    const paintStyle = paint ? getComputedStyle(paint) : null;
    const strokeStyle = stroke ? getComputedStyle(stroke) : null;
    const messageStage = paint?.parentElement;
    const track = stroke?.parentElement;
    const messageStyle = message ? getComputedStyle(message) : null;
    return {
      message: message?.textContent ?? "",
      accessibleValue: bar?.getAttribute("aria-valuenow") ?? null,
      messageReveal: paint ? reveal(paint) : Number.NaN,
      trackReveal: stroke ? reveal(stroke) : Number.NaN,
      messageClipPath: paint ? getComputedStyle(paint).clipPath : "missing",
      trackClipPath: stroke ? getComputedStyle(stroke).clipPath : "missing",
      messageWidthRatio: paint && messageStage ? ratio(paint, messageStage) : Number.NaN,
      trackWidthRatio: stroke && track ? ratio(stroke, track) : Number.NaN,
      messageTransform: paintStyle?.transform ?? "missing",
      trackTransform: strokeStyle?.transform ?? "missing",
      messageVisible: messageStyle?.display !== "none" && messageStyle?.visibility !== "hidden" && Number(messageStyle?.opacity ?? "1") > 0,
      hasProgressbar: bar?.getAttribute("role") === "progressbar",
    };
  })()`, true) as {
    readonly message: string;
    readonly accessibleValue: string | null;
    readonly messageReveal: number;
    readonly trackReveal: number;
    readonly messageClipPath: string;
    readonly trackClipPath: string;
    readonly messageWidthRatio: number;
    readonly trackWidthRatio: number;
    readonly messageTransform: string;
    readonly trackTransform: string;
    readonly messageVisible: boolean;
    readonly hasProgressbar: boolean;
  };
  if (!result.hasProgressbar || !result.message.includes(`${percent}%`)) {
    throw new Error(`The branded progress state was not rendered at ${percent}%.`);
  }
  return result;
}

function assertFullSizeReveal(
  state: Awaited<ReturnType<typeof inspectProgressAt>>,
  expectedPercent: number,
): void {
  const withinTolerance = (actual: number) => Number.isFinite(actual) && Math.abs(actual - expectedPercent) <= 1.5;
  if (!withinTolerance(state.messageReveal) || !withinTolerance(state.trackReveal)) {
    throw new Error(`The message marker and progress stroke must reveal ${expectedPercent}% from the left; computed clips were ${state.messageClipPath} and ${state.trackClipPath}.`);
  }
  if (Math.abs(state.messageWidthRatio - 1) > 0.015 || Math.abs(state.trackWidthRatio - 1) > 0.015
    || state.messageTransform !== "none" || state.trackTransform !== "none") {
    throw new Error(`The ${expectedPercent}% marker reveal compressed or transformed the original-size artwork.`);
  }
  if (!state.messageVisible) throw new Error("The startup status message became unreadable during the marker reveal.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
