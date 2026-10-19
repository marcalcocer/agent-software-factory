/**
 * Merge summary agent - writes the commit message of a squash merge.
 *
 * Runs once, when the user is about to merge a pull request. It is given the *net* diff - what
 * will really land on the base branch - rather than the history of how the branch got there:
 * after a few review rounds the title, the description and the individual commits all describe a
 * path that no longer matches the result.
 *
 * It has no tools. Everything it needs is in its prompt, which keeps the call cheap and means it
 * cannot touch the repository. A cheap-tier model is enough for summarising a diff it is handed;
 * the factory's escalation ladder steps up to the reasoning model if one answer is malformed.
 */
import { Agent } from '@mastra/core/agent';

import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const mergeSummaryAgent = new Agent({
  id: 'merge-summary',
  name: 'Merge Summary Agent',
  description:
    'Writes the commit message (subject and body) of a squash merge from the net diff of a ' +
    'pull request, its description and the style of the base branch.',
  instructions: ({ requestContext }) =>
    composeInstructions('merge-summary', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('merge-summary'),
});
