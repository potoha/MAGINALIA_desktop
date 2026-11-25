# Issue #54 Implementation Handoff

Date: 2026-10-13. Target: `potoha/MAGINALIA_desktop`. PR base: `dev0.2`.

Follow-up: the 2026-10-14 Product Owner review corrections and latest verification are recorded in [Issue #54 Review Fix Handoff](ISSUE54_REVIEW_FIX_HANDOFF.md). This initial report remains historical evidence.

## Git and scope

- Required and verified base: `1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c`. Both remote `dev0.2` and the existing work branch matched before editing.
- Work branch: `codex/issue-54-settings-keybindings`; dedicated managed worktree. Original checkout contents were preserved.
- Contract commit: `27f9fa1`; integrated implementation commit: `1e8354a80c4db3156587de2cc7d5d8410fbca722`. A following documentation commit records this handoff; Git is authoritative for its SHA.
- Scope: searchable typed Settings, Shortcut Editor, generated Cheat Sheet, and seven functional Japanese application-menu groups. No merge, release, deployment, iconography, Importer, remote GitHub synchronization, or unrelated refactor.

## Command and data decisions

`SettingsRegistry` owns typed immutable metadata, search, validation, owner lifecycle and reset operations. Per-setting adapters retain storage authority. The initial UI exposes existing writing-direction/export preferences; project presentation remains independent. Reserved future image-optimization controls are not exposed as functional settings.

`KeybindingService` owns one immutable default map and versioned application-owned overrides (`maginalia.keybindings.v1`, string chord or explicit null per public command ID). Overrides never change defaults. Assignments and resets detect conflicts before mutation and offer replace/cancel. The primary modifier is portable `Mod`; Windows redo defaults to Ctrl+Y, macOS/Linux to Mod+Shift+Z. Palette stays Mod+Shift+P; primary sidebar uses Mod+Shift+B, removing the former duplicate. Ordinary printable/Shift-only typing, IME/AltGraph and reserved OS/native editing chords are protected. Remapped/unbound Monaco default chords are suppressed in authoring surfaces.

The Settings dialog includes Japanese labels, searchable categories, scoped reset controls, recording/save/cancel, visible validation/storage failures, keyboard tabs, native modal focus containment and focus restoration. Cheat Sheet and Palette shortcut labels derive from current public registrations and effective bindings, with current context predicates and registration lifecycle.

Native application menus use a static command allowlist, validated bounded snapshots from the owner window's top frame, and validated command events through preload. Renderer execution checks context again. Accelerators display effective bindings with `registerAccelerator: false`; keyboard dispatch remains in the renderer. Unsupported Unicode accelerator display is omitted without rejecting menu state or Unicode renderer bindings. Native Cut/Copy/Paste/Select All and Window roles are retained. The existing secondary-sidebar Menu remains available.

## Changed files

- Renderer registries: `command-registry.ts`/tests, new `settings-registry.ts`/tests and `keybinding-service.ts`/tests.
- Renderer surfaces: new `settings-center.ts`, integration in `main.ts`, effective labels in `command-palette.ts`, scoped Settings styles in `style.css`.
- Native bridge: new `application-menu-contract.ts`, `application-menu.ts`/tests; `preload-api.ts`/tests and main-process integration.
- Evidence: new `settings-smoke.ts`, `test/settings-smoke.mjs`, and `smoke:settings` package scripts.

## Acceptance and executed evidence

| Acceptance item | Status | Evidence class and actual execution |
| --- | --- | --- |
| Typed registration/search/validation, scope and safe resets | PASS | Unit Settings Registry tests; adapters preserve existing stores. |
| Persistent override, no-default assignment, unbind/default/reset/conflict | PASS | Unit keybinding tests; real Electron two-process profile restore, recorder, conflict cancel, unbind/reset. Replace and reset conflicts exercised in unit tests. |
| Shared handlers, context availability and contribution lifecycle | PASS | Unit registry/menu/keybinding/preload tests; native menu/palette/keyboard use the orientation handler in Electron; Save initially disabled without a document. |
| Generated searchable effective Cheat Sheet | PASS | Real Electron effective chord search; public/context/lifecycle filtering exercised in units. |
| Native menu and keyboard/focus/manuscript preservation | PASS | Real Windows Electron menu callbacks, `sendInputEvent`, dialog focus containment/Escape and unchanged Japanese BOM/CRLF manuscript. |
| Writing and export regression | PASS | `node apps/desktop/test/writing-smoke.mjs`; `node apps/desktop/test/export-electron-pdf-smoke.mjs` (two success markers). |
| Typecheck/build | PASS | Root `npm run typecheck`; Desktop build after final runtime changes. |
| Relevant automated tests | PASS | Final focused five-file suite, 34 tests. |
| Full repository test suite | FAIL | Desktop 833 passed/1 failed at the full-run snapshot; all four package suites passed (15/11/5/24). CRLF/LF tutorial equality failure reproduced unchanged at required base. Later added focused tests also pass. |
| Physical human Windows acceptance | NOT VERIFIED | Automated Electron evidence is distinct from Product Owner manual testing. |
| macOS/Linux runtime and visual comparison | NOT VERIFIED | Platform defaults covered by units; no actual OS/window rendering or final implementation screenshot comparison claimed. |

Build warnings about existing large bundles and missing optional icon presentation fallbacks remain; no unrelated packaging changes were made. No normal-user credentials or machine-local paths were added to portable data.

## Review, canonical write-back and next action

Sol review identified ordinary-text interception, duplicate focus restoration targets and false reset-success messaging. All were corrected; final focused checks and Electron smoke passed. No unresolved security/lifecycle blocker was reported.

Canonical sources checked: `MAGINALIA_IDE/plan/23_POST_MVP_IMPLEMENTATION_ROADMAP.md` Phase A/B, `19_DESKTOP_RENDERER_EDITOR_INTERACTION.md` Settings/Command sections, accepted D037/D047. The smallest Issue #54 evidence entry was added to roadmap 23 with the implementation SHA, real statuses and remaining acceptance. No whole phase was marked DONE and no accepted decision was rewritten. The local canonical checkout has an unrelated modification to plan 27; it was preserved and not committed as part of Desktop work.

Advisory editable design: https://www.figma.com/design/ftBhAgOz4ZBtgMIUIsQGm7.

Next: review the PR into `dev0.2` and perform physical Windows acceptance. Investigate the pre-existing tutorial line-ending test separately. Future Module-specific settings, additional workspace presentation choices, Mod installation and other roadmap slices remain deferred. Do not merge without Product Owner authorization.
