/**
 * Run namer agent - gives a task its title and the name of its branch.
 *
 * Mandatory and as cheap as an agent call gets: the fast tier, no tools, the words of the request as
 * its only input, one short structured answer. It runs right after the repository is prepared and
 * before the architect, so the branch the work happens on is named for what the work is.
 *
 * It cannot block anything. If it cannot answer (signed out, usage limit, timeout), the run is named
 * from the request itself (`fallbackRunName`) and goes on.
 */
import { Agent } from '@mastra/core/agent';

import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const runNamerAgent = new Agent({
  id: 'run-namer',
  name: 'Run Namer Agent',
  description: 'Names a task: a short title for the run history, a slug and a type for the branch.',
  instructions: ({ requestContext }) =>
    composeInstructions('run-namer', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('run-namer'),
});
