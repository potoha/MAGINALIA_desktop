import { describe, expect, it, vi } from "vitest";
import { ContextKeyService, matchesWhen } from "./command-context";
import { CommandRegistry } from "./command-registry";

describe("ContextKeyService", () => {
  it("evaluates only its bounded primitive vocabulary", () => {
    const context = new ContextKeyService();
    context.patch({ "editor.hasDocument": true, "renderer.orientation": "vertical" });
    expect(matchesWhen(context.snapshot(), "editor.hasDocument && renderer.orientation == vertical")).toBe(true);
    expect(matchesWhen(context.snapshot(), "editor.hasSelection")).toBe(false);
    expect(matchesWhen(context.snapshot(), "window.monaco == live")).toBe(false);
    expect(matchesWhen(context.snapshot(), "editor.hasDocument || editor.hasSelection")).toBe(false);
  });

  it("makes table commands unavailable until their exact active-table context exists", async () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({ id: "maginalia.table.addRowAbove", title: "Add row above", when: "table.bodyCell" }, run);
    registry.register({ id: "maginalia.table.deleteColumn", title: "Delete column", when: "table.canDeleteColumn" }, run);

    expect(registry.discover("", {}).map((command) => command.id)).toEqual([]);
    expect(await registry.execute("maginalia.table.addRowAbove", { "table.bodyCell": false })).toEqual({ kind: "disabled" });
    expect(await registry.execute("maginalia.table.addRowAbove", { "table.bodyCell": true })).toEqual({ kind: "executed" });
    expect(await registry.execute("maginalia.table.deleteColumn", { "table.canDeleteColumn": false })).toEqual({ kind: "disabled" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps Properties Apply unavailable until an editable active document has a dirty valid form", async () => {
    const registry = new CommandRegistry();
    const apply = vi.fn();
    registry.register({ id: "maginalia.document.applyProperties", title: "Apply Properties", when: "properties.available && properties.valid && properties.dirty" }, apply);
    expect(registry.discover("properties", {
      "properties.available": true,
      "properties.valid": true,
      "properties.dirty": false
    })).toEqual([]);
    expect(await registry.execute("maginalia.document.applyProperties", {
      "properties.available": true,
      "properties.valid": true,
      "properties.dirty": true
    })).toEqual({ kind: "executed" });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("exposes Properties reload only for a preserved stale form", async () => {
    const registry = new CommandRegistry();
    const reload = vi.fn();
    registry.register({ id: "maginalia.document.reloadProperties", title: "Reload Properties", when: "properties.stale" }, reload);
    expect(await registry.execute("maginalia.document.reloadProperties", { "properties.stale": false })).toEqual({ kind: "disabled" });
    expect(await registry.execute("maginalia.document.reloadProperties", { "properties.stale": true })).toEqual({ kind: "executed" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not expose Synced Block insertion without a pending safe target", async () => {
    const registry = new CommandRegistry();
    const insert = vi.fn();
    registry.register({ id: "maginalia.syncedBlock.insertDocument", title: "Insert as Synced Block", when: "syncedBlock.insertable" }, insert);
    expect(registry.discover("synced", { "syncedBlock.available": true, "syncedBlock.insertable": false })).toEqual([]);
    expect(await registry.execute("maginalia.syncedBlock.insertDocument", { "syncedBlock.insertable": false })).toEqual({ kind: "disabled" });
    expect(await registry.execute("maginalia.syncedBlock.insertDocument", { "syncedBlock.insertable": true })).toEqual({ kind: "executed" });
    expect(insert).toHaveBeenCalledOnce();
  });

  it("exposes Workdesk return only while a child Project is active", async () => {
    const registry = new CommandRegistry();
    const returnToWorkdesk = vi.fn();
    registry.register({
      id: "maginalia.workdesk.return",
      title: "Return to Workdesk",
      when: "workdesk.active && workdesk.childProject"
    }, returnToWorkdesk);

    const rootContext = { "workdesk.active": true, "workdesk.childProject": false };
    const childContext = { "workdesk.active": true, "workdesk.childProject": true };
    const noWorkdeskContext = { "workdesk.active": false, "workdesk.childProject": false };
    expect(registry.discover("return", rootContext)).toEqual([]);
    expect(await registry.execute("maginalia.workdesk.return", rootContext)).toEqual({ kind: "disabled" });
    expect(await registry.execute("maginalia.workdesk.return", noWorkdeskContext)).toEqual({ kind: "disabled" });
    expect(registry.discover("return", childContext).map((command) => command.id)).toEqual(["maginalia.workdesk.return"]);
    expect(await registry.execute("maginalia.workdesk.return", childContext)).toEqual({ kind: "executed" });
    expect(returnToWorkdesk).toHaveBeenCalledOnce();
  });

  it("keeps Repository and History actions disabled until their live context is ready", () => {
    const registry = new CommandRegistry();
    for (const [id, when] of [
      ["maginalia.repository.open", "repository.available && repository.idle"],
      ["maginalia.repository.activate", "repository.activationAvailable"],
      ["maginalia.repository.history.refresh", "repository.historyAvailable"],
      ["maginalia.repository.history.openCopy", "repository.historySelected"]
    ] as const) {
      registry.register({ id, title: id, when }, vi.fn());
    }

    expect(registry.discover("repository", {}).map((command) => command.id)).toEqual([]);
    expect(registry.discover("repository", {
      "repository.available": true,
      "repository.idle": false
    }).map((command) => command.id)).toEqual([]);
    expect(registry.discover("repository", {
      "repository.available": true,
      "repository.idle": true
    }).map((command) => command.id)).toEqual(["maginalia.repository.open"]);
    expect(registry.discover("history", {
      "repository.available": true,
      "repository.idle": true,
      "repository.activationAvailable": true,
      "repository.historyAvailable": true,
      "repository.historySelected": true
    }).map((command) => command.id)).toEqual([
      "maginalia.repository.history.refresh",
      "maginalia.repository.history.openCopy"
    ]);
  });
});
