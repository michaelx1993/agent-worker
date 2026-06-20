import type { RepositoryRef, TaskLabel, TaskSnapshot } from "./types.js";

const repoLabelPattern = /^repo:(?<slug>[a-z0-9][a-z0-9._-]*)$/i;

export function labelName(label: string | TaskLabel): string {
  return typeof label === "string" ? label : label.name;
}

export function parseRepositorySlugFromLabels(
  labels: readonly (string | TaskLabel)[] = [],
): string | undefined {
  for (const label of labels) {
    const match = repoLabelPattern.exec(labelName(label).trim());
    if (match?.groups?.slug) {
      return match.groups.slug;
    }
  }

  return undefined;
}

export function resolveRepositoryForTask(
  task: Pick<TaskSnapshot, "repositoryId" | "labels">,
  repositories: readonly RepositoryRef[],
): RepositoryRef | undefined {
  if (task.repositoryId) {
    return repositories.find((repository) => repository.id === task.repositoryId);
  }

  const slug = parseRepositorySlugFromLabels(task.labels);
  if (!slug) {
    return undefined;
  }

  return repositories.find((repository) => repository.slug.toLowerCase() === slug.toLowerCase());
}
