/**
 * Phase reconciler agent - compares what a merged phase really delivered with the roadmap.
 *
 * A roadmap is written before the work. Review rounds change what a phase contains (in the real UI
 * refactor, round 2 of phase 1 did most of what the roadmap put in phase 2), and the next phase must be
 * planned against what exists, not against what was once intended. This agent reads a digest of what
 * the phase's runs did and says, for each remaining phase, whether it is untouched, partly done or done.
 *
 * Fast tier, no tools: the digest is in its prompt. Once per merged phase, and only when phases remain.
 */
import { Agent } from '@mastra/core/agent';

import { composeInstructions, repoPathFromRequestContext } from '../utils/context-loader.ts';
import { buildModelChain } from '../utils/model-router.ts';

export const phaseReconcilerAgent = new Agent({
  id: 'phase-reconciler',
  name: 'Phase Reconciler Agent',
  description: 'After a phase is merged, says what it really delivered and how that changes the phases still to come.',
  instructions: ({ requestContext }) =>
    composeInstructions('phase-reconciler', repoPathFromRequestContext(requestContext)),
  model: buildModelChain('phase-reconciler'),
});
