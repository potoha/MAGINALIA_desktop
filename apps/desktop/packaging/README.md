# Windows packaging notes

The application release version is read from `apps/desktop/package.json`. The staged manifest and NSIS product metadata use that version; the installer artifact name includes it. The display name is `MAGINALIA α2 wild berry`. The `appId` (`org.maginalia.desktop.alpha1`), the staged manifest name and the userData location are intentionally unchanged from α1 so that an upgrade keeps its install identity and data.

## Optional Desktop shortcut

The Desktop shortcut is unchecked by default. If `MAGINALIA α2 wild berry.lnk` already exists when the installer runs, including during an upgrade or reinstall, the installer preserves it and reports that it did not add another shortcut.

The installer cannot reliably tell whether a same-name shortcut was replaced after installation. It therefore does not delete the optional Desktop shortcut during uninstall. A shortcut created by MAGINALIA can remain and may be stale after uninstall; the user can remove it from the Desktop. The Start Menu shortcut remains installer-managed.

When upgrading over α1, the installer removes `MAGINALIA desktop α1.lnk` from the Desktop only if it points to the α1 executable in the install directory, and then creates `MAGINALIA α2 wild berry.lnk`. See `docs/desktop-alpha2-packaging.md` for the install-directory analysis.
