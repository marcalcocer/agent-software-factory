/**
 * Mastra entry point.
 *
 * The configuration (agents, workflow, storage, logger, telemetry) lives in the project-root
 * `mastra.config.ts`; this file instantiates it. It is the file the Mastra CLI analyses, so
 * the instance is declared here explicitly as `export const mastra = new Mastra(...)`.
 */
import { Mastra } from '@mastra/core/mastra';

import { factoryMastraConfig } from '../../mastra.config.ts';

export const mastra = new Mastra(factoryMastraConfig);

export { logger, observability, storage } from '../../mastra.config.ts';
export default mastra;
