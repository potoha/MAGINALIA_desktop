import type { ProjectFileSummary, ProjectSummary } from "../project-service";
import type { WorkdeskRegisteredProject } from "../workdesk-service";
import { searchCommandText } from "./command-registry";
import type { CommandPaletteProviderResult } from "./command-palette";

/** Name-only navigation results for registered Projects in the active Workdesk. */
export function searchRegisteredWorkdeskProjects(
  projects: readonly WorkdeskRegisteredProject[],
  query: string
): readonly CommandPaletteProviderResult[] {
  return projects.flatMap((project) => {
    if (!project.available) return [];
    const match = searchCommandText(project.title, query);
    if (match === null) return [];
    return [{
      resultId: project.projectIdentityId,
      commandId: "maginalia.workdesk.openProject",
      args: { projectIdentityId: project.projectIdentityId },
      title: `「${project.title}」を開く`,
      category: "Workdesk Project",
      description: "Open this registered Project",
      relevance: match.relevance,
      titleMatches: match.matches.map(({ start, end }) => ({ start: start + 1, end: end + 1 }))
    }];
  });
}

/** Name-only navigation results for files already listed by the active Project. */
export function searchCurrentProjectDocuments(
  project: ProjectSummary,
  files: readonly ProjectFileSummary[],
  query: string
): readonly CommandPaletteProviderResult[] {
  return files.flatMap((file) => {
    const match = searchCommandText(file.displayName, query);
    if (match === null) return [];
    return [{
      resultId: file.fileId,
      commandId: "maginalia.project.openFile",
      args: { fileId: file.fileId },
      title: file.displayName,
      category: "Project document",
      description: `Open in ${project.displayName}`,
      relevance: match.relevance,
      titleMatches: match.matches
    }];
  });
}
