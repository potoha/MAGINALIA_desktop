# MAGINALIA desktop α1 "Before Kaldi"

[日本語 README](README.md)

**MAGINALIA is a desktop editor for reading, quoting, and writing in Japanese.**

It helps students, researchers, and writers organize quotations from books and other sources, develop notes and drafts, and work toward reports, essays, and creative writing. **MAGINALIA is designed primarily for Japanese-language reading, research, and writing.**

Research data is generally stored on the user's own computer. The goal is to make these workflows accessible without requiring knowledge of Git, terminals, or general-purpose programming IDEs.

> **Release status:** Public release of α1 "Before Kaldi" (version 0.1.0) for Windows x64 is being prepared. This is alpha software: bugs and changes to behavior or interfaces are possible. Some interface labels remain in English.

## Download and links

- **Windows download:** Public release pending. A link to GitHub Releases in the official distribution repository will be added when it is available.
- **Official website:** Under construction
- **User manual:** A Japanese PDF manual is bundled with the installer. A repository copy is available [here](assets/マニュアル.pdf).
- **MAGINALIA Capture:** Coming soon. It is a separate product and is not part of the currently distributed Desktop α1.
- **Official Discord:** [MAGINALIA Community](https://discord.gg/RbDJ8DtF7b)
- **Creator's X (formerly Twitter):** [@Shishow_of_PO](https://x.com/Shishow_of_PO)

End users do not need to download this source repository or set up a development environment.

## Features

- **Workdesk / Project:** Organize documents and source materials by research project or creative work.
- **Markdown editor:** Open multiple documents in tabs, edit them, and switch to Preview. Vertical Japanese text display is supported.
- **Private Shelf:** Keep bibliographic information and quotations on your computer, search them, and use them in documents.
- **Reviewer:** Review quotations and annotations before storing them in the Private Shelf.
- **References and Synced Blocks:** Check quotation sources and reference content from other documents.
- **Export:** Export to Markdown, PDF, or DOCX. PDF and DOCX exports can include PNG, JPEG, and WebP images from a Project.
- **Optional OCR:** NDLOCR-Lite 1.3.1 can be selected during installation for local image-to-text recognition. The core application works without this component.
- **Local saving and history:** Changes are saved automatically, and the application provides local Git-backed history.

MAGINALIA does not require cloud synchronization for local writing. GitHub account connection and remote synchronization are not provided as normal-user features in α1.

## Installation and precautions

**Supported platform:** Windows x64. Installers for other operating systems are not provided with this release.

After the public release, download `MAGINALIA-desktop-0.1.0-Setup.exe` from the official distribution page and follow the installation prompts. NDLOCR-Lite is optional and is unchecked by default.

**The installer is not digitally code-signed.** Windows Defender SmartScreen or other Windows security controls may display warnings or restrict execution. Check the distribution source and published SHA-256 checksum, and run the installer only if you trust its origin. A SHA-256 checksum helps detect mismatched or modified files but does not authenticate the publisher.

This is alpha software. Back up important documents and quotation data regularly. Workdesk, Projects, and the Private Shelf are designed to remain separate from the installed application and to be preserved on uninstall, but you should still back them up before reinstalling or removing MAGINALIA.

Markdown export produces a single `.md` file. Referenced images are not bundled, so image files and paths need to be managed separately when transferring the file to another computer.

## For developers and contributors

`MAGINALIA_ALPHA` is the **development source repository** for the independent Electron + Monaco desktop application. It is not the public installer download location. Internal APIs, interfaces, and development-only features may change.

MAGINALIA follows a local-first approach, keeping ordinary files as the authoritative research data. Markdown, YAML, JSON, images, and Git-backed history are intended to remain portable instead of locking users' work into an opaque application-specific database. An AI service is not required.

### Repository layout

```text
MAGINALIA_ALPHA/
├─ apps/desktop/          # Electron desktop application
├─ packages/format/       # Portable data-format contracts
├─ packages/repository-core/
├─ packages/source-core/
├─ packages/writing-core/
├─ sidecars/reviewer/     # Quotation and annotation Reviewer
├─ mods/                  # Experimental Mods
├─ spec/                  # Data-format schemas
├─ docs/                  # Implementation and contract documentation
├─ memory/                # Development context
├─ package.json
└─ package-lock.json
```

### Development

This repository is an npm workspace. Basic development commands:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm start
```

Additional verification includes `npm run smoke`, `npm run smoke:writing`, `npm run smoke:workspace`, `npm run smoke:shelf`, and `npm run smoke:export`. Refer to package manifests and `package-lock.json` for exact dependency versions.

Before making architectural or implementation changes, read [AGENTS.md](AGENTS.md) and consult the relevant parts of the [MAGINALIA_IDE Decision Log](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/09_DECISION_LOG.md) and [alpha development plan](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/27_ALPHA_CLOSE_SLICE_SEQUENCE.md). These links may point to private repositories intended for project contributors.

Historical implementation and design sources include `potoha/MAGINALIA_IDE`, `potoha/MY_marginallia`, and `potoha/Uttate-writer`. `potoha/toybox` is read-only from this project. None of these is the current α1 implementation target.

**Safety boundary:** Local Git-backed history is distinct from synchronization with GitHub or another remote service. Product features for authentication, remote fetch/push, and remote restoration remain frozen in α1. Development-time Git operations are separate.

## License

- MAGINALIA 0.2.0 and later: [GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).
- MAGINALIA 0.1.x and earlier: MIT License ([LICENSE-MIT-0.1.txt](LICENSE-MIT-0.1.txt)). The license of 0.1.x does not change.
- The copyright holder may offer a separate commercial license to organizations that cannot use the software under the AGPL terms. Contact: <contact email>
- See [TRADEMARKS.md](TRADEMARKS.md) for how the "MAGINALIA" name and logo may be used.
- If you would like to contribute, please read [CONTRIBUTING.md](CONTRIBUTING.md).

### Summary (not legal advice)

- You are free to use, modify, and redistribute the software.
- If you distribute a modified version, or offer it to users as a network service, you must make the source code of that modified version available to those users under the same AGPL terms.
- Forks are welcome. Please consider sending improvements upstream.

Third-party libraries and components, including NDLOCR-Lite, remain subject to their respective licenses.

Manuscripts, notes, quotations, and other user-created content do not automatically become subject to MAGINALIA's software license merely because they were created, edited, or processed using the application.

Copyright (C) 2026 MADA 5sounds (go-on) / beyond the Word.
