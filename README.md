# agent-software-factory

An asynchronous, multi-agent **software factory** built on [Mastra](https://mastra.ai)
(`@mastra/core`) and TypeScript. Give it a requirement and a repository inside your workspace,
and seven specialised agents plan it, implement it, test it, triage the failures, review it,
audit its security, document it and open a **draft pull request**.

```
npm run factory -- run --repo invest-track --task "Add pagination to GET /api/positions"
```

Everything runs locally on open-source infrastructure. The only paid component is the LLM API
usage, and the whole graph can be exercised with **zero cost** via `npm run smoke`.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Architecture](#architecture)
- [The agents](#the-agents)
- [LLM resiliency: model fallback chains](#llm-resiliency-model-fallback-chains)
- [Cascading conventions](#cascading-conventions)
- [Observability and traceability](#observability-and-traceability)
- [Safety model](#safety-model)
- [Installation](#installation)
- [Usage](#usage)
- [Verifying without spending tokens](#verifying-without-spending-tokens)
- [Project layout](#project-layout)
- [Configuration reference](#configuration-reference)
- [Extending the factory](#extending-the-factory)
- [Troubleshooting](#troubleshooting)

---

## Why this exists

Most "AI developer" setups fail for the same three reasons. This factory is designed around
those failure modes:

| Failure mode | What this factory does |
| --- | --- |
| **Blind retry loops** burn budget and converge on nothing | A dedicated **Triage agent** performs root-cause analysis, compares the current attempt with previous ones (it reads the run artifacts), detects loops and oscillation, and routes: `RETRY_DEVELOPER`, `RE-RUN_INFRA`, `ESCALATE_HUMAN` or `APPROVE_AND_CONTINUE`. Deterministic guardrails override the model when it tries to approve a failing gate. |
| **Green builds obtained by deleting tests** | Weakened verification (deleted / skipped / disabled / loosened tests) is a blocking defect in the global rules, the QA agent reports it explicitly in `weakenedVerification`, the reviewer treats it as a `BLOCKER`, and triage is forbidden from recommending it. |
| **No evidence of what happened** | Every run writes a trace directory with one numbered JSON artifact per agent step, an append-only event log, packed context blocks, the diff, the raw suite output and a `summary.json` with tokens, duration, tool calls and the model that actually served each call. |

---

## Architecture

```
                         ┌──────────────────────┐
  CLI / Studio ─────────▶│    prepare-run       │  resolve repo, detect stack,
                         │                      │  create work branch, open trace dir
                         └──────────┬───────────┘
                                    ▼
                         ┌──────────────────────┐
                         │ 01 pm-architect      │──ambiguous?──▶ suspend (clarification)
                         │    executionPlan     │◀──resume with answers──┘
                         └──────────┬───────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  implementation-cycle          .dountil(cycleComplete || escalate)         │
   │                                                                            │
   │   ┌──────────────────┐      ┌──────────────────┐                           │
   │   │ 02 developer     │─────▶│ 03 qa-tester     │                           │
   │   │ code + tests     │      │ build/test/E2E   │                           │
   │   └──────────────────┘      └────────┬─────────┘                           │
   │            ▲                         │                                     │
   │            │                   QA passed?                                  │
   │            │            ┌────────────┴────────────┐                        │
   │            │          NO│                         │YES                     │
   │            │            ▼                         ▼                        │
   │            │   ┌──────────────────┐   ┌────────────────────────────────┐    │
   │            │   │ 04 triage-qa     │   │ verification-phase (parallel)  │    │
   │            │   │ root cause +     │   │  05 code-review  06 security   │    │
   │            │   │ routing decision │   └──────────────┬─────────────────┘    │
   │            │   └────────┬─────────┘        approved? │                      │
   │            │            │                  ┌─────────┴─────────┐            │
   │            │  RETRY_DEVELOPER /           NO│                   │YES         │
   │            └──RE-RUN_INFRA ────────┐        ▼                   ▼            │
   │                                    │ ┌──────────────────┐  ┌──────────────┐ │
   │                      ESCALATE_HUMAN│ │ 04 triage-verif. │  │ mark-complete│ │
   │                                    │ └────────┬─────────┘  └──────────────┘ │
   │                                    │          └──── loop ────────▲          │
   └────────────────────────────────────┼─────────────────────────────┼──────────┘
                                        │                            │
                       ┌────────────────▼─────────┐     ┌────────────┴──────────┐
                       │ escalation-phase         │     │ delivery-phase        │
                       │ suspend + 09-escalation  │     │ 07 documentation      │
                       │ (human in the loop)      │     │ 08 commit/push/draft  │
                       └────────────────┬─────────┘     └────────────┬──────────┘
                                        └───────────┬────────────────┘
                                                    ▼
                                         ┌──────────────────────┐
                                         │ finalize             │
                                         │ summary.json         │
                                         └──────────────────────┘
```

Implemented with Mastra primitives: `createStep`, `createWorkflow`, `.then()`, `.parallel()`,
`.branch()`, `.dountil()`, nested workflows as steps, and `suspend()` / `resume()` for
human-in-the-loop pauses (persisted in LibSQL, so a run can be resumed from another process
or days later).

---

## The agents

Each agent loads its system prompt from `src/prompts/<role>.md`, receives the
[convention cascade](#cascading-conventions) dynamically, and is granted only the tools its
role justifies.

| # | Agent | Model tier (primary → fallback) | Responsibility | Write access |
| --- | --- | --- | --- | --- |
| 01 | **pm-architect** | Sonnet-class → GPT-4o | Parses the task, scans the codebase, loads global rules + `AGENTS.md`, produces `executionPlan` (tasks, acceptance criteria, test strategy, risks). Triggers a clarification state when the requirement is blocking-ambiguous. | none |
| 02 | **developer** | Sonnet-class → GPT-4o | Implements production code **and** tests in the target repository. Preserves context across fix iterations and must report how each triage hint was applied. | code + tests |
| 03 | **qa-tester** | Haiku-class → GPT-4o-mini | Runs build/test commands (`mvn test`, `npm test`, `pytest`, …), validates acceptance criteria with local HTTP probes, classifies every failure and emits structured bug reports. | none |
| 04 | **triage** | Sonnet-class → GPT-4o | *Director/Evaluator.* Determines root cause, detects loops by comparing run artifacts across attempts, and routes the workflow. | none |
| 05 | **reviewer** | Sonnet-class → GPT-4o-mini | Reviews the `git diff` against the convention cascade, architecture, maintainability and test honesty. Severity-calibrated findings. | none |
| 06 | **security** | Sonnet-class → GPT-4o | OWASP Top 10 audit of the diff: injection, secrets, access control, misconfiguration, dependency/supply-chain risk. | none |
| 07 | **documentation** | Haiku-class → GPT-4o-mini | Updates `CHANGELOG.md`, `docs/**`, OpenAPI specs and writes the pull-request description. | documentation files only |

The developer is the only agent that can modify source code; the documentation agent's write
tools reject anything that is not a documentation file; everybody else is read-only. No agent
can commit, push or open a pull request — delivery is a separate, configuration-gated step.

---

## LLM resiliency: model fallback chains

Models are declared as a **native Mastra fallback chain**, so a 429 / 5xx / timeout on the
primary provider transparently fails over to the next one, with its own retry budget:

```ts
// src/utils/model-router.ts (excerpt)
model: [
  { model: 'anthropic/claude-sonnet-4-6', maxRetries: 3 },  // primary
  { model: 'openai/gpt-4o',               maxRetries: 2 },  // fallback
]
```

- Roles are mapped to **capability tiers** (`reasoning` / `fast`), not to hardcoded model ids,
  so upgrading a generation is a one-line change.
- `FACTORY_MODEL_GENERATION=legacy` switches the whole factory to the models of the original
  specification (`anthropic/claude-3.7-sonnet`, `anthropic/claude-3.5-haiku`, GPT-4o
  fallbacks). The default is `current`.
- Any role can be overridden with a comma-separated chain, e.g.
  `FACTORY_MODEL_DEVELOPER="anthropic/claude-opus-4-5,openai/gpt-5.1,google/gemini-2.5-pro"`.
- `FACTORY_ENABLE_GOOGLE_FALLBACK=true` appends Gemini as a last resort to every chain.
- `summary.json` records, per role, the **requested** model and the model that **actually
  served** each call, plus a `failovers` counter — so provider degradation is visible after the
  fact.

Check the active routing and credentials at any time:

```bash
npm run factory -- doctor
```

---

## Cascading conventions

Rules are resolved per run, lowest precedence first:

1. **Agent prompt** — `src/prompts/<role>.md` (role, method, output contract).
2. **Global rules** — every `global-rules/*.md` (ships with `java-conventions.md` and
   `testing-conventions.md`).
3. **Project rules** — `AGENTS.md` in the target repository (also `docs/AGENTS.md` or
   `.github/AGENTS.md`). **Always wins on conflict.**

`src/utils/context-loader.ts` composes them into a `CONVENTIONS` block injected as dynamic
`instructions`, so the same agent instance adapts to whichever repository the current run
targets. Reviewers must cite the rule *and* its source (`GLOBAL_RULES`, `PROJECT_AGENTS_MD`,
`LANGUAGE_IDIOM`) in every convention finding.

To add factory-wide standards, drop a new Markdown file into `global-rules/`. To override them
for one repository, add an `AGENTS.md` to that repository.

---

## Observability and traceability

Each execution owns `logs/<runId>/`:

```
logs/20251008-234512-invest-track-a1b2/
├── run.json                      # task, repository, branch, model routing, dry-run flag
├── events.ndjson                 # append-only: agent calls, tokens, tool calls, suite runs,
│                                 # triage guardrails, suspensions, escalations
├── 01-pm-architect.json          # executionPlan + clarifications used
├── 02-developer.json             # developer report (attempt 1)
├── 03-qa-tester.json             # QA verdict, failures, bug reports
├── 04-triage.json                # model decision, effective decision, guardrail overrides
├── 02-developer.attempt-2.json   # second iteration (…and so on per attempt)
├── 03-qa-tester.attempt-2.json
├── 05-code-review.json
├── 06-security.json
├── 07-documentation.json
├── 08-pull-request.json          # commit sha, push result, PR url, pending manual actions
├── 09-escalation.json            # only when a human is required
├── context/                      # packed repository context, diffs, raw suite logs
│   ├── qa-suite-attempt-1.log
│   ├── diff-attempt-1.patch
│   └── pack-*.md
└── summary.json                  # tokens, duration, attempts, tool calls, models used,
                                  # per-step timings, gate verdicts, attempt history
```

Also configured in `mastra.config.ts`:

- **`PinoLogger`** with a `FileTransport` targeting `logs/factory.log`, trace-correlated
  (`trace_id` / `span_id` injected into every record).
- **Mastra Observability** (OpenTelemetry-compatible) with `sampling: ALWAYS`, internal spans
  included, and `MastraStorageExporter` persisting spans to LibSQL — readable in Studio or via
  `npx mastra api trace list`.
- **OTLP export**: set `OTEL_EXPORTER_OTLP_ENDPOINT` (and optionally
  `OTEL_EXPORTER_OTLP_HEADERS`) to ship traces to Jaeger, Tempo, Honeycomb, Langfuse, …
- **LibSQL storage** (`logs/factory.db`) holding workflow snapshots, which is what makes
  `suspend`/`resume` work across processes.

Inspect runs from the CLI:

```bash
npm run factory -- list                  # recent runs with status, attempts, tokens
npm run factory -- show --run-id <runId>  # print summary.json
npm run dev                               # Mastra Studio: visual graph, traces, replay
```

---

## Safety model

The factory manipulates real repositories, so the boundaries are enforced in code, not in
prompts:

- **Workspace jail** — every path is resolved through `resolveRepoPath` /
  `resolveInsideRepo`: traversal outside the target repository is rejected, and so is any
  repository outside `FACTORY_WORKSPACE_ROOT` (unless `FACTORY_ALLOW_ANY_PATH=true`). Direct
  access to `.git` is blocked.
- **No shell** — commands run with `shell: false` through an allow-list of executables.
  Shell metacharacters (`;`, `&&`, `|`, `>`, backticks, `$(`) are rejected, so command chaining
  and injection are impossible. Extend the allow-list with
  `FACTORY_EXTRA_ALLOWED_COMMANDS`.
- **Bounded execution** — per-command timeouts (`FACTORY_COMMAND_TIMEOUT_MS`), truncated
  output capture (head+tail, so failures at the end are never lost).
- **Clean baseline** — a run refuses to start if the target working tree is dirty, which
  guarantees the produced diff contains only the factory's work.
- **Gated delivery** — commit, push and PR creation happen in one dedicated step and are
  controlled by `autoCommit` / `createPullRequest` per run and by `FACTORY_ALLOW_PUSH` /
  `FACTORY_ALLOW_PR` globally. Pull requests are always **drafts**.
- **Local-only probes** — the E2E HTTP tool refuses any host that is not `localhost`.
- **Integrity guardrails** — triage cannot approve a change while a quality or security gate
  is failing, cannot retry after a detected loop, and cannot exceed the attempt budget; all
  overrides are recorded in `04-triage.json` and `events.ndjson`.

---

## Installation

Requirements: **Node.js ≥ 20.11**, `git`, and (optionally) the
[GitHub CLI](https://cli.github.com/) `gh` authenticated for draft pull requests.

```bash
cd ~/workspace/agent-software-factory
npm install
cp .env.example .env         # then add ANTHROPIC_API_KEY and/or OPENAI_API_KEY
npm run factory -- doctor    # verify configuration, credentials and tooling
```

Target repositories live in `~/workspace/` (configurable via `FACTORY_WORKSPACE_ROOT`).

---

## Usage

### Run a task

```bash
# Repository referenced by folder name inside the workspace root
npm run factory -- run \
  --repo invest-track \
  --task "Add cursor pagination to GET /api/positions, with tests and OpenAPI update"

# Full control
npm run factory -- run \
  --repo ~/workspace/home-auth \
  --task "Fix the token refresh race condition on concurrent requests" \
  --base-branch main \
  --branch fix/token-refresh-race \
  --max-attempts 4 \
  --test-command "./mvnw -B verify" \
  --criteria "Concurrent refresh yields a single new token; existing tests pass" \
  --no-pr
```

Exit codes: `0` delivered, `1` failed or escalated, `2` bad usage/configuration,
`3` suspended waiting for a human.

### Resume a suspended run

The architect asked a question:

```bash
npm run factory -- resume --run-id 20251008-234512-invest-track-a1b2 \
  --clarifications "Use cursor pagination with an opaque base64 cursor; page size max 100."
```

The triage agent escalated:

```bash
npm run factory -- resume --run-id 20251008-234512-invest-track-a1b2 \
  --decision ACKNOWLEDGE --guidance "The API contract is authoritative; adapt the test."
# or
npm run factory -- resume --run-id 20251008-234512-invest-track-a1b2 --decision ABORT
```

The exact command is always printed when the run suspends and stored in `09-escalation.json`.

### Studio (visual graph, traces, time travel)

```bash
npm run dev     # mastra dev -> http://localhost:4111
```

### CI mode

```bash
FACTORY_NON_INTERACTIVE=true npm run factory -- run --repo my-service --task "..." --no-pr
```

Escalations are then recorded and the run ends (exit code `1`) instead of waiting for input.

---

## Verifying without spending tokens

`npm run smoke` executes the **entire workflow** eight times with stubbed LLM responses
(`FACTORY_DRY_RUN=true`), asserting routing, loops, suspension, artifacts and metrics.
No API key, no network, no repository mutation:

```bash
npm run smoke          # all scenarios
npm run smoke -- --scenario retry
npm run check          # tsc --noEmit + smoke
```

| Scenario | What it proves |
| --- | --- |
| `happy` | plan → develop → QA pass → review + security approve → docs → delivery, 1 attempt |
| `retry` | QA fails → triage `RETRY_DEVELOPER` → attempt 2 green (hints threaded into the prompt) |
| `infra` | QA fails on environment → triage `RE-RUN_INFRA` → developer step skipped, suite re-run |
| `review-changes` | QA green but reviewer requests changes → triage → fixed on attempt 2 |
| `security-block` | security audit blocks → triage → fixed on attempt 2 |
| `escalate` | identical failure twice → loop detected → `suspend()` → resume → `ESCALATED_TO_HUMAN` |
| `escalate` (CI) | same failure with `--non-interactive` → escalation recorded, no suspension |
| `clarify` | blocking ambiguity → `suspend()` → resume with answers → delivery |

You can also point the real factory at a scratch repository with `--dry-run` to validate the
repository resolution, stack detection and branch strategy before spending a token.

---

## Project layout

```
agent-software-factory/
├── global-rules/                       # factory-wide standards (precedence 2)
│   ├── java-conventions.md
│   └── testing-conventions.md
├── src/
│   ├── prompts/                        # system prompt per agent (precedence 1)
│   │   ├── pm-architect.md  developer.md  qa-tester.md  triage.md
│   │   └── security.md  documentation.md  reviewer.md
│   ├── tools/
│   │   ├── git-tools.ts                # status/diff/log + branch/commit/push/draft PR
│   │   ├── test-runner-tools.ts        # stack detection, command runner, suite parsing, HTTP probe
│   │   ├── repomix-tools.ts            # tree, search, token-budgeted context packing
│   │   ├── filesystem-tools.ts         # read/list + write/edit (code vs documentation scoped)
│   │   └── logger-tools.ts             # trace dirs, artifacts, events, metric aggregation
│   ├── agents/
│   │   ├── pm-architect.agent.ts  developer.agent.ts  qa-tester.agent.ts
│   │   ├── triage.agent.ts  security.agent.ts  documentation.agent.ts
│   │   ├── reviewer.agent.ts
│   │   └── index.ts                    # registry
│   ├── workflows/
│   │   └── software-factory.workflow.ts
│   ├── utils/
│   │   ├── context-loader.ts           # prompts + convention cascade
│   │   ├── model-router.ts             # tiers, fallback chains, credential checks
│   │   ├── agent-runner.ts             # structured invocation + telemetry + dry run
│   │   ├── schemas.ts                  # every inter-agent data contract (Zod)
│   │   ├── factory-config.ts           # env config + workspace jail
│   │   ├── shell.ts                    # allow-listed, shell-free process execution
│   │   └── dry-run-fixtures.ts         # scenario fixtures for the smoke harness
│   ├── mastra/index.ts                 # Mastra instance (CLI entry point)
│   └── cli/
│       ├── factory.ts                  # run | resume | list | show | doctor
│       └── smoke.ts                    # graph verification harness
├── logs/                               # run traces: logs/<runId>/ + factory.log + factory.db
├── mastra.config.ts                    # agents, workflow, storage, logger, telemetry
├── tsconfig.json
├── package.json
└── README.md
```

Files beyond the original specification — `filesystem-tools.ts` (the developer agent needs
write access), `schemas.ts`, `model-router.ts`, `agent-runner.ts`, `factory-config.ts`,
`shell.ts`, `dry-run-fixtures.ts`, `src/cli/*` and `src/mastra/index.ts` — exist to keep the
requested modules focused and to make the system testable and safe.

### npm scripts

| Script | Purpose |
| --- | --- |
| `npm run factory -- <cmd>` | CLI: `run`, `resume`, `list`, `show`, `doctor` |
| `npm run smoke` | Full-graph dry run with assertions (no LLM) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | typecheck + smoke |
| `npm run dev` | Mastra Studio (`mastra dev`) |
| `npm run build` | `mastra build` → deployable `.mastra/output` |

---

## Configuration reference

All variables are optional unless stated. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Primary provider (required unless overridden/dry-run) |
| `OPENAI_API_KEY` | — | Fallback provider |
| `GOOGLE_GENERATIVE_AI_API_KEY` | — | Optional last-resort fallback |
| `FACTORY_WORKSPACE_ROOT` | `~/workspace` | Hard boundary for all file operations |
| `FACTORY_ALLOW_ANY_PATH` | `false` | Allow repositories outside the workspace |
| `FACTORY_MAX_ATTEMPTS` | `3` | Iterations before human escalation |
| `FACTORY_COMMAND_TIMEOUT_MS` | `900000` | Per-command timeout |
| `FACTORY_MAX_OUTPUT_CHARS` | `24000` | Captured output per stream |
| `FACTORY_EXTRA_ALLOWED_COMMANDS` | — | Extra executables (comma separated) |
| `FACTORY_ALLOW_PUSH` / `FACTORY_ALLOW_PR` | `true` | Gate push / draft PR creation |
| `FACTORY_NON_INTERACTIVE` | `false` | Never suspend (CI mode) |
| `FACTORY_DRY_RUN` | `false` | Stub every LLM call, mutate nothing |
| `FACTORY_DRY_RUN_SCENARIO` | `happy` | Scenario for the dry-run fixtures |
| `FACTORY_ENABLE_REPOMIX` | `true` | Use the `repomix` CLI when available |
| `FACTORY_MODEL_GENERATION` | `current` | `current` or `legacy` model generation |
| `FACTORY_MODEL_<ROLE>` | — | Per-role chain, e.g. `primary,fallback1` |
| `FACTORY_ENABLE_GOOGLE_FALLBACK` | `false` | Append Gemini to every chain |
| `FACTORY_LOG_DIR` | `./logs` | Trace directory root |
| `FACTORY_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `FACTORY_STORAGE_URL` | `file:./logs/factory.db` | LibSQL URL (snapshots, traces) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP trace export endpoint |
| `OTEL_SERVICE_NAME` | `agent-software-factory` | Service name in traces |

---

## Extending the factory

**Add a global standard** — create `global-rules/python-conventions.md`. It is picked up on the
next run, injected into every agent and citable in reviews.

**Override rules for one repository** — add `AGENTS.md` to that repository; it takes
precedence over everything.

**Support another build system** — add a `StackDefinition` entry in
`src/tools/test-runner-tools.ts` (markers + build/test/lint commands) and, if its output format
is new, a parser branch in `parseTestOutput`.

**Add an agent** — write `src/prompts/<role>.md`, add the role to `src/utils/model-router.ts`
(tier + env key), create `src/agents/<role>.agent.ts` with the tools it needs, register it in
`src/agents/index.ts`, then add a `createStep` and wire it into the graph. Add its artifact
prefix in `src/tools/logger-tools.ts` and a dry-run fixture so `npm run smoke` keeps covering
the graph.

**Add a tool** — use `createTool({ id, description, inputSchema, outputSchema, execute })` and
route every path through `resolveInsideRepo` and every command through `src/utils/shell.ts`.

**Trigger from GitHub Actions** — run the CLI in non-interactive mode on a self-hosted runner
(or any runner with the repository checked out):

```yaml
- run: npm ci
  working-directory: agent-software-factory
- run: npm run factory -- run --repo "$GITHUB_WORKSPACE" --task "${{ github.event.issue.title }}" --non-interactive
  working-directory: agent-software-factory
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    FACTORY_ALLOW_ANY_PATH: 'true'
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `No LLM provider credentials found` | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`, or use `--dry-run`. |
| `Target repository ... has uncommitted changes` | Commit or stash first: the factory needs a clean baseline to produce a reviewable diff. |
| `Path ... is outside the factory workspace` | Move the repository under `FACTORY_WORKSPACE_ROOT` or set `FACTORY_ALLOW_ANY_PATH=true`. |
| `Executable "..." is not allow-listed` | Add it to `FACTORY_EXTRA_ALLOWED_COMMANDS`. |
| `Command ... contains shell control characters` | Pass one command per call; chaining (`&&`, `;`, `|`) is intentionally rejected. |
| `No test command could be detected` | Pass `--test-command "<cmd>"` or document it in the repository `AGENTS.md`. |
| PR not created | `gh` missing or unauthenticated, or `FACTORY_ALLOW_PR=false`. The branch and commit are still there; `08-pull-request.json` lists the pending manual actions. |
| Run suspended unexpectedly | Read `logs/<runId>/09-escalation.json` (or the plan artifact) and resume with the printed command. |
| Need to see the reasoning | `logs/<runId>/04-triage.json` holds the root cause, the model decision, the effective decision and any guardrail override. |

---

## License

MIT.
