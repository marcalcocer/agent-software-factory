/**
 * Documentation agent - updates the documentation and writes the pull-request description.
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
    'Updates CHANGELOG.md, technical docs, OpenAPI specs and generates the pull-request ' +
    'description.',
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
