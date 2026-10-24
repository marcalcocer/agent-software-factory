# Claude Code `stream-json` transcripts

Real output of `claude --print --verbose --output-format stream-json --include-partial-messages
--json-schema ...` (Claude Code 2.1.310, model `haiku`), recorded on 2026-10-24 to build and test the
factory's live activity parser (`factory/src/utils/agent-activity.ts`).

- `read-and-report.ndjson`: the model says what it will do, reads a file, says what it found, then
  returns its answer through the `StructuredOutput` tool.
- `tool-error-and-search.ndjson`: a `Read` of a missing file (a tool result with `is_error: true`), then a
  `Grep`, then the answer.

Sanitised: account-level events (`rate_limit_event`, `active_goal`, `autocompact_state`) were dropped, the
`init` event was cut to a few fields, the session id was zeroed, and the working directory was rewritten
to `/home/dev/workspace/demo` (fragments of the original path may remain inside partial tool-input JSON).
Thinking blocks arrive redacted (empty text, a signature): only their size is known, from the
`system`/`thinking_tokens` events.
