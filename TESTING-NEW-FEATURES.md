# Testing Guide: PR Feedback Loop & Configurable Pipeline

This guide walks through testing the two new features added to the factory.

---

## Feature 1: Per-Task Configurable Pipeline

**What it does**: Skip optional quality gates (QA, review, security, docs) on a per-task basis.

### CLI Testing

```bash
cd factory

# Dry run with QA and security disabled (no tokens spent)
npm run factory -- run \
  --repo /path/to/your/repo \
  --task "Add a utility function to format timestamps" \
  --dry-run \
  --no-qa \
  --no-security

# Check the run completed
ls -lah logs/$(ls -t logs/ | head -1)/

# Verify qa-tester and security artifacts show "Stage disabled"
cat logs/$(ls -t logs/ | head -1)/artifacts/qa-tester-*.json
cat logs/$(ls -t logs/ | head -1)/artifacts/security-*.json
```

**Expected behavior**:
- Run completes with `DELIVERED_WITHOUT_PR` status
- QA report shows `"verdict": "PASS"` with summary starting "Stage disabled for this task."
- Security report shows `"status": "PASS"` with `"riskLevel": "NONE"`
- No test commands executed, no security audit performed
- Pipeline still validates that developer completed the task

### Studio UI Testing

```bash
cd studio
npm run dev
```

1. Add a repo in the sidebar
2. Enter a task description
3. Click **Pipeline** to expand the stage selector
4. Toggle off **QA** and **Security**
5. Notice the warning list shows what you're skipping
6. Click **Run Task**
7. Watch the pipeline view - QA and Security should complete instantly with ⚠️ status
8. Click into those steps to see "Stage disabled" in the artifact

**Available flags**:
- `--no-qa` - Skip test suite execution
- `--no-review` - Skip code review
- `--no-security` - Skip security audit
- `--no-docs` - Skip documentation updates and auto-generated PR description

**Mandatory stages** (always run):
- Prepare (repo setup)
- PM Architect (planning)
- Developer (implementation)
- Delivery (push/PR)

---

## Feature 2: PR Feedback Loop

**What it does**: Reads GitHub PR review comments, classifies them with a triage agent, posts replies, and optionally reruns the factory with a follow-up task.

### CLI Testing (Read-Only)

First, create a test PR with review comments:

```bash
# In your test repo, create a PR with the factory
cd /path/to/your/repo
git checkout -b test-feedback
echo "// test change" >> src/index.ts
git add -A
git commit -m "test: trigger factory run"
git push -u origin test-feedback

# Run the factory to create artifacts
cd /home/magmarc9/workspace/agent-software-factory/factory
npm run factory -- run \
  --repo /path/to/your/repo \
  --task "Add a test change" \
  --branch test-feedback

# Open a draft PR (if the factory didn't already)
cd /path/to/your/repo
gh pr create --draft --title "test: trigger factory run" --body "Testing PR feedback"
```

Now add review comments through GitHub UI:
- Add a conversation comment: "Why did you choose this approach?"
- Add a review with inline comment: "This variable name could be clearer"
- Submit the review as "Request changes"

Run the feedback triage in **read-only mode** (no replies posted):

```bash
cd /home/magmarc9/workspace/agent-software-factory/factory

npm run factory -- pr-feedback \
  --repo /path/to/your/repo \
  --pr 1

# Check the triage output
cat logs/$(ls -t logs/ | grep feedback | head -1)/artifacts/feedback-triage-*.json
```

**Expected output** (example):
```json
{
  "summary": "2 review comments: 1 code change request, 1 clarification question",
  "feedbackItems": [
    {
      "source": "inline_comment",
      "author": "reviewer_username",
      "excerpt": "This variable name could be clearer",
      "category": "CODE_CHANGE_REQUEST",
      "assignee": "developer"
    },
    {
      "source": "conversation_comment",
      "author": "reviewer_username", 
      "excerpt": "Why did you choose this approach?",
      "category": "CLARIFICATION",
      "assignee": "pm-architect"
    }
  ],
  "action": "RERUN_IMPLEMENTATION",
  "followUpTask": "Address reviewer feedback: rename variable for clarity, explain approach choice"
}
```

### Testing with Replies (⚠️ Publicly Visible)

```bash
npm run factory -- pr-feedback \
  --repo /path/to/your/repo \
  --pr 1 \
  --post-replies

# Check GitHub PR - you should see factory replies marked with:
# <!-- factory-reply: <comment-id> -->
```

### Testing Auto-Rerun

