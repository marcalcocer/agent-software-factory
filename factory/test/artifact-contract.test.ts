import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RUN, artifactFiles, readJson } from '../../fixtures';
import {
  deliveryReportSchema,
  developerReportSchema,
  documentationReportSchema,
  executionPlanSchema,
  feedbackTriageReportSchema,
  mergeSummarySchema,
  prTextSchema,
  qaReportSchema,
  reviewReportSchema,
  securityReportSchema,
  triageReportSchema,
} from '../src/utils/schemas.ts';

/**
 * What each artifact holds, and the schema that describes it today.
 *
 * Old runs are read again long after they were written: a further round reuses the plan of the
 * run it continues, the Studio opens finished runs, triage compares attempts. If a schema changes
 * so that what was written yesterday no longer parses, this is where it shows.
 */
const CONTRACTS: Array<{ prefix: string; schema: z.ZodType; pick: (data: any) => unknown }> = [
  { prefix: '01-pm-architect', schema: executionPlanSchema, pick: (data) => data.plan },
  { prefix: '02-developer', schema: developerReportSchema, pick: (data) => data },
  { prefix: '03-qa-tester', schema: qaReportSchema, pick: (data) => data },
  { prefix: '04-triage', schema: triageReportSchema, pick: (data) => data.report },
  { prefix: '05-code-review', schema: reviewReportSchema, pick: (data) => data },
  { prefix: '06-security', schema: securityReportSchema, pick: (data) => data },
  { prefix: '07-documentation', schema: documentationReportSchema, pick: (data) => data },
  { prefix: '07-pr-writer', schema: prTextSchema, pick: (data) => data },
  { prefix: '08-pull-request', schema: deliveryReportSchema, pick: (data) => data.delivery },
  { prefix: '10-feedback-triage', schema: feedbackTriageReportSchema, pick: (data) => data },
  {
    prefix: '11-feedback-delivery',
    schema: z.object({ repliesPosted: z.number().int(), postReplies: z.boolean(), items: z.number().int() }),
    pick: (data) => data,
  },
  { prefix: '12-merge-summary', schema: mergeSummarySchema, pick: (data) => data.message },
];

const REAL_RUNS = [RUN.round1, RUN.round2, RUN.prTriage, RUN.mergeSummary];

describe('the artifacts of real runs still satisfy the schemas of today', () => {
  const cases = REAL_RUNS.flatMap((runId) =>
    artifactFiles(runId).map((file) => ({ runId, file, contract: CONTRACTS.find((entry) => file.startsWith(entry.prefix)) })),
  );

  it('covers every artifact the real runs wrote', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(cases.filter((entry) => !entry.contract).map((entry) => `${entry.runId}/${entry.file}`)).toEqual([]);
  });

  it.each(cases.map((entry) => [`${entry.runId} / ${entry.file}`, entry] as const))('%s', (_name, entry) => {
    const artifact = readJson(entry.runId, entry.file);
    const result = entry.contract!.schema.safeParse(entry.contract!.pick(artifact.data));

    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });
});

describe('the plan a further round reuses', () => {
  it('is the plan of the first round, whole', () => {
    const reused = readJson(RUN.round2, '01-pm-architect.json');
    const original = readJson(RUN.round1, '01-pm-architect.json');

    expect(reused.status).toBe('REUSED');
    expect(reused.data.reusedFrom).toBe(RUN.round1);
    expect(reused.data.plan).toEqual(original.data.plan);
  });
});
