/**
 * Feedback triage agent (Review Orchestrator) - turns human PR review into factory work.
 *
 * Primary: Sonnet-class reasoning model. Invoked when a reviewer comments on a pull request the
 * factory opened. It classifies each comment, routes it to the agent that owns the work
 * (developer / qa-tester / pm-architect / human) and drafts the reply posted back to GitHub.
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { filesystemReadTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { detectProjectStackTool, runCommandTool } from '../tools/test-runner-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const feedbackTriageAgent = new Agent({
  id: 'feedback-triage',
  name: 'Feedback Triage Agent',
  description:
    'Classifies human pull-request review comments and routes them: developer, qa-tester, ' +
    'pm-architect, human or no action. Drafts the reply posted back to the reviewer.',
  instructions: ({ requestContext }) =>
    composeInstructions('feedback-triage', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('feedback-triage'),
  tools: {
    ...loggerTools,
    ...filesystemReadTools,
    ...repomixTools,
    ...gitReadTools,
    detectProjectStackTool,
    runCommandTool,
  },
});
