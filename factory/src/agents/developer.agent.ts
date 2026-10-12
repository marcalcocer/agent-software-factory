/**
 * Developer agent - implements the plan (production code + tests) in the target repository.
 *
 * Primary: Sonnet-class reasoning model. Fallback: OpenAI flagship.
 * It can read, write and run build/test commands, but it can never commit, push or switch
 * branches: delivery is a separate, gated workflow step.
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { filesystemReadTools, filesystemWriteTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { testRunnerTools } from '../tools/test-runner-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const developerAgent = new Agent({
  id: 'developer',
  name: 'Developer Agent',
  description:
    'Implements feature code and unit/integration tests directly in the target repository, ' +
    'preserving context across retry/fix iterations.',
  instructions: ({ requestContext }) =>
    composeInstructions('developer', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('developer'),
  tools: {
    ...filesystemReadTools,
    ...filesystemWriteTools,
    ...repomixTools,
    ...gitReadTools,
    ...testRunnerTools,
    ...loggerTools,
  },
});
