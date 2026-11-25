import { describe, expect, it } from "vitest";
import { searchCurrentProjectDocuments, searchRegisteredWorkdeskProjects } from "./quick-open-search";

describe("Quick Open name providers", () => {
  it("lists only available registered Projects and dispatches one generic Workdesk command", () => {
    const results = searchRegisteredWorkdeskProjects([
      { projectIdentityId: "opaque-project-1", title: "卒業論文", available: true },
      { projectIdentityId: "opaque-project-2", title: "Quick Notes", available: true },
      { projectIdentityId: "opaque-project-3", title: "Unavailable", available: false }
    ], "卒論");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      resultId: "opaque-project-1",
      commandId: "maginalia.workdesk.openProject",
      args: { projectIdentityId: "opaque-project-1" },
      title: "「卒業論文」を開く",
      category: "Workdesk Project",
      titleMatches: [{ start: 1, end: 2 }, { start: 3, end: 4 }]
    });
    expect(results.some(({ resultId }) => resultId === "opaque-project-3")).toBe(false);
    expect(searchRegisteredWorkdeskProjects([
      { projectIdentityId: "opaque-project-2", title: "Quick Notes", available: true }
    ], "qnt")[0]?.commandId).toBe("maginalia.workdesk.openProject");
  });

  it("searches only listed document display names and routes every result through one Project command", () => {
    const results = searchCurrentProjectDocuments(
      { projectId: "opaque-current-project", displayName: "Research" },
      [
        { fileId: "opaque-file-1", displayName: "chapter-one.md", documentType: "body", title: "Chapter One" },
        { fileId: "opaque-file-2", displayName: "outline.md", documentType: "draft", title: "Outline" }
      ],
      "chpon"
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      resultId: "opaque-file-1",
      commandId: "maginalia.project.openFile",
      args: { fileId: "opaque-file-1" },
      title: "chapter-one.md",
      category: "Project document",
      description: "Open in Research"
    });
    expect(Object.keys(results[0] ?? {}).sort()).toEqual([
      "args", "category", "commandId", "description", "relevance", "resultId", "title", "titleMatches"
    ]);
  });
});
