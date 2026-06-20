import type {
  PromptComponent,
  PromptRenderInput,
  PromptRenderResult,
  PromptScope,
} from "./types.js";

const scopeOrder: Record<PromptScope, number> = {
  global: 0,
  team: 1,
  project: 2,
  repo: 3,
  role: 4,
  agent: 5,
};

export function renderPrompt(input: PromptRenderInput): PromptRenderResult {
  const components = [...input.components].sort(comparePromptComponents);
  const sections = components.map((component) => {
    return `## ${component.scope}: ${component.name} v${component.version}\n\n${component.content.trim()}`;
  });

  sections.push(`## task context\n\n${input.taskContext.trim()}`);

  if (input.commentsAndWorkpad?.trim()) {
    sections.push(`## comments and workpad\n\n${input.commentsAndWorkpad.trim()}`);
  }

  if (input.runtimeConstraints?.trim()) {
    sections.push(`## runtime constraints\n\n${input.runtimeConstraints.trim()}`);
  }

  return {
    content: `${sections.join("\n\n")}\n`,
    componentIds: components.map((component) => component.id),
  };
}

function comparePromptComponents(left: PromptComponent, right: PromptComponent): number {
  const leftOrder = left.order ?? scopeOrder[left.scope];
  const rightOrder = right.order ?? scopeOrder[right.scope];

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return left.name.localeCompare(right.name);
}
