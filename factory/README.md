# agent-software-factory

An asynchronous, multi-agent **software factory** built on [Mastra](https://mastra.ai)
(`@mastra/core`) and TypeScript. Give it a requirement and a repository inside your workspace,
and seven specialised agents plan it, implement it, test it, triage the failures, review it,
audit its security, document it and open a **pull request** (ready for review).

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
- [Which model runs each step](#which-model-runs-each-step)
- [Anatomy of an agent call](#anatomy-of-an-agent-call)
- [LLM resiliency: model fallback chains](#llm-resiliency-model-fallback-chains)
- [Execution backends](#execution-backends)
- [Cost and quota model](#cost-and-quota-model)
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
                       │ suspend + 09-escalation  │     │ 06 polish, 07 docs    │
                       │ (human in the loop)      │     │ 07 pr-writer, 08 PR   │
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
| 00 | **run-namer** | Haiku-class → GPT-4o-mini | **Mandatory, and the cheapest call in the factory.** Names the task from the words of the request: a title for the run history, a slug and a type for the branch. No tools, 45-second limit, two attempts at most; if it cannot answer the task is named from its own first sentence. | none |
| 01 | **pm-architect** | Sonnet-class → GPT-4o | Parses the task, scans the codebase, loads global rules + `AGENTS.md`, produces `executionPlan` (tasks, acceptance criteria, test strategy, risks). Triggers a clarification state when the requirement is blocking-ambiguous. | none |
| 02 | **developer** | Sonnet-class → GPT-4o | Implements production code **and** tests in the target repository. Preserves context across fix iterations and must report how each triage hint was applied. | code + tests |
| 03 | **qa-tester** | Haiku-class → GPT-4o-mini | Runs build/test commands (`mvn test`, `npm test`, `pytest`, …), validates acceptance criteria with local HTTP probes, classifies every failure and emits structured bug reports. | none |
| 04 | **triage** | Sonnet-class → GPT-4o | *Director/Evaluator.* Determines root cause, detects loops by comparing run artifacts across attempts, and routes the workflow. | none |
| 05 | **reviewer** | Sonnet-class → GPT-4o-mini | Reviews the `git diff` against the convention cascade, architecture, maintainability and test honesty. Severity-calibrated findings. | none |
| 06 | **security** | Sonnet-class → GPT-4o | OWASP Top 10 audit of the diff: injection, secrets, access control, misconfiguration, dependency/supply-chain risk. | none |
| 07 | **documentation** | Haiku-class → GPT-4o-mini | *Optional.* Decides whether the change makes any documentation stale - `README.md`, `CHANGELOG.md`, `docs/**`, OpenAPI specs, `AGENTS.md` (facts only, never rules) - and updates exactly that; reports "nothing needs updating" when that is true. It no longer writes the pull-request text. | documentation files only |
| 07 | **pr-writer** | Haiku-class → GPT-4o-mini | **Mandatory** (no switch). Writes the commit message, the pull-request title and the pull-request description from the final diff and the stages' reports. The "Quality gates" section is written by the factory itself from the real results, never by the model. No tools. | none |
| — | **phase-reconciler** | Haiku-class → GPT-4o-mini | After a phase of a [project](#big-requests-projects-and-phases) is merged: reads what its runs really did (the developer's reports, the files, the review rounds) and says, for each phase still planned, whether it is already done, partly done or untouched, and what loose ends the delivery left. One cheap call per merged phase, only when phases remain. No tools. | none |

The developer is the only agent that can modify source code; the documentation agent's write
tools reject anything that is not a documentation file; everybody else is read-only. No agent
can commit, push or open a pull request — delivery is a separate, configuration-gated step.

---

## Which model runs each step

Roles are mapped to **capability tiers**, never to hardcoded model ids. There are two tiers:

- **`reasoning`** — judgment, design, code authoring, security analysis, root-cause analysis.
- **`fast`** — mechanical work: turning supplied test output into a verdict, writing docs from a
  known diff.

The factory needs **one credential**. Failover is cross-tier inside Anthropic
(`sonnet` ⇄ `haiku`), not cross-vendor, so no second provider or second API key is required.

| # | Step | Role | Tier | `claude-cli` model | `api` model |
| --- | --- | --- | --- | --- | --- |
| 00 | Name the task (**mandatory**) | `run-namer` | **fast** | **`haiku`** | **`claude-haiku-4-5`** |
| 01 | Plan the change | `pm-architect` | reasoning | `sonnet` | `claude-sonnet-4-6` |
| 02 | Implement + write tests | `developer` | reasoning | `sonnet` | `claude-sonnet-4-6` |
| 03 | Verify against acceptance criteria | `qa-tester` | **fast** | **`haiku`** | **`claude-haiku-4-5`** |
| 04 | Root-cause analysis on failure | `triage` | reasoning | `sonnet` | `claude-sonnet-4-6` |
| 05 | Code review | `reviewer` | reasoning | `sonnet` | `claude-sonnet-4-6` |
| 06 | Security review | `security` | reasoning | `sonnet` | `claude-sonnet-4-6` |
| 07 | Update documentation (optional) | `documentation` | **fast** | **`haiku`** | **`claude-haiku-4-5`** |
| 07 | Write the commit message and pull-request text (**mandatory**) | `pr-writer` | **fast** | **`haiku`** | **`claude-haiku-4-5`** |
| 08 | Commit / push / PR | — | *deterministic, no LLM* | — | — |

**Why only QA, documentation and the PR writer are on the cheap tier.** Both consume evidence rather than
produce judgment: the factory has already executed the test suite and hands over the real exit
code, the parsed totals and the full patch, so QA is reading and classifying. Documentation
writes prose from a diff that already exists. Everything that decides *what to build*, *whether
code is correct*, or *whether to retry or escalate* stays on the reasoning tier — a weak triage
model makes bad loop decisions, which is the single most expensive failure mode. The PR writer is on that tier too: it summarises a diff and reports it is handed (the documentation agent wrote this text on the same tier before), and a human reads it before anything is published.

**Overriding any of it.** Per role, comma-separated, primary first:

```bash
# claude-cli backend (aliases: haiku | sonnet | opus, or a full model id)
FACTORY_CLI_MODEL_QA_TESTER="sonnet"            # promote QA to the reasoning tier
FACTORY_CLI_MODEL_DEVELOPER="opus,sonnet"       # opus primary, sonnet failover

# api backend (provider-prefixed ids)
FACTORY_MODEL_REVIEWER="anthropic/claude-opus-4-5,anthropic/claude-sonnet-4-6"
```

Confirm what is actually active — this prints the resolved chain for every role:

```bash
npm run factory -- doctor
```

---

## Anatomy of an agent call

Every LLM call in the factory goes through one function, `invokeAgent`
(`src/utils/agent-runner.ts`). There is no other path to a model, which is what makes the
guarantees below hold everywhere.

**What goes in:**

1. **System prompt** — the role's prompt from `src/prompts/<role>.md`, with the resolved
   convention cascade appended (`global-rules/` then the target repo's `AGENTS.md`).
2. **User message** — assembled by the workflow step from labelled blocks: the task, the plan,
   the acceptance criteria, the previous attempt's reports, the diff, the real suite output.
   Empty blocks are dropped (`promptSection` / `composePrompt`).
3. **Output contract** — the role's Zod schema from `src/utils/schemas.ts`.
4. **Tool grants** — scoped per role (see [Safety model](#safety-model)).

**What comes back** is always a schema-valid object. Free-text parsing is never relied on:

| Backend | Structured output mechanism |
| --- | --- |
| `api` | Mastra `structuredOutput: { schema }` → provider-native JSON mode |
| `claude-cli` | `--json-schema` (Zod → JSON Schema) → pre-parsed `structured_output`, then re-validated with Zod |

**If validation fails**, the call walks an escalation ladder rather than failing the step:

```
rung 0   free tier             (only for roles in FACTORY_FREE_ROLES: each free model once, see "Free tier")
rung 1   role's model          (e.g. haiku)
rung 2   role's model again    + the exact Zod errors it violated
rung 3   escalation model      (sonnet, FACTORY_CLI_ESCALATION_MODEL)
```

A role already on the reasoning tier gets rungs 1–2 only. Each rung is logged as an
`agent_schema_retry` event, and a successful escalation is flagged `failedOver: true` in
`summary.json` — so a small model quietly costing you reasoning-tier calls is visible, not
hidden. Only if every rung fails does the step raise. Rung 0 has no repair step: a free model that
breaks the contract is simply skipped and the next model is asked.

**What gets recorded per call**, into `logs/<runId>/`:

- a numbered artifact (`03-qa-tester.attempt-2.json`) holding the full validated payload
- an `agent_call` event with requested model, serving model, the backend that served it
  (`free-tier`, `claude-cli`, `api`), input/output/cached/reasoning tokens, tool-call count, duration
  and the failover flag; after a fallback it also carries `fallbackReason` and every `attempts` entry
- a `model_fallback` event whenever a model other than the first choice answered
- in the numbered artifact, a `routing` block: the model asked first, the one that answered, and every
  attempt with its outcome (`served`, `rate-limit`, `cooling-down`, `not-configured`, `auth`,
  `not-found`, `invalid`, `timeout`, `error`)
- aggregated per-role totals in `summary.json` under `modelsUsed`

---

## LLM resiliency: model fallback chains

In `api` mode, models are declared as a **native Mastra fallback chain**, so a 429 / 5xx /
timeout transparently fails over to the next entry, each with its own retry budget:

```ts
// src/utils/model-router.ts — a reasoning role resolves to:
model: [
  { model: 'anthropic/claude-sonnet-4-6', maxRetries: 3 },  // primary
  { model: 'anthropic/claude-haiku-4-5',  maxRetries: 2 },  // cross-tier failover
]
```

In `claude-cli` mode the equivalent is native too, via `--fallback-model`:

```
--model sonnet --fallback-model opus,haiku
```

- **Defaults are Anthropic-only**, by design: one credential, no second vendor. The one opt-in
  exception is the [free tier](#free-tier-optional) of the `claude-cli` backend.
- `FACTORY_ENABLE_GOOGLE_FALLBACK=true` appends `google/gemini-3.8-flash` as a last resort to
  every chain (needs `GOOGLE_GENERATIVE_AI_API_KEY`).
- `FACTORY_MODEL_GENERATION=legacy` switches to the Claude generation of the original
  specification (`claude-3.7-sonnet` / `claude-3.5-haiku`). Default is `current`.
- Other providers (OpenAI, Groq, OpenRouter, xAI, Mistral, DeepSeek) are **supported but never
  configured by default**. Point a role at one with `FACTORY_MODEL_<ROLE>` and supply that
  provider's key; no code change needed.
- `summary.json` records, per role, the **requested** model, the model that **actually served**
  the call, and a `failovers` counter — provider degradation is visible after the fact.

### Free tier (optional)

With `FACTORY_PROVIDER=claude-cli`, the small roles that need no tools can try **free-quota models
first** and keep your Claude subscription for the work that needs it:

```bash
FACTORY_FREE_ROLES=run-namer,merge-summary,pr-writer          # eligible: run-namer, merge-summary, pr-writer, phase-reconciler
FACTORY_FREE_CHAIN=google/gemini-3.1-flash-lite,google/gemini-3.5-flash-lite
GOOGLE_GENERATIVE_AI_API_KEY=...                                # the keys of the providers in the chain
```

Each model is asked once, in order. Whatever it cannot answer - out of quota, a refused key, an unknown
model, an answer that breaks the output contract, a timeout - is recorded and the next model is asked; if
none answers, Claude does, through the usual ladder. A model that says it is out of quota is left alone
for a while (`FACTORY_FREE_COOLDOWN_MINUTES`, six hours for a daily quota), remembered across runs in
`<FACTORY_LOG_DIR>/free-tier-state.json`.

Nothing is silent. Every step report carries a `routing` block (the model asked first, the one that
answered, every attempt with its reason), `events.ndjson` gets a `model_fallback` event whenever another
model had to take over, and the Studio shows the model under every step of the pipeline, a warning when it
fell back, and "out of quota" when that was the reason. `doctor` lists the chain and the keys it needs.

Free tiers may train on what they are sent: the PR writer and merge summary see your diffs. Check each
provider's terms for the repositories you use this on. `npm run eval:free` measures candidate models on the
three roles before you trust them (`-- --models a,b --rounds 3`).

---

## Execution backends

The factory can source its LLM calls two ways, selected with `FACTORY_PROVIDER`.

### `api` (default) — metered API keys

Provider SDKs through Mastra's model router, with the native fallback chains described above.
Needs only `ANTHROPIC_API_KEY`. Roughly $0.10–0.15 per run with prompt caching enabled.

### `claude-cli` — your Claude Pro/Max subscription

Delegates every call to the **official `claude` binary** in headless (`--print`) mode, so the
work is billed against a Claude Code subscription instead of per-token API credit.

```bash
# one-time
claude login

FACTORY_PROVIDER=claude-cli npm run factory -- doctor --probe
FACTORY_PROVIDER=claude-cli npm run factory -- run --repo my-service --task "..."
```

This uses Anthropic's own first-party client through a documented scripting interface — the
factory never handles the subscription token and never impersonates another client. Usage counts
against the subscription's rolling window; when it is exhausted, the step fails with a
`rate-limit` error and the run can be resumed later with `factory resume --run-id <id>`.

**What it maps onto, all native CLI flags:**

| Factory concern | CLI flag |
|---|---|
| Structured output | `--json-schema` (then re-validated with Zod) |
| Agent instructions | `--system-prompt` (replaces the CLI's own persona) |
| Per-role routing | `--model` — `sonnet` for reasoning roles, `haiku` for QA/docs |
| Fallback chain | `--fallback-model opus,haiku` |
| Tool scoping | `--allowed-tools` / `--disallowed-tools` / `--add-dir` |
| Spend ceiling | `--max-budget-usd` |

**Token discipline.** Replacing the system prompt and passing
`--exclude-dynamic-system-prompt-sections` cuts per-call context from ~162k tokens to ~14k
(measured) — about 11x more factory runs per window. A full clean run costs ~590k tokens, mostly
cache reads.

**Optional proxy.** Setting `ANTHROPIC_BASE_URL` (or `FACTORY_CLAUDE_CLI_BASE_URL`) routes the
CLI through a caching/compression proxy such as Headroom, which reduces window burn further.

**Tool access is per role**, always confined to the target repository:

| Policy | Roles | Tools |
|---|---|---|
| `read-write` | developer, documentation | Read, Write, Edit, MultiEdit, Glob, Grep |
| `read-only` | pm-architect, qa-tester, triage, reviewer, security | Read, Glob, Grep |

`Bash` is denied to every role, preserving the shell-free invariant: build and test commands run
only through the factory's own allow-listed test runner.

**Known differences from the `api` backend:**

- The factory's own sandboxed tools (`git-*`, `read-file`, `run-test-suite`) are not exposed to
  the model; Claude Code's built-ins are used instead. The workspace jail therefore comes from
  `--add-dir` + cwd scoping rather than `resolveInsideRepo`.
- The documentation role cannot be narrowed to docs-only the way the factory's own documentation
  tool is. Gated delivery and the reviewed diff remain the control.
- `total_cost_usd` is reported by the CLI but not billed; `summary.json` still records full
  per-role token counts.

### Credentials deliberately not used

Recorded so the question doesn't get re-litigated. These were investigated and rejected:

| Credential | Why not |
| --- | --- |
| Claude subscription **OAuth token** (`sk-ant-oat01-…`) used directly from the factory | Making it work requires sending a forged Claude Code identity (`anthropic-beta: oauth-2025-04-20` plus a spoofed "You are Claude Code" system prompt). That is circumventing an access control, and the documented consequence is account termination. The `claude-cli` backend achieves the same goal by invoking the real binary instead. |
| **OpenCode Zen free tier** (`opencode/*`) | The API answers `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`. Explicitly licensed to their client. (One model briefly returned `200` while all ten siblings returned the restriction — a gap in their gating, not permission.) |
| **OpenCode Go** (`opencode-go/*`) | `403 — An active OpenCode Go subscription is required`. |
| OpenCode Zen paid models | `402 — Insufficient account funds`. |
| **GitHub Copilot** OAuth token | Same client-only licensing restriction as the OpenCode free tier. |
| **Gemini CLI / Antigravity** login used as a free Gemini source | Google reportedly stopped serving free individual Gemini CLI logins on 2026-06-18 and moved them to the closed-source Antigravity CLI, whose free quota is unpublished and whose terms on scripted use were not found. A plain Gemini **API key** on the free tier is the documented route (see [Free tier](#free-tier-optional)). |
| **Local Ollama** | Technically fine and genuinely free — `qwen3:4b` did return schema-valid JSON. Rejected on latency: ~81 s for a trivial response, so ~12 minutes of pure wait across a 9-call pipeline. Viable as a last-resort fallback if you want it; not as a workhorse. |

---

## Cost and quota model

### `claude-cli` — subscription window, not dollars

Nothing is billed per token; usage counts against your Claude plan's **rolling usage window**.
Measured on a real run (small repo, one clean attempt, 6 agent calls):

| Metric | Value |
| --- | --- |
| Wall-clock | ~87 s |
| Total tokens | ~400k |
| of which cache reads | ~330k (cheap, but still counts toward the window) |
| Input / output | ~13k / ~16k |

Per-call overhead is the thing worth understanding. A naive headless call carries Claude Code's
own system prompt, tool schemas and `CLAUDE.md` preamble — **~162k tokens before your prompt is
even added**. The factory suppresses that with `--system-prompt` (replace, not append) plus
`--exclude-dynamic-system-prompt-sections`, bringing it to **~13.8k — a 91% reduction**, i.e.
roughly 11x more runs per window. It also measurably *improves* answers, because the CLI's
default persona no longer biases the agent's reasoning.

When the window is exhausted, the step fails with a classified `rate-limit` error, the run
suspends, and `factory resume --run-id <id>` continues it once the window resets. Nothing is
lost.

Further reduction: point `ANTHROPIC_BASE_URL` at a caching/compression proxy such as Headroom
(see below).

### `api` — metered

Measured against the real prompt sizes in this repo (~4.6k tokens of system prompt +
conventions per call, ~25k of packed repo context):

| Routing | Per clean run | With prompt caching |
| --- | --- | --- |
| All reasoning tier | $0.54 | **$0.20** |
| All fast tier | $0.18 | **$0.07** |
| Default mixed routing | — | **~$0.10–0.15** |

Add ~40% for a run that retries once. `$5` of credit is roughly 30–50 runs.

### Using Headroom (or any proxy) with `claude-cli`

If you already run a Claude Code caching proxy, the factory uses it transparently:

```bash
FACTORY_CLAUDE_CLI_BASE_URL=http://127.0.0.1:8787   # or just ANTHROPIC_BASE_URL
```

Use the **root** URL — Claude Code appends `/v1/messages` itself, so a `/v1` suffix 404s. This
is the real Claude Code binary talking to a proxy built for it, so nothing about the client
identity changes; the proxy's compression and caching simply reduce window burn.

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
├── run.json                      # task, task id, title, repository, branch, model routing, dry-run flag
│                                 # (written by the CLI the moment the run starts, completed by prepare-run)
├── events.ndjson                 # append-only: agent calls, tokens, tool calls, suite runs,
│                                 # triage guardrails, suspensions, escalations
├── 00-run-namer.json             # the title, slug and type chosen for the task (COMPLETED | FALLBACK)
├── 01-pm-architect.json          # executionPlan + clarifications used
├── 02-developer.json             # developer report (attempt 1)
├── 03-qa-tester.json             # QA verdict, failures, bug reports
├── 04-triage.json                # model decision, effective decision, guardrail overrides
├── 02-developer.attempt-2.json   # second iteration (…and so on per attempt)
├── 03-qa-tester.attempt-2.json
├── 05-code-review.json
├── 06-security.json
├── 06-polish.json                # the minor findings: asked, fixed, declined, undone (NONE | APPLIED | REVERTED | ...)
├── 07-documentation.json
├── 07-pr-writer.json         # commit message, PR title + description (always written; status COMPLETED | FALLBACK | SKIPPED)
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
  `resolveInsideRepo`: traversal outside the target repository is rejected, and so is anything
  outside the places the factory may work in: the workspace (`FACTORY_WORKSPACE_ROOT`), the folder
  of task checkouts (`FACTORY_WORKTREES_DIR`) and the repositories you opened on purpose
  (`FACTORY_EXTRA_REPOS` - the Studio lists every repository you add). A repository somewhere else
  is refused, and the refusal says how to open it; `FACTORY_ALLOW_ANY_PATH=true` lifts the boundary
  altogether. Direct access to `.git` is blocked.
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
[GitHub CLI](https://cli.github.com/) `gh` authenticated for pull requests.

```bash
cd ~/workspace/agent-software-factory
npm install
cp .env.example .env         # then add ANTHROPIC_API_KEY and/or OPENAI_API_KEY
npm run factory -- doctor    # verify configuration, credentials and tooling
```

Target repositories live in `~/workspace/` (configurable via `FACTORY_WORKSPACE_ROOT`): a name like
`--repo invest-track` is looked up there. A repository anywhere else works too once you open it on
purpose - add it in the Studio, or `FACTORY_EXTRA_REPOS=/path/to/repo` (several are separated like `PATH`).

---

## Usage

### Run on your Claude Pro/Max subscription (no API key)

The factory can drive the official `claude` CLI instead of a metered Anthropic API key, so your
subscription becomes the only credential it needs.

```bash
# 1. one-time: make sure Claude Code is installed and logged in
claude login
FACTORY_PROVIDER=claude-cli npm run factory -- doctor --probe   # verifies the session

# 2. run as usual
FACTORY_PROVIDER=claude-cli npm run factory -- run \
  --repo invest-track \
  --task "Add a dark/light/system theme toggle"
```

Put `FACTORY_PROVIDER=claude-cli` in `.env` so you don't repeat it. If the session ever
expires you get a `claude-cli/auth` error — run `claude login` again. Nothing else changes:
same graph, same artifacts, same resume behaviour.

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

Three flags decide *where* and *how big* (see the sections below):

```bash
--isolation worktree|in-place   # where the task works (default: worktree - a checkout of its own)
--phasing auto|on|off           # may the architect split a big request into phases (default: auto)
--phase <phaseId>               # run one phase of an existing roadmap instead of a task
```

#### Where a task works: its own checkout

A task used to work in your repository: it switched the branch you were on, refused to start when you
had uncommitted changes, and nothing else could run there meanwhile. By default each task now works in
its own **git worktree** - a second checkout of the same repository, on the task's branch - in

```text
<workspace>/.factory/worktrees/<repo>/<task id>        e.g.  ~/workspace/.factory/worktrees/invest-track/f0042
```

That folder is `FACTORY_WORKTREES_DIR` (the Studio's Settings has the same field); it is one folder for every
repository, wherever each of them lives. Two rules for choosing one:

- **Somewhere that stays.** Work that is only in a checkout - uncommitted changes - is lost if its folder is.
  Anything under `/tmp` is cleared by a restart, so `doctor` warns when the folder is under the system's
  temporary folder (the committed work is on the branch, in your repository, and survives).
- **Not inside a project that has `node_modules`** - the factory repository included. npm puts the
  `node_modules/.bin` of *every* parent folder on the `PATH` of a script, and Node resolves imports upward, so
  a checkout below such a folder would find the parent's packages and tools: a task whose tests import
  something it never declared would *pass* in the checkout and fail in your CI. (Checked: a script in a folder
  below one with `node_modules` ran the parent's tool and loaded its package; with nothing above, both failed.)
  The default - a hidden folder of the workspace, which has no `node_modules` - has no such problem. (A folder
  inside this repository would have it, and would also need a `.gitignore` entry of its own.)

Changing the folder later leaves the checkouts already made where they are. The factory removes, moves and
tidies only what is in its folder, so it no longer does that for those (it says "is not in the folder where the
factory keeps its checkouts"): when their pull requests are over, remove them yourself with
`git worktree remove <folder>`. A task that goes on in one keeps working while it is still under the workspace or
a repository you opened; one somewhere else is refused with what to do - point `FACTORY_WORKTREES_DIR` back at
its folder, or remove it (what was committed stays on the branch) and start the task again.

Your folder is never touched: it can be on any branch, have uncommitted changes, and several tasks on
one repository run at the same time. The run's `run.json` records `isolation` and `workPath`; the Studio
shows them at the top of every run (and on its pull request), with *Copy path*, *Open folder*, *Remove
worktree* and *Check out here*, so you can look at the code by hand.

What it does, and refuses to do:

- The checkout is cut from the **freshest** base (GitHub's, when it is ahead of your local one) and does
  not track it. If the branch is already checked out somewhere - your repository, say - it **fails and
  says where**; it never falls back to your folder quietly, and never builds over a folder that is not a
  checkout.
- `node_modules` is **linked** from your repository when the lockfile is the same (and kept out of git
  through `info/exclude` - a `node_modules/` rule in `.gitignore` matches a directory, not the link),
  and **installed** (`npm ci --prefer-offline`) when the base's lockfile differs. A failed install is an
  error, not a quiet fallback. `FACTORY_WORKTREE_COPY=.env` copies the listed files, and only ones git
  ignores - a checkout must not be a way to commit a secret.
- A further round, a retry, `resume` and the review of the pull request all find the **same** checkout;
  one you deleted is made again from the branch (which holds everything that was committed), and
  commits a reviewer pushed on top are brought in when that is a plain fast-forward.
- When the pull request is **merged or closed** - whether from the Studio or on GitHub - the checkout is
  removed (a clean one only; the branch stays) *before* the local branch is deleted, since git will not
  delete a branch that is checked out. One with uncommitted work is kept, and the notes say so.
- `--isolation in-place` (or `FACTORY_ISOLATION=in-place`) is the old behaviour: it needs your repository
  clean, and nothing else can use it meanwhile. A round keeps the place its task started in.

```bash
npm run factory -- worktree-list --repo invest-track     # every checkout: task, branch, uncommitted files, its PR
npm run factory -- worktree-gc --repo invest-track       # remove the clean ones whose PR is over
npm run factory -- worktree-remove --repo invest-track --path <folder> [--force]
npm run factory -- worktree-checkout --repo invest-track --path <folder>   # "check out here"
npm run factory -- places                                # where the factory works: workspace, folder of checkouts, repositories opened on purpose
```

`worktree-checkout` moves the task's branch from its checkout to your repository, so you can run it where
you work: it refuses first if either side has changes that would be lost, and puts the checkout back if
your repository cannot take the branch. Only the factory's own checkouts are ever removed or moved - not
a worktree you made with `git worktree add`, even with `--force`.

#### Big requests: projects and phases

A request too big for one reviewable pull request used to be planned as one, with "Phase 2+" written as
prose under *out of scope* that nothing carried past the merge. Now the architect can propose a
**roadmap**, and the factory keeps it.

- **Terms.** A *project* (initiative) has *phases*; each phase is a *run* that opens one pull request, and
  a review of that pull request has *rounds*. Every task is filed under a project - a plain task is a
  project of one phase, hidden from the lists.
- **Planning.** `--phasing auto` (default) lets the architect split the request only when it is too big
  for one pull request; `on` asks for it, `off` forbids it. It then plans **only phase 1**, with the
  roadmap - a title, goal, scope and acceptance per phase, and what each waits for - saved in
  `<FACTORY_LOG_DIR>/initiatives.db` (SQLite). The pull request has a *Roadmap* section ("phase 1 of 3").
- **Starting the next phase.** `run --phase i0001-p2` (the Studio's *Start phase* button) takes the phase
  as the request, named after it, with no model asked to name it. It is **refused while the phase it
  builds on is not merged** - it would be planned against code that is about to change - and the reason
  says which. The architect is shown the project: its goal, what you decided, every phase and where it
  stands, what the finished ones delivered, and the backlog.
- **After a merge**, `phase-reconcile` compares the roadmap with what the phase *really* delivered, read
  from its runs (a first attempt of 19 files and a fix of 3 is a 19-file change): a phase that is already
  done is **skipped** with a note saying where, a partly done one keeps its goal and takes the scope that
  is left, loose ends go to the backlog. The Studio does it for you after a merge (a setting; one cheap
  call). Nothing the model says is trusted blindly: an id that is not a waiting phase is ignored, and in
  a rehearsal nothing reaches the roadmap.
- **The plan is yours.** `initiative-edit` renames, rewords, skips, restores, adds phases and sets backlog
  items aside - but a phase that is running, in review or merged keeps its scope, and an edit is checked
  whole before anything is written.

```bash
npm run factory -- run --repo invest-track --phasing on --task "Redesign the whole frontend"
npm run factory -- initiative-list --repo invest-track                   # projects, phases, what can start
npm run factory -- run --phase i0001-p2                                  # start a phase
npm run factory -- phase-reconcile --phase i0001-p1 [--force]            # compare with what it delivered
npm run factory -- initiative-edit --initiative i0001 \
  --patch '{"phases":[{"id":"i0001-p3","status":"SKIPPED"}],"addPhases":[{"title":"Dark charts"}]}'
```

Each of these prints one marker line (`INITIATIVE_LIST_JSON {...}`, `PHASE_RECONCILE_JSON {...}`, ...) on
stdout, like `pr-check`: the Studio never opens the database itself, the factory CLI is its only writer.

**Review comments about a later phase.** A reviewer who sees phase 2 of 4 will ask for things that belong
to phase 3. The triage is shown the roadmap and may call such a comment `FUTURE_PHASE` (with the phase it
thinks it belongs to). That comment is **neither answered nor built**: the pull request waits in the
Studio ("Choose where it goes") and *you* decide, with a button - not by replying on GitHub:

| You choose | What happens |
|---|---|
| **Defer to phase N** (or a phase of its own) | the comment becomes part of that phase's request, in your words; the comment is settled; with replies on, GitHub gets one acknowledgement saying where it went |
| **Do it in this pull request** | it stays for the next round, which **re-plans** (the work is not in the plan) with the comment as new scope |

```bash
npm run factory -- scope-decide --repo invest-track --pr 8 \
  --decisions '[{"commentId":"IC_1","decision":"DEFER","targetPhase":"i0001-p3"},{"commentId":"IC_2","decision":"DO_NOW"}]' [--reply]
```

What the triage says is made safe before anything acts on it: without a roadmap `FUTURE_PHASE` does not
exist (the comment is new scope for this pull request); a target that is not a phase it can go to becomes
"unknown" and you choose; and a report that asks for another round when no comment asks for a change -
only questions and later-phase requests - becomes a reply-only report. The round (`revise`) leaves out any
comment you have not decided.

#### Choosing which stages run

Prepare, PM Architect, Developer, the PR writer and Delivery always run. The quality gates can be switched off
per task - useful for a docs-only change or a spike, and they cost no tokens when off:

```bash
npm run factory -- run --repo invest-track --task "Fix the typo in the README" \
  --no-qa --no-review --no-security --no-docs
```

| Flag | Skips |
|---|---|
| `--no-qa` | The build/test run and the QA agent (also disables the triage retry loop) |
| `--no-review` | The code review agent |
| `--no-security` | The security audit agent |
| `--no-docs` | The documentation agent (README / CHANGELOG / docs updates). The commit message and pull-request text are **not** affected: the PR writer always runs |
| `--no-polish` | The polish pass: the minor findings of the gates are listed in the pull request instead of fixed (see below). It needs QA, which checks its fixes, so `--no-qa` skips it too |

A skipped stage still writes a `SKIPPED` artifact (and counts as satisfied, never as failed), and
the stages a run used are recorded in its `run.json` under `pipeline`. `summary.json` reports a stage that
did not run as `SKIPPED` under `gates` - never as the passing verdict its placeholder report carries.

#### The polish pass: minor findings, fixed once

QA, the reviewer and the security agent report things that do not block a merge. They used to be written
down and dropped: in a real run QA and the reviewer both named the same one-line fix and it was merged
unfixed. Findings now have three fates:

| Finding | What happens |
|---|---|
| Blocking: BLOCKER / MAJOR review findings, CRITICAL / HIGH security findings, a failed QA | the retry loop (triage, developer, QA again), as always |
| Minor, introduced by this change, with a concrete fix: review `MINOR`, QA `MINOR` bugs, security `LOW` / `MEDIUM` | **one polish pass** (up to eight findings, security first) |
| NITs, `INFO`, anything that was already there, a remark with no fix, the rest beyond eight | reported in the pull request's Follow-ups, never acted on |

The pass, after the gates and before the documentation: the factory records the working tree, asks the
**developer** in patch mode (only the findings, each with an id; it answers `REV-1: what I changed` or
`REV-2: Not applied - why`), runs the repository's tests and build again, and **keeps the result or puts
the recorded tree back**. It is undone when the tests or the build fail, when fewer tests pass than
before, when it removes assertions from a test file, or when it grows past 10 files / 250 lines. QA is not
called again - that would cost a second full iteration; the deterministic checks and those guards are what
protect the change.

`06-polish.json` records `NONE | SKIPPED | APPLIED | DECLINED | REVERTED | FAILED`, what was asked, fixed,
declined (with the developer's reason) and only reported. The pull request says it too: a **Polish** line
in the quality gates ("fixed 2 of 4 minor findings - 3 files changed after the review, tests and build
passed again") and every unfixed finding under Follow-ups - written by the factory, not left to the model.
A failing pass cannot fail the run; the one thing that does is not being able to undo it.

#### How a task is named

Every task gets an **id** and a **name** before any work starts, so everything it leaves behind can be
found again and read at a glance:

| What | Example | Where it shows |
|---|---|---|
| Task id | `f0042` | handed out in order (`logs/task-sequence.json`), shared by all rounds of the task |
| Title | `Dark mode for every screen` | the run history; the user can rename it (their name always wins) |
| Branch | `factory/f0042/feat-dark-mode-every-screen` | `factory/<id>/<type>-<slug>`; `--branch` overrides it |
| Commit trailer | `Factory-Task: f0042` | the last line of every commit the factory makes |

The `run-namer` agent chooses the title, the slug and the type (`feat`, `fix`, `refactor`, `perf`,
`docs`, `test`, `chore`, `build`, `ci`) from the request. It runs right after the repository is
prepared and before the architect, because the branch is named after it. If it cannot answer, the task is
named from the request's first sentence (`fallbackRunName`) - "Untitled run" no longer exists.

A **round** on a pull request keeps the id, the branch and the task's title; its own title is what the
feedback triage says the round is about (`roundTitle`), or `<task title> · round N`.

#### The commit message and the pull-request text

Two different jobs, two different agents:

| | **documentation** (optional) | **pr-writer** (mandatory) |
|---|---|---|
| Question it answers | Does this change make any documentation wrong or incomplete? | How should this change be described? |
| Writes | `README.md`, `CHANGELOG.md`, `docs/**`, OpenAPI specs, `AGENTS.md` facts | the commit message, the PR title, the PR description |
| Can be switched off | yes (`--no-docs`) | no |
| Needs the diff | reads the repository | is handed the final diff (no tools) |

The PR writer runs after the documentation step (so it can say what was documented) and before the
commit, so the commit carries its message rather than the planner's guess - which was made before any
code existed. It reads the **final diff**; where the task, the plan or a report disagrees with it, the
diff wins.

- **The "Quality gates" section is the factory's, not the model's.** It is built from the stages' real
  results, so a stage you switched off reads `not run (disabled for this task)` and no description can
  claim a gate that did not run. A section of that name written by the model is replaced.
- **It never blocks a delivery.** If the model cannot answer (signed out, usage limit, timeout), the same
  text is built from the run's reports (summary, changed files, QA commands, gates) instead; the artifact
  is `FALLBACK`, and the delivery gate shows a note asking you to read it with care.
- **A round on an existing pull request** does not call it: the title and description are already on
  GitHub (perhaps edited by a person), and the round's commit message says what was asked. The artifact is
  `SKIPPED` and the Studio lists the step as skipped, with the reason.
- You can still change the commit message, title and description at the delivery gate before anything is
  published. Override the model with `FACTORY_CLI_MODEL_PR_WRITER` / `FACTORY_MODEL_PR_WRITER`.


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

The delivery gate asks whether to push and open the pull request, and lets the human change what
is about to be published first - the commit message, the branch name, and the pull request's title
and description (the values sent are the final ones, not a diff):

```bash
npm run factory -- resume --run-id 20251008-234512-invest-track-a1b2 \
  --approve-push true --approve-pr true \
  --edits '{"pullRequestTitle":"Add cursor pagination","commitMessage":"feat(api): cursor pagination"}'
```

Published history is never rewritten: once the commit is on the remote its message is locked (it
would need a force-push), and once the branch is on the remote it cannot be renamed. Those edits
are refused with a note in the delivery report; the title and description can always be changed.
Pull requests are opened **ready for review**, not as drafts.

A run restarted after a failure (`resume` on a failed run re-enters at the failed step) and then
answered at a human gate used to finish its work but never write `summary.json` - a Mastra quirk
the CLI now detects and repairs by continuing at the first step that did not complete. Running
`resume --run-id <id>` on a run that is stuck that way just closes it out; nothing is redone.

### Acting on review comments

A pull request the factory opens is **watched**. When a reviewer comments, the factory notices,
reads the comments and - if they ask for code changes - runs a further **round** of the *same task*:
the same branch, the same plan, the reviewer's words handed to the developer, then QA, review,
security and docs as before. It stops at the delivery gate like any run, so nothing is pushed
without approval, and the push **updates the existing pull request** (no second one is opened).

```
 run delivers PR #5 ──register──▶ watched ──every minute──▶ comments? ──▶ triage ──▶ round 2 ──▶ push
   (round 1)         (the "notify")      + right after any run ends        (1 agent call)  (linked to round 1)
```

A round is a run of its own (its own trace, so round 1's results are never overwritten) that is
*linked* to the run it continues: `parentRunId`, `rootRunId` and `round` are recorded in its
`run.json` and `summary.json`, and the Studio shows the rounds of a task together.

| Step | Cost | Changes anything? |
|---|---|---|
| Detect (`pr-check`, every interval) | a few `gh` reads | no |
| Triage (`pr-feedback`) | one agent call | no (unless replies are on) |
| Round (`revise`) | a full run | local commits only, until you approve the push |
| Replies (opt-in) | `gh` writes | yes - visible to everyone on GitHub |

Which comments count: human comments that are **submitted**, unresolved, not from a bot, not the
factory's own replies, and not already handled (answered, dismissed, or fixed by a round). A review
you are still drafting is *not* feedback yet - GitHub shows your pending comments to you alone, and
the factory ignores them until you submit the review; they are picked up on the next check after
that. Comments written **before** the factory started watching a pull request are listed but never
acted on by themselves - only a new comment starts work; you can still triage the old ones by hand.

The same steps from the command line:

```bash
npm run factory -- pr-check                                  # which open PRs have unhandled comments?
npm run factory -- pr-feedback --repo invest-track --pr 5    # classify them (add --post-replies to answer questions)
npm run factory -- revise --repo invest-track --pr 5         # round 2: same task, same branch, same plan
npm run factory -- revise --repo invest-track --pr 5 --action RERUN_PLANNING   # plan again first
npm run factory -- pr-reply   --repo invest-track --pr 5     # post the drafted answers to questions
npm run factory -- pr-dismiss --repo invest-track --pr 5 --comments <id,id>   # never act on these
# CI: triage and, when the PR is one the factory opened, chain into a linked round
npm run factory -- pr-feedback --repo invest-track --pr 5 --auto-rerun
```

**Replies on GitHub** are off by default because they are public. When on: questions and notes are
answered right after triage; for requested changes the round replies "addressed in `<commit>`"
*after* it is pushed - never "I'll do that" before anything exists. A disagreement is left to a
human. Inline comments are answered in their own thread.

Replies go out through *your* GitHub account (`gh` is signed in as you), so every one of them starts
with a visible line - `🤖 AI software factory · automated reply, posted through this account` - and
ends with a hidden marker the factory uses to never triage its own words. If you have a review in
progress, a reply is **not** added to the thread (GitHub would put it inside your draft, invisible to
everyone until you submit): it goes out as a conversation comment that quotes what it answers.

A round commits with a message that describes the round - `chore: address review feedback on PR #5
(round 2)` plus what was asked - rather than repeating round 1's. When a round reuses the plan, the
PM Architect step is shown as *skipped* (the architect was not called again).

A comment asking to delete or weaken a test is never acted on: it is reported as a blocker for a
human to decide. The pull requests are tracked in `logs/pr-registry.json` (written only by the
factory); pull requests from runs made before this existed are discovered from their delivery
reports. In the Studio all of this is the **Pull requests** panel. The check interval and the
automatic steps are in **Settings → Pull requests**, with an override per repository (for example:
read comments and start rounds in one repository, detect only in another).

### Merging a pull request

When a pull request has no unhandled comments and no round in progress, the Studio's **Pull
requests** panel asks the one question a machine cannot answer - *"Do you approve this pull
request?"* - and only then offers the merge:

```
 read it on GitHub ──▶ "Yes - I reviewed it and I have no comments" ──▶ Merge with squash... ──▶ check the message ──▶ Squash and merge
                        (bound to one commit)                           (an agent writes it)     (editable)          (squash, delete branch, back to master)
```

- **The approval belongs to one commit.** It is the commit GitHub reported when you were shown the
  pull request. If anything is pushed afterwards - a round, a suggestion committed on GitHub - the
  approval no longer counts and the question is asked again. At merge time GitHub itself enforces
  it (`gh pr merge --match-head-commit`), so even a race cannot merge code you did not see.
- **Nothing is trusted from the screen.** Just before merging, the factory asks GitHub again: is it
  still mergeable (no conflicts, not a draft, no blocking rule), and has a review comment arrived
  that nobody has dealt with?
- **The squash message is written from the net diff.** After a few review rounds the title, the
  description and the individual commits describe a path that no longer matches the result, so the
  `merge-summary` agent reads the final diff (what will really land), the pull request description,
  the commit messages and the style of the base branch's recent commits, and writes a subject and a
  body. Lockfiles and minified files are left out of what it reads, and it has no tools. It runs once
  per merge, on the cheap tier (`FACTORY_CLI_MODEL_MERGE_SUMMARY` / `FACTORY_MODEL_MERGE_SUMMARY`
  override it). If it cannot answer, the pull request's own title and summary are used, and the screen
  says so. You always see - and can edit - the message before anything is merged.
- **Afterwards it tidies up.** The branch is deleted (on GitHub, and locally when nothing would be
  lost: a local commit that was never pushed keeps its branch; a branch another open pull request is
  based on is kept), and your working copy goes back to the base branch, fast-forwarded - but only if
  it was on the merged branch, has no uncommitted changes and no run is using it. Whatever was *not*
  done is listed in plain words next to the result.

The same from the command line (both print one marker line, `PR_MERGE_DRAFT_JSON` / `PR_MERGE_JSON`):

```bash
npm run factory -- pr-merge-draft --repo invest-track --pr 5      # the commit message a squash would have; changes nothing
npm run factory -- pr-merge --repo invest-track --pr 5 \
  --head-sha <the commit you approved> --subject="Use const in ForecastUtils (#5)" --body="..." \
  [--delete-branch false] [--return-to-base false] [--dry-run]
```

`pr-merge` exits 0 when merged (or rehearsed with `--dry-run`), 1 when it did not merge (the reason is
in the marker line), 2 on a usage error. It also honours `FACTORY_ALLOW_PUSH=false`.

#### Which branch a new task starts from

A task used to start from *whatever branch was checked out*. After a run the factory leaves its own
branch checked out, so the next task was cut from it and carried that run's commits into its pull
request (stacked on the first one and tangled up in its review). Now, unless `--base-branch` says
otherwise:

- the checked-out branch is used, **unless** it is one the factory made earlier (a `factory/...`
  branch, or the head of a pull request it opened) - then the repository's default branch is used,
  and the run's events record why (`base_branch_chosen`);
- the new branch is cut from the **newest** state of the base: GitHub's, when it is ahead of your local
  one (after a merge on GitHub your local `master` is behind), otherwise your local branch (it may hold
  commits of yours that are not pushed). If the network is down, the local branch is used.

A branch you chose yourself is still respected as a base - working on top of your own feature branch
is deliberate.

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

`npm run smoke` executes the **entire workflow** once per scenario (fifteen runs) with stubbed LLM responses
(`FACTORY_DRY_RUN=true`), asserting routing, loops, suspension, artifacts and metrics.
No API key, no network, no repository mutation:

```bash
npm run smoke          # all scenarios
npm run smoke -- --scenario retry
npm test               # the unit tests (Vitest)
npm run check          # typecheck + unit tests + smoke
```

| Scenario | What it proves |
| --- | --- |
| `happy` | plan → develop → QA pass → review + security approve → docs → delivery, 1 attempt |
| `happy` (docs off) | documentation switched off → the PR writer still writes the commit message and PR text; delivery uses it |
| `happy` (all stages off) | QA, review, security and docs off → the PR text is still written and its Quality gates section says plainly that nothing ran |
| `retry` | QA fails → triage `RETRY_DEVELOPER` → attempt 2 green (hints threaded into the prompt) |
| `infra` | QA fails on environment → triage `RE-RUN_INFRA` → developer step skipped, suite re-run |
| `review-changes` | QA green but reviewer requests changes → triage → fixed on attempt 2 |
| `security-block` | security audit blocks → triage → fixed on attempt 2 |
| `escalate` | identical failure twice → loop detected → `suspend()` → resume → `ESCALATED_TO_HUMAN` |
| `escalate` (CI) | same failure with `--non-interactive` → escalation recorded, no suspension |
| `clarify` | blocking ambiguity → `suspend()` → resume with answers → delivery |
| `polish` | the review approves with a minor remark and a nit → the polish pass fixes the first, only reports the second; with polish off, the remark is listed in Follow-ups instead |
| `happy` (round) | a further round on a pull request → not named again, titled by its triage, the PR writer writes the commit message |
| `phased` | the architect splits a big request → only phase 1 is planned, the roadmap is saved and shown in the PR, phase 2 is refused until phase 1 is merged, then runs named by its phase with no model asked, and a merged phase is reconciled once |
| `phased` (phasing off) | the user forbids phases → one pull request, no roadmap |

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
│   │   └── security.md  documentation.md  reviewer.md  pr-writer.md
│   ├── tools/
│   │   ├── git-tools.ts                # status/diff/log + branch/commit/push/PR
│   │   ├── test-runner-tools.ts        # stack detection, command runner, suite parsing, HTTP probe
│   │   ├── repomix-tools.ts            # tree, search, token-budgeted context packing
│   │   ├── filesystem-tools.ts         # read/list + write/edit (code vs documentation scoped)
│   │   └── logger-tools.ts             # trace dirs, artifacts, events, metric aggregation
│   ├── agents/
│   │   ├── pm-architect.agent.ts  developer.agent.ts  qa-tester.agent.ts
│   │   ├── triage.agent.ts  security.agent.ts  documentation.agent.ts  pr-writer.agent.ts
│   │   ├── reviewer.agent.ts
│   │   └── index.ts                    # registry
│   ├── workflows/
│   │   └── software-factory.workflow.ts
│   ├── utils/
│   │   ├── context-loader.ts           # prompts + convention cascade
│   │   ├── model-router.ts             # tiers, fallback chains, credential checks, free-tier chain
│   │   ├── model-routing.ts            # which model answered and why not the first; cooldowns
│   │   ├── free-tier.ts                # asks the free models before Claude (tool-free roles)
│   │   ├── free-tier-eval.ts           # samples and checks behind `npm run eval:free`
│   │   ├── agent-runner.ts             # structured invocation + telemetry + dry run
│   │   ├── schemas.ts                  # every inter-agent data contract (Zod)
│   │   ├── factory-config.ts           # env config + workspace jail
│   │   ├── shell.ts                    # allow-listed, shell-free process execution
│   │   └── dry-run-fixtures.ts         # scenario fixtures for the smoke harness
│   ├── mastra/index.ts                 # Mastra instance (CLI entry point)
│   └── cli/
│       ├── factory.ts                  # run | resume | list | show | doctor
│       ├── free-tier-eval.ts           # `npm run eval:free`: can a free model do the small roles?
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
| `npm test` | Unit tests (Vitest): the pure logic, a real git repository and a real tiny npm project, and the real runs under `../fixtures` replayed |
| `npm run check` | typecheck + tests + smoke |
| `npm run dev` | Mastra Studio (`mastra dev`) |
| `npm run build` | `mastra build` → deployable `.mastra/output` |

---

## Configuration reference

All variables are optional unless stated. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACTORY_PROVIDER` | `api` | `api` (metered key) or `claude-cli` (Claude subscription) |
| `ANTHROPIC_API_KEY` | — | Only credential the defaults need in `api` mode |
| `GOOGLE_GENERATIVE_AI_API_KEY` | — | Only if `FACTORY_ENABLE_GOOGLE_FALLBACK=true`, or a `google/*` model is in `FACTORY_FREE_CHAIN` |
| `GROQ_API_KEY` / `MISTRAL_API_KEY` | — | Only for a `groq/*` / `mistral/*` model in `FACTORY_FREE_CHAIN` |
| `FACTORY_FREE_ROLES` | — | Roles that try the free tier first (`claude-cli` only): any of `run-namer`, `merge-summary`, `pr-writer`, `phase-reconciler` |
| `FACTORY_FREE_CHAIN` | — | Free-quota models to ask, in order, e.g. `google/gemini-3.1-flash-lite,google/gemini-3.5-flash-lite` |
| `FACTORY_FREE_COOLDOWN_MINUTES` | `15` | How long a model that said it is out of quota is left alone (six hours when the quota is daily) |
| `FACTORY_CLAUDE_CLI_BASE_URL` | — | Proxy for the CLI backend (or use `ANTHROPIC_BASE_URL`) |
| `FACTORY_CLAUDE_CLI_TIMEOUT_MS` | `600000` | Timeout for one headless `claude` call |
| `FACTORY_CLAUDE_CLI_MAX_BUDGET_USD` | — | `--max-budget-usd` ceiling per call |
| `FACTORY_CLAUDE_CLI_FILE_TOOLS` | `true` | Grant Claude Code's file tools, scoped to the repo |
| `FACTORY_CLI_MODEL_<ROLE>` | — | Per-role CLI chain, e.g. `sonnet` or `opus,sonnet` |
| `FACTORY_CLI_ESCALATION_MODEL` | `sonnet` | Model a cheap-tier call escalates to on schema failure |
| `FACTORY_WORKSPACE_ROOT` | `~/workspace` | Where repositories are found by name; part of the boundary for all file operations |
| `FACTORY_EXTRA_REPOS` | — | Repositories outside the workspace that you opened on purpose: absolute paths, separated like `PATH` (`:`). The Studio sets it for every repository you add. Agents are confined to each, like to a workspace repository |
| `FACTORY_WORKTREES_DIR` | `<workspace>/.factory/worktrees` | Where each task's checkout is made (see [Where a task works](#where-a-task-works-its-own-checkout)); part of the boundary. Keep it somewhere that survives a restart |
| `FACTORY_ALLOW_ANY_PATH` | `false` | Lift the boundary altogether (not recommended; prefer `FACTORY_EXTRA_REPOS`) |
| `FACTORY_MAX_ATTEMPTS` | `3` | Iterations before human escalation |
| `FACTORY_COMMAND_TIMEOUT_MS` | `900000` | Per-command timeout |
| `FACTORY_MAX_OUTPUT_CHARS` | `24000` | Captured output per stream |
| `FACTORY_DIFF_BUDGET_CHARS` | `120000` | Characters of a change's diff one agent is shown (about 4 per token). A larger change is condensed, never cut silently: the agent gets a manifest of every changed file and what was left out, and can read the complete patch from the run's `context/` directory. QA is shown at most 60000, tests first |
| `FACTORY_EXTRA_ALLOWED_COMMANDS` | — | Extra executables (comma separated) |
| `FACTORY_ALLOW_PUSH` / `FACTORY_ALLOW_PR` | `true` | Gate push / PR creation |
| `FACTORY_ISOLATION` | `worktree` | Where a task works unless `--isolation` says otherwise: `worktree` (a checkout of its own, in `FACTORY_WORKTREES_DIR`) or `in-place` (your repository) |
| `FACTORY_WORKTREE_COPY` | — | Files (comma separated, relative to the repository) copied into each checkout, e.g. `.env`; only ones git ignores |
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
| `No LLM provider credentials found` | Set `ANTHROPIC_API_KEY` in `.env`, or use `FACTORY_PROVIDER=claude-cli`, or `--dry-run`. |
| `claude-cli/auth: OAuth session expired` | Run `claude login`. Claude Code keeps its own session, separate from other clients. Verify with `doctor --probe`. |
| `claude-cli/rate-limit` | Your Claude plan's usage window is exhausted. Resume with the printed `factory resume --run-id <id>` once it resets. |
| `claude-cli/not-installed` | `claude` is not on `PATH`. Install Claude Code, or switch to `FACTORY_PROVIDER=api`. |
| `claude` calls 404 through a proxy | Use the **root** proxy URL (`http://127.0.0.1:8787`), not `/v1` — the CLI appends `/v1/messages` itself. |
| A step shows ⚠ "fell back" in the Studio | A free-tier model could not answer and another model did. The step's detail lists every model tried and why (quota, key, model name, answer shape); `events.ndjson` has the `model_fallback` event. |
| `[missing] google (set GOOGLE_GENERATIVE_AI_API_KEY)` in `doctor` | A provider in `FACTORY_FREE_CHAIN` has no key. The call skips that model (`not-configured`) and goes on; set the key or drop the model. |
| Free model says `not-found` | The provider has no such model for your key. List what it offers (for Groq: `curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`), then fix `FACTORY_FREE_CHAIN`. |
| Output violates schema on all rungs | The ladder (role model → repair → `sonnet`) all failed. The `agent_schema_retry` events show the exact Zod errors; usually a prompt/schema mismatch after editing a schema. |
| `Target repository ... has uncommitted changes` | Commit or stash first: the factory needs a clean baseline to produce a reviewable diff. |
| `Path ... is outside the places the factory may work in` | Open the repository in the Studio, or set `FACTORY_EXTRA_REPOS=/path/to/repo`, or move it under `FACTORY_WORKSPACE_ROOT`. `FACTORY_ALLOW_ANY_PATH=true` lifts the boundary altogether. |
| `Executable "..." is not allow-listed` | Add it to `FACTORY_EXTRA_ALLOWED_COMMANDS`. |
| `Command ... contains shell control characters` | Pass one command per call; chaining (`&&`, `;`, `|`) is intentionally rejected. |
| `No test command could be detected` | Pass `--test-command "<cmd>"` or document it in the repository `AGENTS.md`. |
| PR not created | `gh` missing or unauthenticated, or `FACTORY_ALLOW_PR=false`. The branch and commit are still there; `08-pull-request.json` lists the pending manual actions. |
| Run suspended unexpectedly | Read `logs/<runId>/09-escalation.json` (or the plan artifact) and resume with the printed command. |
| Need to see the reasoning | `logs/<runId>/04-triage.json` holds the root cause, the model decision, the effective decision and any guardrail override. |

---

## License

MIT.
