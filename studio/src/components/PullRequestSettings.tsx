import type { PrWatchSettings, PrWatchSettingsBundle, RepoPrWatchOverrides } from '../../shared/types';

/**
 * The pull-request part of the Settings screen: whether and how often GitHub is checked, what
 * happens by itself when review comments arrive, and - per repository - where that differs.
 *
 * Controlled: the parent owns the value and decides when it is saved.
 */

const INTERVAL_CHOICES: Array<{ seconds: number; label: string }> = [
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
];

type AutomaticStep = 'autoTriage' | 'autoRevise' | 'replyOnGitHub';

/** The three automatic steps: what each one is, what it costs, and the short name used in the table. */
const STEPS: Array<{ key: AutomaticStep; column: string; title: string; hint: string }> = [
  {
    key: 'autoTriage',
    column: 'Read comments',
    title: 'Read new comments as soon as they arrive',
    hint: 'One agent call classifies them. It changes nothing, on your machine or on GitHub.',
  },
  {
    key: 'autoRevise',
    column: 'Start rounds',
    title: 'Start a new round when the comments ask for code changes',
    hint: 'Re-runs developer, QA, review... on the same task and branch. Uses tokens, and still stops to ask before anything is pushed.',
  },
  {
    key: 'replyOnGitHub',
    column: 'Reply on GitHub',
    title: 'Reply to reviewers on GitHub',
    hint: 'Visible to everyone, and labelled as written by the AI software factory (the replies go out through your GitHub account). Off by default.',
  },
];

type Choice = 'default' | 'on' | 'off';

const choiceOf = (overrides: RepoPrWatchOverrides | undefined, key: AutomaticStep): Choice => {
  const value = overrides?.[key];
  return value === undefined ? 'default' : value ? 'on' : 'off';
};

const inputClass =
  'px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50';

function Toggle({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-slate-300 dark:border-slate-600"
      />
      <span className="flex-1">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300 block">{title}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{hint}</span>
      </span>
    </label>
  );
}

interface PullRequestSettingsProps {
  value: PrWatchSettingsBundle;
  /** Repositories to configure individually (the ones in the sidebar). */
  repos: Array<{ name: string }>;
  onChange: (next: PrWatchSettingsBundle) => void;
}

export function PullRequestSettings({ value, repos, onChange }: PullRequestSettingsProps) {
  const { defaults } = value;

  const setDefaults = (patch: Partial<PrWatchSettings>) =>
    onChange({ ...value, defaults: { ...defaults, ...patch } });

  /** Changes one step of one repository; a repository that overrides nothing is dropped. */
  const setOverride = (repo: string, key: AutomaticStep, choice: Choice) => {
    const next: RepoPrWatchOverrides = { ...(value.repos[repo] ?? {}) };
    if (choice === 'default') delete next[key];
    else next[key] = choice === 'on';

    const repoOverrides = { ...value.repos };
    if (Object.keys(next).length === 0) delete repoOverrides[repo];
    else repoOverrides[repo] = next;
    onChange({ ...value, repos: repoOverrides });
  };

  return (
    <section aria-label="Pull request settings" data-testid="pr-settings" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Pull requests</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          What happens when someone leaves review comments on a pull request the factory opened.
        </p>
      </div>

      <Toggle
        checked={defaults.enabled}
        onChange={(enabled) => setDefaults({ enabled })}
        title="Look for review comments automatically"
        hint="Checks GitHub in the background and right after a run opens a pull request. Reading GitHub never uses AI tokens."
      />

      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
        Check every
        <select
          aria-label="Check interval"
          value={defaults.intervalSeconds}
          onChange={(e) => setDefaults({ intervalSeconds: Number(e.target.value) })}
          disabled={!defaults.enabled}
          className={inputClass}
        >
          {INTERVAL_CHOICES.map((choice) => (
            <option key={choice.seconds} value={choice.seconds}>
              {choice.label}
            </option>
          ))}
          {!INTERVAL_CHOICES.some((choice) => choice.seconds === defaults.intervalSeconds) && (
            <option value={defaults.intervalSeconds}>{defaults.intervalSeconds} seconds</option>
          )}
        </select>
      </label>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Default for every repository
        </h4>
        {STEPS.map((step) => (
          <Toggle
            key={step.key}
            checked={defaults[step.key]}
            onChange={(checked) => setDefaults({ [step.key]: checked })}
            title={step.title}
            hint={step.hint}
          />
        ))}
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Per repository
        </h4>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Choose a different behaviour for one repository. <em>Default</em> follows the setting above, so a
          change there still reaches it.
        </p>

        {repos.length === 0 ? (
          <p className="text-xs italic text-slate-500 dark:text-slate-400">Add a repository to configure it here.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm" data-testid="repo-overrides">
              <thead className="bg-slate-50 dark:bg-slate-900/40 text-xs text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Repository</th>
                  {STEPS.map((step) => (
                    <th key={step.key} className="text-left font-medium px-3 py-2" title={step.title}>
                      {step.column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                {repos.map((repo) => (
                  <tr key={repo.name}>
                    <td className="px-3 py-2 font-mono text-slate-800 dark:text-slate-200">{repo.name}</td>
                    {STEPS.map((step) => (
                      <td key={step.key} className="px-3 py-2">
                        <select
                          aria-label={`${repo.name}: ${step.column.toLowerCase()}`}
                          value={choiceOf(value.repos[repo.name], step.key)}
                          onChange={(e) => setOverride(repo.name, step.key, e.target.value as Choice)}
                          className={inputClass}
                        >
                          <option value="default">Default ({defaults[step.key] ? 'on' : 'off'})</option>
                          <option value="on">On</option>
                          <option value="off">Off</option>
                        </select>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
