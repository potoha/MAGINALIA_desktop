# Issue #54 / PR #70 Review Fix Handoff

Date: 2026-10-14. PR: https://github.com/potoha/MAGINALIA_desktop/pull/70. Target branch: `dev0.2`. Draft remains open; no merge approval or closure.

## Git and authorized scope

- Reviewed and verified starting HEAD: `127f74adebc4a74d76d304a1a3d5a49c0c227131`; local and remote work branch matched with a clean worktree before changes. No new expected-base requirement was supplied. Original implementation base remains `1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c`.
- Source correction commit: `26d66b4f9938ec640648318e6f24925f3a2f7094`. The following documentation commit contains this report; Git and the PR identify the final pushed HEAD.
- Work branch: `codex/issue-54-settings-keybindings`, in the existing dedicated managed worktree. Source and documentation changes are bounded to the two Product Owner P1 review requests and their regressions. No reset, rebase, force push, default-branch change or unrelated cleanup.

## Corrections and behavior

**P1: global shortcuts from normal inputs.** The capture router now distinguishes ordinary text fields from authoring surfaces. Enabled non-editing global commands, including effective Palette and Save assignments, dispatch through the existing Command Registry. Native field editing, editor mutations and default/alternate Undo/Redo stay with the focused field. Disabled, remapped and unbound Save defaults are consumed to prevent Electron/Chromium browser fallthrough. Dialog/Palette isolation, IME handling, manuscript selection and effective overrides remain intact.

**P1: false durable-save feedback.** The live renderer preference store now returns an observable success/failure while preserving nonthrowing ordinary authoring behavior. Strict Settings direction writes retry persistence even when the displayed direction is unchanged, and persist before presentation changes. Export Settings persist a candidate before replacing active settings. Errors reach the Settings Registry/UI, with prior values retained. Keybindings reject mutations when their default persistent storage is unavailable; only explicit `storage: null` construction uses the intentional in-memory mode. Write/reset failures retain previous overrides.

Stores, keys and portable data formats are unchanged. No credentials, user-data migration or new source of truth were introduced. An additional review edge case concerning Ctrl+Shift+Z native Redo was fixed and covered in Electron.

## Changed files

- `renderer/main.ts`: input routing and transactional Settings adapters.
- `renderer/native-input-keybinding.ts` / tests: small routing policy for native fields.
- `renderer/renderer-preferences.ts` / tests: observable storage failure.
- `renderer/preview-controller.ts` / tests: strict persistence with safe ordinary authoring.
- `renderer/keybinding-service.ts` / tests: distinguish inaccessible default storage from explicit ephemeral use.
- `settings-smoke.ts`: focused-input and throwing-storage regressions using the existing isolated Electron harness.
- This report and a follow-up link in the original handoff.

## Executed acceptance evidence

| Item | Status | Evidence class |
| --- | --- | --- |
| Global default/effective Palette from Shelf search; focus/text preserved | PASS | Real Windows Electron `sendInputEvent`, before and after override; two-process Settings smoke. |
| Save from normal fields, including disabled/default/remapped/unbound states | PASS | Electron key input plus cancelable DOM-event checks proving default behavior is prevented; writing smoke proves existing durable save path. |
| Native Undo/Redo including Ctrl+Shift+Z with a global override | PASS | Pure policy tests and real Electron alternate-Redo regression; background manuscript remains unchanged. |
| Preference and shortcut unavailable/throwing-storage behavior | PASS | Unit tests for inaccessible localStorage and failed writes/resets; real Electron Settings controls with injected `Storage.prototype.setItem` failure show errors and retain stored/active paper, direction and binding state. |
| Relevant automated tests | PASS | Five files / 36 tests: native-input-keybinding, keybinding-service, renderer-preferences, preview-controller and settings-registry. |
| Typecheck and build | PASS | Root `npm run typecheck`; `npm run build --workspace @maginalia/desktop`. |
| Restart, writing and export regression | PASS | `node apps/desktop/test/settings-smoke.mjs` (both processes), `writing-smoke.mjs`, `export-electron-pdf-smoke.mjs` (both success markers). |
| Focused read-only Sol review | PASS | No remaining blocking findings after the alternate-Redo fix. |
| Full repository suite on this correction | NOT VERIFIED | Not rerun. The original run's one CRLF/LF tutorial failure was reproduced on the untouched base and remains separate debt. |
| Human physical Windows acceptance; macOS/Linux runtime; final visual comparison | NOT VERIFIED | Automated Windows Electron evidence does not claim these acceptance classes. |

The local smoke profiles and injected failures do not use the normal user profile. No screenshots or human acceptance are fabricated. Existing build warnings remain outside this correction.

## Canonical write-back, remaining debt and next action

Rechecked current roadmap 23 Phase A/B, plan 19 Settings persistence and accepted D037/D047. These corrections restore the planned global-command and durable-Settings behavior without changing accepted product policy.

Added the smallest dated review-correction evidence entry to local `MAGINALIA_IDE/plan/23_POST_MVP_IMPLEMENTATION_ROADMAP.md`, with the correction commit and actual statuses. Preserved its earlier evidence and the unrelated existing plan 27 changes. The canonical update remains local/uncommitted; publication through the authorized documentation workflow is pending before issue closure. No additional canonical PR or direct main push was created. Neither the whole phases nor physical acceptance is marked DONE.

Next: Product Owner re-review of the corrected draft PR, physical Windows acceptance and authorized canonical documentation publication. The existing tutorial line-ending failure, other-platform runtime and visual acceptance remain deferred. This work does not authorize merge, release or closure.
