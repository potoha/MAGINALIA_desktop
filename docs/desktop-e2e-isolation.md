# Desktop E2E isolation harness (Desktop #93)

Test-only. This harness keeps a Desktop E2E run (Collector-only or first-run
scenario) inside one disposable, test-owned root. It does not change product
behavior when it is not activated.

## Layers

1. **Harness, before spawn (primary guarantee).** `apps/desktop/test/e2e-isolation-harness.mjs`
   validates the root and every Desktop-controlled destination in plain Node.
   If any check fails, it never spawns Electron. It always passes
   `--user-data-dir=<root>/userData` itself and refuses that switch as an app
   argument. This layer is required because Electron 44 creates the
   `--user-data-dir` directory natively, before any application JavaScript
   runs. A real-Electron probe confirmed it: with a wrong directory the gate
   exits 78, and the directory exists but is empty. An in-app check alone can
   therefore stop every Desktop write, but it cannot stop that directory from
   being created.
2. **In-app gate, before Electron app initialization.** `apps/desktop/src/e2e-isolation.ts`
   is called from `main.ts` before `establishApplicationIdentity()`, which
   creates userData, and before any store, IPC handler, first-run action or
   window. It runs only when `MAGINALIA_E2E_ISOLATION_ROOT` is set. It then:
   - validates the root;
   - checks the userData path that Electron selected;
   - checks any `MAGINALIA_FIRST_RUN_SMOKE_{WORKDESK,SHELF,DOWNLOADS,OUTPUT}`
     path;
   - redirects Electron's `downloads` and `documents` keys to
     `<root>/Downloads` and `<root>/Documents`, which also hold the default
     first-run Workdesk and Private Shelf;
   - re-reads both keys;
   - writes `evidence/startup-isolation-<pid>.json` and prints
     `MAGINALIA_E2E_ISOLATION_OK`.

   On any mismatch it prints `MAGINALIA_E2E_ISOLATION_FAILED code=<code>` and
   exits with code **78**. There is no fallback to the normal
   `Roaming\Electron` profile.

## Why the gate cannot activate in normal product runs

- The gate is inert without the environment variable, and normal launches
  (Start menu, shortcut, installer "run after finish") do not set it.
- The gate never chooses userData. userData still comes only from Electron's
  `--user-data-dir` switch, or from Electron's default. The gate can refuse a
  launch, but it cannot relocate an existing profile.
- The gate redirects only `downloads` and `documents`, and only into a root
  that passes every one of these checks:
  - an absolute local drive path (no UNC, device namespace or `..`);
  - not a filesystem root;
  - does not contain the user's home directory, `%APPDATA%` or
    `%LOCALAPPDATA%`;
  - no symbolic link or junction in any path component;
  - contains the harness marker `maginalia-e2e-isolation-root.json`
    (`{"kind":"maginalia-e2e-isolation-root","version":1}`).

  A stray variable therefore fails closed or confines writes to a test-owned
  directory. It cannot widen data access.
- Destinations are compared in both the supplied spelling and the canonical
  spelling (`realpath`, which expands 8.3 short names and case). Comparison is
  case-insensitive on Windows. Any existing component that is a link or
  junction is rejected.

## Not redirected: coordination and binding root

The native per-user coordination and binding root
(`SHGetKnownFolderPath(FOLDERID_LocalAppData)\MAGINALIA`) cannot be configured,
by design (#86 design memo §1/§6), so the gate does not redirect it. In the
Collector-only and first-run scenarios, Desktop resolves that root only lazily,
on the Reviewer write path. Record its state before and after each run with
`audit`. The product-Host Phase 4 plan backs it up separately.

## Usage

```sh
npm run build && npm run build:native            # in apps/desktop
node test/e2e-isolation-harness.mjs prepare <root>
node test/collector-shelf-e2e-verify.mjs snapshot <shelf> <root>/evidence/pre-first-run.json --allow-missing
node test/e2e-isolation-harness.mjs launch <root> [--packaged <win-unpacked exe>] [--env NAME=VALUE ...] [-- <app args>]
node test/collector-shelf-e2e-verify.mjs snapshot <shelf> <root>/evidence/pre-collector.json
#   ... Collector save ...
node test/collector-shelf-e2e-verify.mjs collector-only --descriptor <d.json> --baseline <pre-collector.json> --expected-quote <text> [--expected-url <url>]
node test/collector-shelf-e2e-verify.mjs first-run --descriptor <d.json> --baseline <pre-collector.json> --first-run-baseline <pre-first-run.json> --expected-quote <text>
node test/e2e-isolation-harness.mjs inventory <dir> <out.json>
node test/e2e-isolation-harness.mjs audit <out.json> "<label>=<path>[:name1|name2]" ...
```

The verifier asserts per-request deltas, not global counts:

- **Collector-only:** +1 Book and +1 Annotation since the pre-Collector
  baseline, with no other new file. The Book and Annotation IDs must equal the
  committed journal record.
- **First-run:** the records added since the pre-first-run baseline must be
  exactly the tutorial seed Books and Annotations (+3/+3 for the bundled
  sample), with content identical to the seed. The Collector +1/+1 is checked
  separately.
- **Both:** every file in a baseline must keep its SHA-256.

`audit` is read-only metadata (existence, size and mtime of named entries
only). Use it for the real `Roaming\Electron` and Downloads impact audit. It
never reads file contents or lists unnamed user files. Cleanup is manual:
delete only a root that carries the harness marker, after every process using
it has exited.

`npm run test:e2e-isolation` runs the unit tests and the real-Electron
acceptance in `test/e2e-isolation-smoke.test.mjs`. That acceptance covers:

- harness refusals;
- in-app exit 78 for an outside userData, an outside smoke path, or a missing
  marker;
- Collector-only +1/+1;
- first-run tutorial +3/+3 plus Collector +1/+1, using the real test-only
  Collector Host.

To run the Electron cases against a packaged `win-unpacked` executable, set
`MAGINALIA_SMOKE_PACKAGED_EXECUTABLE`.

**Packaged app.** The same isolation applies to the packaged app. Electron
honors `--user-data-dir` in packaged builds, and the gate is part of the
product main process. With `MAGINALIA_SMOKE_PACKAGED_EXECUTABLE` set to the α2
`win-unpacked` executable, the acceptance passed 4/4. An *installed* NSIS app
is isolated the same way: launch its executable through the harness. That run
is NOT VERIFIED here because the installer was not run.

## Limits

- The acceptance drives the existing `--smoke` and `--first-run-smoke` modes,
  not manual UI interaction. The real-Chrome, owner-observed UI and installed
  NSIS steps remain manual.
- Only Node `lstat` link detection is used. It reports symbolic links and
  junctions. Other reparse tags are caught by the canonical containment check.
