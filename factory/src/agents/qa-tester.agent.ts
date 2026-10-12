/**
 * QA & Tester agent - executes the build/test suite and validates the acceptance criteria.
 *
 * Primary: Haiku-class fast model (test execution is tool-bound, not reasoning-bound).
 * Fallback: OpenAI mini. Read-only on the repository: it reports defects, it never fixes them.
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { filesystemReadTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { testRunnerTools } from '../tools/test-runner-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const qaTesterAgent = new Agent({
  id: 'qa-tester',
  name: 'QA & Tester Agent',
  description:
    'Executes build and test commands, performs API/E2E validation against local endpoints and ' +
    'produces structured bug reports.',
  instructions: ({ requestContext }) =>
    composeInstructions('qa-tester', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('qa-tester'),
  tools: {
    ...testRunnerTools,
    ...filesystemReadTools,
    ...repomixTools,
    ...gitReadTools,
    ...loggerTools,
  },
});
