親ブランチ: dev0.2 : 1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c
作業ブランチ: codex/issue-54-settings-keybindings : 1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c

# Development Request: Issue #54, Settings / Keybindings / Cheat Sheet / Application Menu

## Objective
Complete the end-user configuration and command-discovery surfaces in MAGINALIA Desktop: searchable typed Settings, user-editable shortcuts, dynamically generated Cheat Sheet, and functional **top-level application menus**. Produce a reviewable PR **into `dev0.2`**, never `main`.

## Repository and execution boundary
- Target: `potoha/MAGINALIA_desktop`.
- Perform **all implementation** in a dedicated Git worktree of `codex/issue-54-settings-keybindings`. This branch already exists on `origin` and was created from the stated parent SHA. Do **not** create another branch or overwrite an existing worktree.
- First fetch/verify `origin/dev0.2` and the existing work branch. Both must match the 40-character SHAs above before editing; otherwise stop as `STALE_BASE_COMMIT` and report actual SHAs. Preserve dirty worktree contents. Do not reset, rebase or force push.
- Lead: GPT-6.1 Sol High for architectural decisions and review; delegate clear, bounded implementation and verification slices to GPT-6 Luna Max Fast as available. Keep one command/settings contract authority.
- Project-side scope is architecture/planning/review. Execute actual product code changes in the Codex development environment, not in a planning chat.

## Required sources before editing
- [`AGENTS.md`](https://github.com/potoha/MAGINALIA_desktop/blob/dev0.2/AGENTS.md), `README.md`, `memory/README.md`, `memory/index.json`; retrieve only relevant memory records.
- [Issue #54](https://github.com/potoha/MAGINALIA_desktop/issues/54), **including the 2026-10-13 Product Owner menu addendum**, and relevant merged PRs/current tests.
- Canonical: [`MAGINALIA_IDE/plan/23_POST_MVP_IMPLEMENTATION_ROADMAP.md`](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/23_POST_MVP_IMPLEMENTATION_ROADMAP.md), especially Phase A (shared command surface), Phase B (settings/shortcuts), and alpha scope; relevant accepted ADR / Decision Log entries as identified by `AGENTS.md`.
- Inspect existing implementation first. Known entry points on the verified base include `apps/desktop/src/renderer/command-registry.ts`, `core-commands.ts`, `command-palette.ts`, `renderer/main.ts`, `workbench-commands.ts`, the Electron main/preload bridge, and the existing sidebar Menu. These are pointers, not permission to rewrite every file.

## Required behavior (MUST)
1. **Settings Registry:** searchable categories and settings defined through typed metadata (`id`, title, description, type, default, scope, validation, owner). Show/hide disabled Module contributions safely. Support reset one / section / all safe user settings. Preserve existing project presentation authority and current preferences where compatible; no competing sources of truth.
2. **Shortcut Editor:** display effective shortcuts and platform-appropriate defaults; record/edit assignments with explicit conflict detection and replace/cancel; persist user overrides without mutating defaults. Support binding commands without defaults, and reset one/all. Make keyboard routing honor the effective assignments in editor and normal Workbench contexts.
3. **Cheat Sheet:** generated from currently registered public commands and **effective** shortcuts, searchable and available from both Settings and Help. Do not maintain a divergent hard-coded list. Respect enabled/context predicates and Mod registration lifecycle.
4. **Top-level app menu (Product Owner addition):** provide useful real actions in `File / Edit / View / Insert / Format / Window / Help` (or appropriate translated/platform equivalents). Typical entries: open/save/export Markdown/PDF/DOCX; undo/redo; common formatting and links; writing orientation / supported view actions; Settings and Shortcut Editor; Cheat Sheet/help. Inventory supported commands before choosing exact items. Missing actions must not become fake clickable placeholders.
5. **One command path:** every menu, shortcut, palette, context or sidebar entry for the same action dispatches the same namespaced `CommandRegistry` ID and handler. If Electron-native menu events cross into the renderer, use the existing secure bridge or add the narrowest validated bridge; do not duplicate file/edit/export logic in the main process. Context-disabled commands must remain disabled. Do not create accelerators that bypass overrides or trigger a different command; honor platform-native Edit/Window behavior where appropriate.
6. **Usable UI:** discoverable Settings entry and shortcut-edit flows; keyboard accessibility, focus restoration, visible errors, sensible Japanese-facing labels consistent with product conventions. Preserve current writing/selection behavior and the existing secondary-sidebar Menu.

## Prohibited / deferred (MUST NOT)
- No reimplementation of the established Command Registry, unrelated broad UI redesign, #53 SVG iconography, #47 Importer, GitHub Sync/auth, Mod installer, AI enrichment, data migration, or opportunistic adjacent fixes.
- No API tokens/credentials in ordinary Settings or project-local portable files. No machine-specific paths in portable settings. No unnecessary external runtime services.
- Do not merge into `dev0.2` or `main`, release, deploy, or change the default branch.
- If a key contract, scope conflict, or unsafe state transition requires Product Owner judgment, report the decision and stop that slice rather than inventing policy.

## Acceptance & evidence
- [ ] Typed Settings registration/search/validation, scoped persistence, and resets exercised by automated tests.
- [ ] User override survives restart; unbind/default/reset/conflict flows tested with at least one command lacking a default shortcut.
- [ ] Menu/palette/shortcut all call the same handler; availability changes with command context; registered/unregistered Module contributions update views without stale entries.
- [ ] Cheat Sheet accurately reflects assigned effective shortcuts and searchable command metadata.
- [ ] Real Electron menu routes to the application correctly; keyboard navigation and window focus do not break normal editor input. If Electron smoke cannot run, mark **NOT VERIFIED**, not PASS.
- [ ] Existing writing/export behavior regression-checked; `npm run typecheck`, relevant unit tests, and applicable Electron smoke/build verification run where supported.
- [ ] Every acceptance item reported **PASS / FAIL / NOT VERIFIED** with evidence class (static, unit, Electron, physical Windows) clearly separated.

## Delivery
Keep changes in bounded reviewable commits on the named work branch. Re-check canonical plan consistency and write back only proven completion following `AGENTS.md` (do not independently rewrite accepted product decisions). Push and open **one PR from `codex/issue-54-settings-keybindings` into `dev0.2`** linked to #54. Return branch/HEAD SHA, changed files, command/data model decisions, evidence, remaining risks, and PR URL. No merge until Product Owner review.
