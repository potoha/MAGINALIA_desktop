# Experimental Collector Native Host: Windows / Chrome smoke

This is a development-only transport and read-only identity test. It is not an
installer, a production registration, an approved descriptor or a Collector
protocol. Use a disposable Chrome profile, a disposable extension, a disposable
Shelf fixture, and a unique test host name. Never point this procedure at user
research data. Chrome, Node and development dependencies are needed only for this
manual test; the production runtime and its packaging remain undecided.

1. Build the workspaces (`npm run build`) and locate the absolute paths of the
   Node executable and `apps/desktop/dist/main/collector-native-host.js`.
   Close the Desktop UI for the test.
2. Create an empty temporary directory, a new Chrome profile under it, and an
   unpacked Manifest V3 test extension under it. Give the extension the
   `nativeMessaging` permission and a service worker. Load it in the disposable
   profile using `chrome://extensions` and record its generated extension ID.
   Do not reuse the production Collector profile or ID.

   For example, use this `manifest.json` with `worker.js` in the same directory:

   ```json
   {"manifest_version":3,"name":"Native Host isolated smoke","version":"1.0","permissions":["nativeMessaging"],"background":{"service_worker":"worker.js"}}
   ```

   After substituting the unique host name, use the service worker's DevTools
   console to run the following for each operation and inspect the response:

   ```js
   chrome.runtime.sendNativeMessage("org.maginalia.smoke_<unique_suffix>",
     {protocol: "maginalia.collector.experimental.v1", operation: "health"},
     response => console.log(response, chrome.runtime.lastError?.message));
   ```

   A minimal `worker.js` may be empty; the console is opened from the extension
   details page. Start a separate fresh Chrome process so it inherits the test
   environment, rather than attaching to an existing Chrome process.
3. Create a disposable valid Shelf fixture, including a typed Shelf `.magi`
   marker and valid `library.json`. Create a separate `shelf_location.yml` in
   the same temporary tree in the current Desktop registry format, whose single
   `private_shelf.registry` points to the fixture. Record its marker UUID as an
   independently supplied expected identity. The Host never creates or repairs
   a marker. Keep a copy of the fixture for comparison afterwards.
4. Create a test-only JSON descriptor in that tree with exactly these fields:

   ```json
   {"experimental":true,"shelfLocationPath":"<absolute fixture shelf_location.yml>","expectedShelfId":"<fixture marker UUID>","allowedOrigin":"chrome-extension://<test extension ID>/"}
   ```

   Use JSON escaping for Windows paths. Set
   `MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR` to its absolute path in the
   environment used to start Chrome. Do not configure it globally or place it
   in a production profile. The descriptor contains machine-local paths and
   must not be committed.
5. Create a temporary Windows `.cmd` launcher that invokes the absolute Node
   executable and built host entry point, passing all Chrome arguments (`%*`),
   without printing to stdout. Create a temporary Chrome host manifest with a
   unique test-only name such as `org.maginalia.smoke_<unique_suffix>`, an
   absolute path to that launcher, `type: "stdio"`, and `allowed_origins`
   containing exactly `chrome-extension://<test extension ID>/`. The manifest
   name must match the registry key and the name used in the extension call.
   Register it only under the current user's Chrome NativeMessagingHosts key.
   Before creating the test key, verify it does not already exist; do not
   overwrite any existing registration. Record the exact key and manifest path.
   The registry key is
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\<test host name>`;
   its default value is the absolute temporary manifest path. An example
   manifest shape, after substituting paths and ID, is:

   ```json
   {"name":"org.maginalia.smoke_<unique_suffix>","description":"isolated test","path":"<absolute launcher.cmd>","type":"stdio","allowed_origins":["chrome-extension://<test extension ID>/"]}
   ```

   Escape backslashes in JSON. The launcher can contain a single command of
   the form `"<absolute node.exe>" "<absolute collector-native-host.js>" %*`.
6. Start Chrome with the disposable `--user-data-dir`, inheriting the descriptor
   environment. In the test extension's service worker, invoke
   `chrome.runtime.sendNativeMessage` with the test host name and
   `{protocol: "maginalia.collector.experimental.v1", operation: "health"}`.
   Check that the response is successful, `experimental` is true and writes are
   disabled. Repeat with operation `configured_shelf`; confirm the returned ID
   and name match the fixture and no absolute path is returned. Check
   `chrome.runtime.lastError` if no response arrives.
7. Change only the test descriptor's expected UUID and repeat: identity mismatch
   must be reported, not a successful Shelf response. Restore the descriptor and
   try an unknown operation and a different extension ID: neither should obtain
   Shelf data. Compare the fixture with its initial copy to confirm no files were
   created or modified. A successful Chrome exchange proves this test transport
   only, not production origin authorization, packaging, or Shelf writes.
8. Close all Chrome processes using the temporary profile. Verify the recorded
   test registry key still points to the recorded temporary manifest; remove only
   that exact key, then verify it is absent. Remove only the known temporary
   test tree after verifying its absolute path. Confirm no test registration,
   profile, or Chrome process remains. If any ownership check fails, stop and
   report cleanup as incomplete rather than deleting an unrelated registration.

Record Windows and Chrome versions, test ID and host name (not private paths),
each expected/actual response, fixture comparison, cleanup evidence, and any
failures. This procedure does not prove production installation or update.

## Installer design gates

Before a product Installer can enable this integration, decide and verify the
approved extension identity and browser targets; packaged executable/runtime;
descriptor ownership, ACL, location, update and expected-ID binding; manifest
and registry scope; caller validation; lifecycle and rollback. Installation,
upgrade, repair and uninstall must manage only registrations and files owned by
that installation, handle changed paths and extension identity safely, and retain
user research data. Test fresh profiles, exact-origin rejection, upgrades,
rollback and uninstall on supported Windows/Chrome configurations. No choice in
this smoke procedure selects those product decisions. Cross-process write safety,
recovery, durable acknowledgement and idempotency remain separate gates before
any write capability is enabled.
