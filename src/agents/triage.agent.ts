/**
 * Triage agent (Director / Evaluator) - decides what the factory does after a failure.
 *
 * Primary: Sonnet-class reasoning model. Fallback: OpenAI flagship.
 * It reads the run artifacts of previous attempts to perform real root-cause analysis and
 * loop detection instead of relying on a blind retry counter.
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { filesystemReadTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { detectProjectStackTool, runCommandTool } from '../tools/test-runner-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const triageAgent = new Agent({
  id: 'triage',
  name: 'Triage Agent',
  description:
    'Evaluates QA, review and security failures, determines the root cause and routes the run: ' +
    'RETRY_DEVELOPER, RE-RUN_INFRA, ESCALATE_HUMAN or APPROVE_AND_CONTINUE.',
  instructions: ({ requestContext }) =>
    composeInstructions('triage', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('triage'),
  tools: {
    ...loggerTools,
    ...filesystemReadTools,
    ...repomixTools,
    ...gitReadTools,
    detectProjectStackTool,
    runCommandTool,
  },
});
