/**
 * PR writer agent - writes the text a change is published with: the commit message, the
 * pull-request title and the pull-request description.
 *
 * This used to be a side job of the documentation agent, which meant a task that switched the
 * documentation stage off was published with a placeholder title and an empty description. It is its
 * own, mandatory step now: the text of a pull request does not depend on whether the documentation
 * was touched.
 *
 * Primary: Haiku-class fast model (the tier the documentation agent wrote this text on).
 * It has no tools. The diff and the reports are in its prompt, so it can only write text - it cannot
 * read the repository, run anything or change a file.
 */
import { Agent } from '@mastra/core/agent';

import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const prWriterAgent = new Agent({
  id: 'pr-writer',
  name: 'PR Writer Agent',
  description:
    'Writes the commit message, the pull-request title and the pull-request description from the ' +
    'final diff and the reports of the earlier stages.',
  instructions: ({ requestContext }) =>
    composeInstructions('pr-writer', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('pr-writer'),
});
