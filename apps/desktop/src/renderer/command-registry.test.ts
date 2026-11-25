import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, searchCommandText } from "./command-registry";

describe("CommandRegistry", () => {
  it("registers, discovers, executes and unregisters commands", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    const dispose = registry.register({ id: "maginalia.editor.bold", title: "Toggle Bold", description: "Apply bold formatting.", category: "Editor", keywords: ["strong"] }, handler);
    expect(registry.discover("formatting", {}).map((item) => item.id)).toEqual(["maginalia.editor.bold"]);
    expect(registry.get("maginalia.editor.bold")?.description).toBe("Apply bold formatting.");
    expect(await registry.execute("maginalia.editor.bold", {})).toEqual({ kind: "executed" });
    expect(handler).toHaveBeenCalledOnce();
    dispose();
    expect(await registry.execute("maginalia.editor.bold", {})).toEqual({ kind: "missing" });
  });

  it("ranks title matches above metadata matches and returns title highlight ranges", () => {
    const registry = new CommandRegistry();
    registry.register({ id: "maginalia.editor.toggleBold", title: "Toggle Bold", category: "Editor" }, () => undefined);
    registry.register({
      id: "maginalia.settings.boldOptions",
      title: "Formatting Options",
      description: "Toggle bold appearance in the editor"
    }, () => undefined);

    const results = registry.search("toggle bold", {});
    expect(results.map(({ descriptor }) => descriptor.id)).toEqual([
      "maginalia.editor.toggleBold",
      "maginalia.settings.boldOptions"
    ]);
    expect(results[0]?.titleMatches).toEqual([{ start: 0, end: 6 }, { start: 7, end: 11 }]);
    expect(results[1]?.descriptionMatches).toEqual([{ start: 0, end: 6 }, { start: 7, end: 11 }]);
    expect(registry.search("toggle absent", {})).toEqual([]);
  });

  it("returns category highlight ranges when category text is the visible match", () => {
    const registry = new CommandRegistry();
    registry.register({ id: "maginalia.project.search", title: "Open List", category: "Project" }, () => undefined);

    expect(registry.search("project", {})[0]?.categoryMatches).toEqual([{ start: 0, end: 7 }]);
  });

  it("returns UTF-16-safe match ranges for Japanese and supplementary Unicode text", () => {
    const registry = new CommandRegistry();
    registry.register({ id: "maginalia.example.unicode", title: "𠀀 文書を開く" }, () => undefined);

    expect(registry.search("𠀀", {})[0]?.titleMatches).toEqual([{ start: 0, end: 2 }]);
    expect(registry.search("文書", {})[0]?.titleMatches).toEqual([{ start: 3, end: 5 }]);
  });

  it("uses the same fuzzy ranking and UTF-16 highlight ranges for dynamic navigation names", () => {
    expect(searchCommandText("卒業論文", "卒論")).toMatchObject({ matches: [{ start: 0, end: 1 }, { start: 2, end: 3 }] });
    expect(searchCommandText("Quick Open", "qop")?.matches).toEqual([{ start: 0, end: 1 }, { start: 6, end: 8 }]);
    expect(searchCommandText("卒業論文", "不存在")).toBeNull();
  });

  it("rejects duplicate ids and does not run disabled commands", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register({ id: "maginalia.editor.bold", title: "Bold", when: "editor.hasSelection" }, handler);
    expect(() => registry.register({ id: "maginalia.editor.bold", title: "Again" }, handler)).toThrow("already registered");
    expect(await registry.execute("maginalia.editor.bold", { "editor.hasSelection": false })).toEqual({ kind: "disabled" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires stable namespaced identifiers and normalizes a missing description", () => {
    const registry = new CommandRegistry();
    expect(() => registry.register({ id: "bold", title: "Bold" }, () => undefined)).toThrow("Invalid command descriptor");
    registry.register({ id: "maginalia.editor.bold", title: "Bold" }, () => undefined);
    expect(registry.get("maginalia.editor.bold")?.description).toBe("Bold");
  });

  it("keeps internal commands executable while hiding them from public discovery by default", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register({ id: "maginalia.internal.reconcile", title: "Reconcile", visibility: "internal" }, handler);

    expect(registry.get("maginalia.internal.reconcile")?.visibility).toBe("internal");
    expect(registry.list({}).map(({ id }) => id)).toEqual([]);
    expect(registry.discover("reconcile", {})).toEqual([]);
    expect(registry.list({}, false, true).map(({ id }) => id)).toEqual(["maginalia.internal.reconcile"]);
    expect(registry.discover("reconcile", {}, true).map(({ id }) => id)).toEqual(["maginalia.internal.reconcile"]);
    expect(await registry.execute("maginalia.internal.reconcile", {})).toEqual({ kind: "executed" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects unknown command visibility values", () => {
    const registry = new CommandRegistry();
    expect(() => registry.register({
      id: "maginalia.command.invalidVisibility",
      title: "Invalid visibility",
      visibility: "private" as never
    }, () => undefined)).toThrow("Invalid command descriptor");
  });

  it("keeps a stale registration disposer from removing a replacement command", () => {
    const registry = new CommandRegistry();
    const oldDispose = registry.register({ id: "maginalia.example.lifecycle", title: "Old" }, () => undefined);
    registry.unregister("maginalia.example.lifecycle");
    const replacementDispose = registry.register({ id: "maginalia.example.lifecycle", title: "Replacement" }, () => undefined);

    oldDispose();
    expect(registry.get("maginalia.example.lifecycle")?.title).toBe("Replacement");
    replacementDispose();
    expect(registry.get("maginalia.example.lifecycle")).toBeNull();
  });

  it("snapshots and freezes caller-owned keywords", () => {
    const registry = new CommandRegistry();
    const keywords = ["portable"];
    registry.register({ id: "maginalia.example.immutable", title: "Immutable", keywords }, () => undefined);
    keywords.push("mutated");

    const registered = registry.get("maginalia.example.immutable");
    expect(registered?.keywords).toEqual(["portable"]);
    expect(Object.isFrozen(registered?.keywords)).toBe(true);
  });

  it("isolates failing commands from other commands", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "dev.example.fail", title: "Broken Mod" }, () => { throw new Error("nope"); }, "mod");
    const good = vi.fn();
    registry.register({ id: "maginalia.core.good", title: "Core Good" }, good);
    expect((await registry.execute("dev.example.fail", {})).kind).toBe("failed");
    expect(await registry.execute("maginalia.core.good", {})).toEqual({ kind: "executed" });
    expect(good).toHaveBeenCalledOnce();
  });
});
