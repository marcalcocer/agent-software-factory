/**
 * Agent registry.
 *
 * The keys are the registration names used by `mastra.getAgent(...)` and shown in Studio.
 */
export { pmArchitectAgent } from './pm-architect.agent.ts';
export { developerAgent } from './developer.agent.ts';
export { qaTesterAgent } from './qa-tester.agent.ts';
export { triageAgent } from './triage.agent.ts';
export { securityAgent } from './security.agent.ts';
export { reviewerAgent } from './reviewer.agent.ts';
export { documentationAgent } from './documentation.agent.ts';
export { feedbackTriageAgent } from './feedback-triage.agent.ts';
export { mergeSummaryAgent } from './merge-summary.agent.ts';
export { prWriterAgent } from './pr-writer.agent.ts';
export { runNamerAgent } from './run-namer.agent.ts';
export { phaseReconcilerAgent } from './phase-reconciler.agent.ts';

import { pmArchitectAgent } from './pm-architect.agent.ts';
import { developerAgent } from './developer.agent.ts';
import { qaTesterAgent } from './qa-tester.agent.ts';
import { triageAgent } from './triage.agent.ts';
import { securityAgent } from './security.agent.ts';
import { reviewerAgent } from './reviewer.agent.ts';
import { documentationAgent } from './documentation.agent.ts';
import { feedbackTriageAgent } from './feedback-triage.agent.ts';
import { mergeSummaryAgent } from './merge-summary.agent.ts';
import { prWriterAgent } from './pr-writer.agent.ts';
import { runNamerAgent } from './run-namer.agent.ts';
import { phaseReconcilerAgent } from './phase-reconciler.agent.ts';

export const factoryAgents = {
  pmArchitectAgent,
  developerAgent,
  qaTesterAgent,
  triageAgent,
  securityAgent,
  reviewerAgent,
  documentationAgent,
  feedbackTriageAgent,
  mergeSummaryAgent,
  prWriterAgent,
  runNamerAgent,
  phaseReconcilerAgent,
};
