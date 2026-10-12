/**
 * Security agent (AppSec) - audits the diff for OWASP vulnerabilities, secrets and
 * dependency risks.
 *
 * Primary: Sonnet-class reasoning model. Fallback: OpenAI flagship.
 * Read-only, plus allow-listed read-only audit commands (`npm audit`, `dependency:tree`).
 */
import { Agent } from '@mastra/core/agent';

import { gitReadTools } from '../tools/git-tools.ts';
import { filesystemReadTools } from '../tools/filesystem-tools.ts';
import { loggerTools } from '../tools/logger-tools.ts';
import { repomixTools } from '../tools/repomix-tools.ts';
import { detectProjectStackTool, runCommandTool } from '../tools/test-runner-tools.ts';
import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const securityAgent = new Agent({
  id: 'security',
  name: 'Security Agent',
  description:
    'Scans the diff for OWASP Top 10 vulnerabilities, hardcoded secrets, injection flaws and ' +
    'dependency risks.',
  instructions: ({ requestContext }) =>
    composeInstructions('security', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('security'),
  tools: {
    ...gitReadTools,
    ...filesystemReadTools,
    ...repomixTools,
    detectProjectStackTool,
    runCommandTool,
    ...loggerTools,
  },
});
