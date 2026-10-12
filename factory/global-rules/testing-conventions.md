# Global Testing Conventions

> Scope: every target repository, any language (JVM, TypeScript/Node, Python, Go).
> Precedence: these rules are **defaults**. A `AGENTS.md` file in the target repository
> always wins when it contradicts this document.

## 1. Non-negotiable rules

1. **Every behavioural change ships with tests.** New feature -> new tests. Bug fix -> a
   regression test that fails before the fix and passes after it.
2. **Never weaken a test to make the suite green.** Deleting assertions, adding `@Disabled`
   / `.skip` / `xfail`, loosening a matcher or increasing a timeout to hide a race condition
   are blocking defects.
3. **Never commit with a red build.** If the suite cannot pass, report the failure and the
   root cause instead of masking it.
4. **Tests are deterministic.** No dependency on wall-clock time, random seeds, network
   access, execution order or leftover state from other tests.

## 2. Test pyramid & scope

| Level           | Share  | Characteristics                                                     |
| --------------- | ------ | ------------------------------------------------------------------- |
| Unit            | ~70%   | One class/function, dependencies doubled, milliseconds, no I/O.     |
| Integration     | ~20%   | Real wiring: database, HTTP layer, messaging. Containers over mocks. |
| End-to-end / API| ~10%   | Critical user journeys against a running application.               |

- Start at the lowest level that can prove the behaviour.
- Integration tests use ephemeral infrastructure (Testcontainers, in-memory brokers,
  disposable schemas). Never a shared or long-lived environment.

## 3. Structure & naming

- One test class/file per production unit: `InvoiceService` -> `InvoiceServiceTest`,
  `parser.ts` -> `parser.test.ts`, `parser.py` -> `test_parser.py`.
- Follow **Arrange - Act - Assert** (given/when/then) with blank lines between the phases.
- Test names describe behaviour, not implementation:
  - Java: `shouldRejectOrder_whenStockIsEmpty`
  - TS/Jest/Vitest: `it("rejects the order when stock is empty")`
  - Python: `def test_rejects_order_when_stock_is_empty()`
- No numeric suffixes (`test1`, `testCase2`) and no assertions in setup/teardown hooks.

## 4. Assertions

- Assert one behaviour per test; multiple assertions are fine when they describe the same
  outcome (prefer a single assertion on an object/state over scattered field checks).
- Always assert on **values and error semantics**, not only on "no exception thrown".
- Use the expressive matcher library already in the project (AssertJ, JUnit 5,
  Vitest/Jest `expect`, `pytest` plain asserts). Keep the project's existing idiom.
- Assert error paths explicitly: expected exception type **and** message/code.
- Forbidden: `assertTrue(true)`, empty test bodies, tests without assertions,
  snapshot updates accepted blindly.

## 5. Test doubles

- Double only what you own or what is slow/non-deterministic (clock, network, filesystem,
  third-party SDKs).
- Never mock the class under test. Never mock value objects or simple data holders.
- Prefer fakes/stubs for state verification; use mocks for interaction verification only when
  the interaction *is* the requirement.
- Inject time (`Clock`, `now()` provider), randomness and ids - then control them in tests.

## 6. Data & fixtures

- Build test data with builders/factories exposing intention-revealing defaults
  (`anOrder().withEmptyStock().build()`), not copy-pasted literals.
- Each test creates the data it needs and cleans up after itself; tests must pass when run in
  isolation and in any order.
- Use realistic but clearly fake values. No production data, no real secrets, no live tokens,
  no personal data.

## 7. Coverage expectations

- Treat coverage as a smoke detector, not a goal. Minimum bar for touched code: **80% line
  coverage and every new branch exercised**.
- Mandatory cases for any new logic: happy path, boundary values, invalid input, failure of
  each collaborator (timeout/exception), and concurrency when the code is shared state.
- Never add tests whose only purpose is to raise the coverage number.

## 8. Execution commands (detected per repository)

| Stack           | Build / test command                                   |
| --------------- | ------------------------------------------------------ |
| Maven           | `./mvnw -B test` (full: `./mvnw -B verify`)            |
| Gradle          | `./gradlew test` (full: `./gradlew build`)             |
| Node / npm      | `npm test` (plus `npm run lint`, `npm run typecheck`)  |
| Node / pnpm     | `pnpm test`                                            |
| Python          | `pytest -q` (plus `ruff check .` when configured)      |
| Go              | `go test ./...`                                        |

- Prefer the repository's documented command (`AGENTS.md`, `README`, CI workflow) over the
  table above.
- Run the **narrow** suite while iterating (single class/file) and the **full** suite before
  declaring the work done.
- Capture and report `stdout`/`stderr` on failure: failing test ids, assertion messages,
  stack traces, exit code.

## 9. Flakiness policy

- A test that fails intermittently is a defect. Identify whether the cause is the test
  (timing, shared state, ordering) or the production code (real race condition).
- Fix the root cause. Re-running a suite is only acceptable to confirm an **infrastructure**
  failure (container start-up, port in use, network) and must be reported as such.
- Never mark a flaky test as ignored to unblock a change.

## 10. Reporting contract

When reporting test results, always provide:

- the exact command executed and its exit code,
- the number of tests run / passed / failed / skipped,
- for each failure: test id, expected vs actual, the relevant stack frame and the file/line,
- a classification: `PRODUCTION_DEFECT`, `TEST_DEFECT`, `INFRASTRUCTURE`, `FLAKY`.

All test names, comments and reports are written in **English**.
