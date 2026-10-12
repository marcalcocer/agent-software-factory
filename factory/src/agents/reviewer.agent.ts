/**
 * Code Reviewer agent - validates the diff against standards, architecture and maintainability.
 *
 * Primary: Sonnet-class reasoning model. Fallback: OpenAI mini.
 * Strictly read-only: it approves or requests changes, it never edits code.
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { filesystemReadTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const reviewerAgent = new Agent({
  id: 'reviewer',
  name: 'Code Reviewer Agent',
  description:
    'Reviews the git diff against the convention cascade, the architecture and maintainability ' +
    'criteria, and reports blocking findings.',
  instructions: ({ requestContext }) =>
    composeInstructions('reviewer', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('reviewer'),
  tools: {
    ...gitReadTools,
    ...filesystemReadTools,
    ...repomixTools,
    ...loggerTools,
  },
});
