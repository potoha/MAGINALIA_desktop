import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rendererMainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts");

/**
 * Source-level guard for the Command surface principle: visible controls in
 * the renderer composition root dispatch registered command IDs instead of
 * calling controllers directly. The composition root is DOM-bound, so this
 * checks the wiring text rather than executing it.
 */
describe("renderer UI surfaces dispatch registered command IDs", () => {
  it("routes tab clicks, Shelf result buttons, search, and Project search insertion through commands", async () => {
    const source = await readFile(rendererMainPath, "utf8");

    expect(source).toContain("executeCommand(ACTIVATE_DOCUMENT_COMMAND_ID, { documentId: session.documentId })");
    expect(source).not.toMatch(/addEventListener\("click", \(\) => \{\s*void controller\.activateDocument\(/u);

    expect(source).toContain("executeShelfCommand(SHELF_SELECT_RESULT_COMMAND_ID, { annotationId: reference.annotationId })");
    expect(source).toContain("SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID");
    expect(source).not.toContain("shelfController?.selectResult(");
    expect(source).not.toContain("shelfController?.insertResult(");

    expect(source).toContain("executeShelfCommandAsync(SHELF_SEARCH_COMMAND_ID, { query })");
    expect(source).toContain("executeCommand(PROJECT_MARKDOWN_SEARCH_COMMAND_ID, { query })");
    expect(source).toContain("commandRegistry.execute(INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID");
  });

  it("wires Preview link actions and Workdesk rows through argument commands, not hidden pending state", async () => {
    const source = await readFile(rendererMainPath, "utf8");

    expect(source).toContain("executeCommand(OPEN_INTERNAL_LINK_COMMAND_ID, { fileId })");
    expect(source).toContain("onOpenExternal: (url: string) => {");
    expect(source).toContain("executeCommand(OPEN_EXTERNAL_LINK_COMMAND_ID, { url })");
    expect(source).toContain("executeCommand(\"maginalia.workdesk.removeProject\", { projectIdentityId: project.projectIdentityId })");
    expect(source).toContain("executeCommand(\"maginalia.workdesk.openProject\", { projectIdentityId: project.projectIdentityId })");
    expect(source).not.toMatch(/pendingInternalLinkOpen|pendingQuickOpenFile|pendingWorkdeskProjectIdentityId/u);
  });

  it("gives link context menu locations real contributions", async () => {
    const source = await readFile(rendererMainPath, "utf8");
    expect(source).toMatch(/location: "editor\.link\.internal", command: OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID/u);
    expect(source).toMatch(/location: "editor\.link\.external", command: OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID/u);
  });

  it("writes export panel controls through the Settings Registry only", async () => {
    const source = await readFile(rendererMainPath, "utf8");
    expect(source).toContain("bindExportSettingControls(settingsRegistry, [");
    expect(source).not.toContain("saveExportSettingsFromControls");
    expect(source.match(/exportPresentationSettings: /gu) ?? []).toHaveLength(1);
  });
});