```bash
npm run factory -- pr-feedback \
  --repo /path/to/your/repo \
  --pr 1 \
  --post-replies \
  --auto-rerun

# This will:
# 1. Triage the feedback
# 2. Post replies to each comment
# 3. Kick off a new factory run with the follow-up task
# 4. The new run gets its own log directory

# Check both runs
ls -lah logs/ | grep feedback
ls -lah logs/ | tail -2
```

### Studio UI Testing

```bash
cd studio
npm run dev
```

1. Select a repo that has an open PR
2. Click **PR Feedback** to expand the panel
3. Enter the PR number
4. Check **Post replies to PR** if you want visible output
5. Check **Auto-rerun factory** if you want a follow-up task
6. Click **Triage Feedback**
7. Watch the pipeline view stream the triage agent's work
8. Check the resulting artifact for routing decisions

### Safety Guards

The triage agent has two important safeguards:

1. **Reply markers**: Factory replies include `<!-- factory-reply: <id> -->` so they're never re-triaged
2. **Test-weakening detection**: Any comment asking to delete, skip, or weaken a test gets flagged as a blocker and escalated to a human rather than auto-applied

Example of blocker escalation:
```json
{
  "category": "BLOCKER_DISAGREEMENT",
  "assignee": "human",
  "excerpt": "Can we just skip this failing test for now?",
  "action": "ESCALATE"
}
```

---

## GitHub Actions Integration

A template workflow is available at:
```
factory/templates/github-actions/factory-pr-feedback.yml
```

**⚠️ Important**: This workflow is **untested** and requires decisions:

### Option A: API Key (Costs per run)
```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```
- Store API key in repo secrets
- Each triage run costs ~$0.10-0.50 depending on comment volume
- No infrastructure needed

### Option B: Self-Hosted Runner (Infrastructure cost)
```yaml
runs-on: self-hosted
```
- Set up a runner with `claude auth login` (uses your Pro subscription)
- No per-run cost, but requires maintaining the runner
- Runner needs Node.js, git, gh CLI, and factory repo checked out

### Trigger Configuration

The template triggers on:
```yaml
on:
  pull_request_review:
  issue_comment:
    types: [created]
```

It only runs on:
- PRs with branches matching `factory/*`
- Comments not authored by bots (to prevent self-trigger loops)

---

## Verification Checklist

### Configurable Pipeline
- [ ] `--no-qa` completes without running test commands
- [ ] `--no-review` completes without code review
- [ ] `--no-security` completes without security audit  
- [ ] `--no-docs` completes without changelog/PR description updates
- [ ] Skipped stages show explicit "Stage disabled" in artifacts
- [ ] Run still completes with DELIVERED status
- [ ] Studio UI shows skipped stages with ⚠️ icon

### PR Feedback Loop
- [ ] `pr-feedback --pr N` triages without posting replies
- [ ] Triage artifact shows correct categories and assignees
- [ ] `--post-replies` posts marked comments to PR
- [ ] `--auto-rerun` kicks off a new factory run
- [ ] Factory never re-triages its own marked replies
- [ ] Test-weakening requests get escalated, not auto-applied
- [ ] Studio UI streams triage agent output

---

## Troubleshooting

### Pipeline: Stage still runs despite --no-X flag
Check the run.json in the log directory:
```bash
cat logs/<run-id>/run.json | jq '.pipeline'
```
Should show:
```json
{
  "qa": false,
  "review": true,
  "security": false,
  "documentation": true
}
```

### PR Feedback: "No feedback found"
- Ensure the PR has comments or reviews submitted
- Check that comments aren't from bots
- Verify `gh pr view --json` returns data

### PR Feedback: GitHub API rate limit
`gh` CLI has limits. Check:
```bash
gh api rate_limit
```

For GraphQL inline comments, the rate limit is separate and more generous.

---

## Cost Estimates

### Configurable Pipeline
- Skipping QA: Saves ~$0.20-0.50 (no test run + triage)
- Skipping review: Saves ~$0.30 (no diff analysis)
- Skipping security: Saves ~$0.25 (no audit)
- Skipping docs: Saves ~$0.15 (no changelog/PR generation)

**Total**: Disabling all optional stages saves ~$0.90-1.20 per task

### PR Feedback Loop
- Triage only: ~$0.10-0.30 (reads 1-10 comments)
- Post replies: Same cost (posting is free)
- Auto-rerun: Adds full factory run cost (~$2-8)

**Recommendation**: Use `--post-replies` without `--auto-rerun` for first iteration review, then manually decide whether to rerun.
