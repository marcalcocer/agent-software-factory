/**
 * Documentation agent - decides whether the change invalidates any documentation, and updates it.
 *
 * It no longer writes the pull-request text: that is the PR writer's job (a separate, mandatory
 * step), so a task that switches this stage off still gets a proper title and description.
 *
 * Primary: Haiku-class fast model. Fallback: OpenAI mini.
 * Its write tools are restricted to documentation files (Markdown, docs/**, OpenAPI specs),
 * so it can never touch production code or tests.
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { documentationWriteTools, filesystemReadTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const documentationAgent = new Agent({
  id: 'documentation',
  name: 'Documentation Agent',
  description:
    'Decides whether the change invalidates the documentation (README, CHANGELOG, docs, OpenAPI, ' +
    'AGENTS.md, ADRs) and updates exactly what it does. Writes documentation files only.',
  instructions: ({ requestContext }) =>
    composeInstructions('documentation', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('documentation'),
  tools: {
    ...filesystemReadTools,
    ...documentationWriteTools,
    ...gitReadTools,
    ...repomixTools,
    ...loggerTools,
  },
});
