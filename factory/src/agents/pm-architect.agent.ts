/**
 * PM & Architect agent - plans the work before any code is written.
 *
 * Primary: Sonnet-class reasoning model. Fallback: OpenAI flagship (automatic on 429/5xx).
 * Read-only: it inspects the repository and produces the `executionPlan`.
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { filesystemReadTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { detectProjectStackTool } from '../tools/test-runner-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const pmArchitectAgent = new Agent({
  id: 'pm-architect',
  name: 'PM & Architect Agent',
  description:
    'Parses the incoming task, scans the target codebase, applies the convention cascade and ' +
    'produces a structured execution plan (or a clarification request).',
  instructions: ({ requestContext }) =>
    composeInstructions('pm-architect', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('pm-architect'),
  tools: {
    ...filesystemReadTools,
    ...repomixTools,
    ...gitReadTools,
    detectProjectStackTool,
    ...loggerTools,
  },
});
