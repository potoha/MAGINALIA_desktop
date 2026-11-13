export type BrandProgressValue = number | null;

export interface BrandProgressState {
  readonly message: string;
  /** A value from 0 through 1, or null when only indeterminate feedback exists. */
  readonly progress: BrandProgressValue;
}

export interface BrandProgressImages {
  readonly logoDataUrl: string | null;
  readonly markerDataUrl: string | null;
}

export function normalizeBrandProgress(progress: BrandProgressValue): BrandProgressValue {
  if (progress === null || !Number.isFinite(progress)) return null;
  return Math.min(1, Math.max(0, progress));
}

export function createBrandProgressState(message: string, progress: BrandProgressValue): BrandProgressState {
  return Object.freeze({
    message: message.trim() || "MAGINALIA α2 wild berry を準備しています",
    progress: normalizeBrandProgress(progress),
  });
}

/**
 * Build a self-contained, Electron-independent presentation that can also be
 * embedded in a future installer WebView. Dynamic text is always set through
 * textContent by the view; it is never interpreted as markup.
 */
export function renderBrandProgressHtml(images: BrandProgressImages): string {
  const logo = images.logoDataUrl === null
    ? ""
    : `<img id="brand-image" class="brand-image" src="${escapeAttribute(images.logoDataUrl)}" alt="MAGINALIA α2 wild berry">`;
  const markerStyle = images.markerDataUrl === null
    ? ""
    : `--marker-image: url('${escapeAttribute(images.markerDataUrl)}');`;
  const initialState = createBrandProgressState("MAGINALIA α2 wild berry を起動しています", 0);

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>MAGINALIA α2 wild berry</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #29292b;
      --paper: #fffdf3;
      --muted: #74716a;
      --marker-color: #baff13;
      --motion: 180ms;
      font-family: "Yu Gothic UI", Meiryo, system-ui, sans-serif;
      color: var(--ink);
      background: var(--paper);
      font-synthesis: none;
      text-rendering: optimizeLegibility;
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { display: grid; place-items: center; overflow: hidden; }
    main {
      width: min(540px, calc(100vw - 48px));
      padding: 24px 30px 28px;
      text-align: center;
    }
    .brand { min-height: 130px; display: grid; place-items: center; }
    .brand-image { display: block; width: 100%; max-width: 500px; max-height: 142px; object-fit: contain; }
    .brand-fallback { display: none; color: var(--ink); font-size: clamp(28px, 7vw, 40px); font-weight: 650; letter-spacing: 0.04em; }
    .brand-fallback small { display: block; margin-top: 8px; color: var(--muted); font-size: 14px; font-weight: 500; letter-spacing: 0.18em; }
    .brand-fallback::after {
      content: ""; display: block; height: 9px; margin: -14px 3% 0;
      background: var(--marker-color); border-radius: 7px 2px 5px 3px; transform: rotate(-1deg); z-index: -1;
    }
    .message-stage { position: relative; display: grid; align-items: center; min-height: 46px; margin: 13px 0 7px; text-align: left; }
    .message-paint, .message-text { grid-area: 1 / 1; }
    .message-paint {
      align-self: center; height: 32px; width: 100%;
      background-image: var(--marker-image, linear-gradient(93deg, #baff13 0%, #c4f51a 78%, #baff13 100%));
      background-repeat: no-repeat; background-position: center; background-size: 100% 100%;
      clip-path: inset(0 100% 0 0);
      transition: clip-path var(--motion) linear; opacity: 0.88;
    }
    .message-text { position: relative; margin: 0; padding: 8px 7px; font-size: 16px; line-height: 1.45; font-weight: 600; overflow-wrap: anywhere; }
    .progress-track {
      position: relative; height: 34px; overflow: hidden; border-radius: 3px;
      background: linear-gradient(180deg, rgba(41,41,43,0.045), rgba(41,41,43,0.015));
    }
    .progress-stroke {
      position: absolute; inset: 0; width: 100%;
      background-image: var(--marker-image, linear-gradient(93deg, #baff13 0%, #c4f51a 78%, #baff13 100%));
      background-repeat: no-repeat; background-position: center; background-size: 100% 100%;
      clip-path: inset(0 100% 0 0);
      transition: clip-path var(--motion) linear;
    }
    .is-indeterminate .message-paint, .is-indeterminate .progress-stroke {
      clip-path: inset(0 58% 0 0); transform: translateX(-42%);
      animation: marker-sweep 1.8s cubic-bezier(0.42, 0, 0.2, 1) infinite;
    }
    .is-indeterminate .progress-track .progress-stroke { animation-delay: 60ms; }
    .footer { display: flex; justify-content: space-between; gap: 12px; margin-top: 9px; color: var(--muted); font-size: 11px; letter-spacing: 0.04em; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    @keyframes marker-sweep { from { transform: translateX(-42%); } to { transform: translateX(110%); } }
    @media (max-width: 440px) {
      main { width: calc(100vw - 28px); padding: 16px 14px 18px; }
      .brand { min-height: 112px; }
      .brand-image { max-height: 116px; }
      .message-text { font-size: 15px; }
    }
    @media (prefers-reduced-motion: reduce) {
      :root { --motion: 0ms; }
      .is-indeterminate .message-paint, .is-indeterminate .progress-track .progress-stroke {
        animation: none; transform: none;
      }
    }
  </style>
</head>
<body>
  <main id="brand-progress" role="dialog" aria-labelledby="brand-title" aria-describedby="startup-message" style="${markerStyle}">
    <h1 id="brand-title" class="visually-hidden">MAGINALIA α2 wild berry</h1>
    <div class="brand">
      ${logo}
      <div id="brand-fallback" class="brand-fallback" aria-hidden="true">MAGINALIA <small>α2 wild berry</small></div>
    </div>
    <div class="message-stage">
      <span class="message-paint" aria-hidden="true"></span>
      <p id="startup-message" class="message-text" role="status" aria-live="polite">${escapeHtml(initialState.message)}</p>
    </div>
    <div id="startup-progress" class="progress-track" role="progressbar" aria-label="MAGINALIA α2 wild berry の起動状況" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <span class="progress-stroke" aria-hidden="true"></span>
    </div>
    <div class="footer"><span>wild berry</span><span id="progress-caption">0%</span></div>
  </main>
  <script>
    (() => {
      const root = document.getElementById("brand-progress");
      const message = document.getElementById("startup-message");
      const bar = document.getElementById("startup-progress");
      const messagePaint = document.querySelector(".message-paint");
      const progressStroke = document.querySelector(".progress-stroke");
      const caption = document.getElementById("progress-caption");
      const brandImage = document.getElementById("brand-image");
      const fallback = document.getElementById("brand-fallback");
      if (brandImage) {
        brandImage.addEventListener("error", () => {
          brandImage.hidden = true;
          fallback.style.display = "block";
        }, { once: true });
      } else {
        fallback.style.display = "block";
      }
      const update = (state) => {
        const value = state.progress === null || !Number.isFinite(state.progress)
          ? null
          : Math.max(0, Math.min(1, state.progress));
        message.textContent = state.message || "MAGINALIA α2 wild berry を準備しています";
        root.classList.toggle("is-indeterminate", value === null);
        if (value === null) {
          messagePaint.style.removeProperty("clip-path");
          progressStroke.style.removeProperty("clip-path");
          bar.removeAttribute("aria-valuenow");
          bar.setAttribute("aria-valuetext", message.textContent);
          caption.textContent = "";
        } else {
          const percent = Math.round(value * 100);
          const clippedPercent = (100 - percent) + "%";
          messagePaint.style.clipPath = "inset(0 " + clippedPercent + " 0 0)";
          progressStroke.style.clipPath = "inset(0 " + clippedPercent + " 0 0)";
          bar.setAttribute("aria-valuenow", String(percent));
          bar.setAttribute("aria-valuetext", percent + "%");
          caption.textContent = percent + "%";
        }
      };
      window.maginaliaBrandProgress = {
        update,
        getState: () => ({
          message: message.textContent,
          progress: bar.hasAttribute("aria-valuenow") ? Number(bar.getAttribute("aria-valuenow")) / 100 : null
        })
      };
      update(${JSON.stringify(initialState)});
    })();
  </script>
</body>
</html>`;
}

export function brandProgressUpdateScript(state: BrandProgressState): string {
  const normalized = createBrandProgressState(state.message, state.progress);
  return `window.maginaliaBrandProgress?.update(${JSON.stringify(normalized)}); true;`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtml(value: string): string {
  return escapeAttribute(value).replaceAll("'", "&#39;");
}
