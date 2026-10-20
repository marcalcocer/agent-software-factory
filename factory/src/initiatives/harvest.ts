/**
 * What a finished run leaves for later: the findings nobody fixed, and the follow-ups the agents named.
 *
 * Until now these ended in a JSON artifact nobody opens: a real run found a pre-existing XSS in the chart
 * tooltip and a rule the code did not follow, said so, and both were forgotten once the pull request
 * merged. They go to the initiative's backlog instead, where the next phase's architect reads them and
 * the user can promote one to a phase or set it aside.
 *
 * Pure: the polish result and the reports in, plain items out.
 */
import type { PolishResult } from '../utils/schemas.ts';

export interface BacklogCandidate {
  source: string;
  text: string;
  severity: string;
  evidence: string;
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The polish pass answers the developer's follow-ups by finding id (`REV-2: Not applied - ...`): those are the findings, not new ones. */
const ANSWERS_A_FINDING = /^\s*[A-Z]{2,4}-\d+\b/;

export function backlogFromRun(input: {
  polish: PolishResult | null;
  developerFollowUps?: string[];
  documentationFollowUps?: string[];
}): BacklogCandidate[] {
  const items: BacklogCandidate[] = [];

  const polish = input.polish;
  if (polish) {
    const fixed = new Set(polish.status === 'APPLIED' ? polish.applied : []);
    const reasonOf = new Map(polish.declined.map((entry) => [entry.id, entry.reason]));
    for (const candidate of polish.candidates) {
      if (fixed.has(candidate.id)) continue;
      const where = candidate.file ? `${candidate.file}${candidate.line ? `:${candidate.line}` : ''}: ` : '';
      const why = reasonOf.get(candidate.id);
      items.push({
        source: candidate.source,
        text: `${where}${flat(candidate.problem)}`,
        severity: candidate.severity,
        evidence: flat([candidate.fix ? `Suggested: ${candidate.fix}` : '', why ? `Not fixed: ${why}` : ''].filter(Boolean).join(' ')),
      });
    }
    // Nits are taste, not debt.
    for (const item of polish.reported) {
      if (item.reason === 'a nit') continue;
      items.push({ source: item.source, text: flat(item.summary), severity: 'INFO', evidence: item.reason });
    }
  }

  for (const followUp of input.developerFollowUps ?? []) {
    if (!ANSWERS_A_FINDING.test(followUp)) items.push({ source: 'developer', text: flat(followUp), severity: 'MINOR', evidence: '' });
  }
  for (const followUp of input.documentationFollowUps ?? []) {
    items.push({ source: 'documentation', text: flat(followUp), severity: 'MINOR', evidence: '' });
  }
  return items.filter((item) => item.text !== '');
}
