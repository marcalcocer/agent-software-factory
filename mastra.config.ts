/**
 * Mastra configuration for the agent software factory.
 *
 * Wires together:
 *   - the 7 agents and the end-to-end workflow,
 *   - LibSQL storage (workflow snapshots for suspend/resume, observability persistence),
 *   - the Pino logger with a file transport targeting `./logs/`,
 *   - OpenTelemetry-compatible tracing (always on through the Mastra storage exporter, plus
 *     an OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set).
 *
 * The instance itself is created in `src/mastra/index.ts` (the conventional entry point the
 * Mastra CLI analyses for `mastra dev` / `mastra build`), which consumes `factoryMastraConfig`
 * exported from this file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { FileTransport } from '@mastra/loggers/file';
import { MastraStorageExporter, Observability, SamplingStrategyType } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import type { ObservabilityExporter } from '@mastra/core/observability';

import { factoryAgents } from './src/agents/index.ts';
import { getFactoryConfig, PROJECT_ROOT } from './src/utils/factory-config.ts';
import { factoryWorkflows } from './src/workflows/software-factory.workflow.ts';

const config = getFactoryConfig();

/* -------------------------------------------------------------------------- */
/* Storage: workflow snapshots (suspend/resume) + observability persistence    */
/* -------------------------------------------------------------------------- */

fs.mkdirSync(config.logDir, { recursive: true });

/** `file:` URLs are resolved against the project root so the CLI and the server agree. */
function resolveStorageUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const filePath = url.slice('file:'.length);
  return `file:${path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath)}`;
}

export const storage = new LibSQLStore({
  id: 'factory-storage',
  url: resolveStorageUrl(config.storageUrl),
});

/* -------------------------------------------------------------------------- */
/* Logging: console + rotating-per-run file trace                              */
/* -------------------------------------------------------------------------- */

/** `FileTransport` requires an existing file, so the log file is created up front. */
const logFilePath = path.join(config.logDir, 'factory.log');
if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, '', 'utf8');

export const logger = new PinoLogger({
  name: 'agent-software-factory',
  level: config.logLevel,
  transports: {
    file: new FileTransport({ path: logFilePath }),
  },
});

/* -------------------------------------------------------------------------- */
/* Observability: tracing, logs and derived metrics                            */
/* -------------------------------------------------------------------------- */

const exporters: ObservabilityExporter[] = [
  // Persists spans/logs into LibSQL so Studio and `mastra api trace list` can read them.
  new MastraStorageExporter(),
];

if (config.otlpEndpoint) {
  exporters.push(
    new OtelExporter({
      provider: {
        custom: {
          endpoint: config.otlpEndpoint,
          protocol: 'http/protobuf',
          ...(process.env.OTEL_EXPORTER_OTLP_HEADERS
            ? {
                headers: Object.fromEntries(
                  process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',')
                    .map((pair) => pair.split('=').map((part) => part.trim()))
                    .filter((pair): pair is [string, string] => pair.length === 2),
                ),
              }
            : {}),
        },
      },
    }),
  );
}

export const observability = new Observability({
  configs: {
    default: {
      serviceName: config.serviceName,
      sampling: { type: SamplingStrategyType.ALWAYS },
      includeInternalSpans: true,
      exporters,
      logging: { enabled: true, level: config.logLevel },
    },
  },
});

/* -------------------------------------------------------------------------- */
/* The composed configuration                                                  */
/* -------------------------------------------------------------------------- */

export const factoryMastraConfig = {
  agents: factoryAgents,
  workflows: factoryWorkflows,
  storage,
  logger,
  observability,
};

export default factoryMastraConfig;
