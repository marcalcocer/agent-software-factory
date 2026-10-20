import { useState } from 'react';
import type { PipelineConfig } from '../../shared/types';

interface PipelineSelectorProps {
  value: PipelineConfig;
  onChange: (config: PipelineConfig) => void;
}

interface StageInfo {
  id: keyof PipelineConfig;
  label: string;
  description: string;
  warningWhenDisabled: string;
  /** Another stage this one cannot work without: it is switched off, and says why, while that one is off. */
  requires?: { id: keyof PipelineConfig; because: string };
}

/** Stages from before a stage existed have no entry for it: absent means on. */
const isOn = (config: PipelineConfig, id: keyof PipelineConfig): boolean => config[id] !== false;

const OPTIONAL_STAGES: StageInfo[] = [
  {
    id: 'qa',
    label: 'QA Testing',
    description: 'Run the test suite and validate the change',
    warningWhenDisabled: 'No test evidence will be collected',
  },
  {
    id: 'review',
    label: 'Code Review',
    description: 'Automated code review for quality and conventions',
    warningWhenDisabled: 'Code will not be reviewed for quality issues',
  },
  {
    id: 'security',
    label: 'Security Audit',
    description: 'Scan for vulnerabilities and security issues',
    warningWhenDisabled: 'Security risks will not be detected',
  },
  {
    id: 'documentation',
    label: 'Documentation',
    description: 'Update the README, changelog and docs when the change makes them stale',
    warningWhenDisabled: 'Documentation will not be checked or updated (the pull-request text is still written)',
  },
  {
    id: 'polish',
    label: 'Polish',
    description: 'Fix the minor findings of QA, the review and the security audit in one pass, checked by the tests and the build',
    warningWhenDisabled: 'Minor findings will only be listed in the pull request, not fixed',
    requires: { id: 'qa', because: 'Needs QA Testing, which checks the fixes' },
  },
];

const MANDATORY_STAGES = [
  { label: 'Prepare', description: 'Repository setup and validation' },
  { label: 'PM Architect', description: 'Task planning and architecture' },
  { label: 'Developer', description: 'Code implementation' },
  { label: 'PR Writer', description: 'Commit message, pull-request title and description' },
  { label: 'Delivery', description: 'Commit and create pull request' },
];

export function PipelineSelector({ value, onChange }: PipelineSelectorProps) {
  const [expanded, setExpanded] = useState(false);

  const handleToggle = (stageId: keyof PipelineConfig) => {
    onChange({ ...value, [stageId]: !isOn(value, stageId) });
  };

  /** On, and not held back by a stage it needs. */
  const runs = (stage: StageInfo): boolean => isOn(value, stage.id) && (!stage.requires || isOn(value, stage.requires.id));
  const skippedStages = OPTIONAL_STAGES.filter((stage) => !runs(stage));
  const allEnabled = skippedStages.length === 0;

  return (
    <div className="border border-slate-300 dark:border-slate-600 rounded-md overflow-hidden">
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Pipeline</span>
          {!allEnabled && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {skippedStages.length} stage{skippedStages.length === 1 ? '' : 's'} disabled
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {allEnabled ? 'All stages enabled' : 'Click to configure'}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="p-4 space-y-4 bg-white dark:bg-slate-900">
          {/* Mandatory stages */}
          <div>
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wide">
              Mandatory Stages
            </h4>
            <div className="space-y-2">
              {MANDATORY_STAGES.map((stage) => (
                <div
                  key={stage.label}
                  className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400"
                >
                  <svg className="w-4 h-4 text-slate-400" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <div>
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {stage.label}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {stage.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Optional stages */}
          <div>
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wide">
              Optional Stages
            </h4>
            <div className="space-y-2">
              {OPTIONAL_STAGES.map((stage) => {
                const enabled = runs(stage);
                const held = Boolean(stage.requires) && !isOn(value, stage.requires!.id);
                return (
                  <label
                    key={stage.id}
                    className={`flex items-start gap-3 p-2 rounded-md transition-colors ${
                      held ? 'opacity-70' : 'hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={held}
                      onChange={() => handleToggle(stage.id)}
                      className="mt-1 w-4 h-4 text-blue-600 border-slate-300 dark:border-slate-600 rounded focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="flex-1">
                      <div className="font-medium text-slate-900 dark:text-slate-100 text-sm">
                        {stage.label}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {stage.description}
                      </div>
                      {!enabled && (
                        <div className="flex items-center gap-1 mt-1 text-xs text-amber-600 dark:text-amber-400">
                          {held ? <span className="font-medium">{stage.requires!.because}.&nbsp;</span> : null}
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                              clipRule="evenodd"
                            />
                          </svg>
                          {stage.warningWhenDisabled}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Summary of disabled stages */}
          {skippedStages.length > 0 && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md">
              <div className="flex items-start gap-2">
                <svg
                  className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="text-xs">
                  <div className="font-medium text-amber-900 dark:text-amber-200 mb-1">
                    {skippedStages.length} stage{skippedStages.length === 1 ? '' : 's'} will be
                    skipped:
                  </div>
                  <ul className="space-y-0.5 text-amber-800 dark:text-amber-300">
                    {skippedStages.map((stage) => (
                      <li key={stage.id}>• {stage.warningWhenDisabled}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
