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
# 3. Kick off a factory run with the follow-up task, on the pull request's own branch
#    (the new commit updates the PR - it does not open a second one)
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

1. Open a repository whose pull request was opened by the factory
2. The **Pull requests** panel lists what it is watching ("Watching 1 open pull request - checked 20 s ago")
3. Leave a comment on the pull request on GitHub (a conversation comment, or an inline one)
4. Within the check interval (1 minute by default; **Check now** to skip the wait) the PR shows up as
   *New comments*, and the repository gets a badge in the sidebar
5. With the automatic steps on, the comments are classified by themselves; if they ask for code changes a
   **round** starts and appears in the run history nested under the original task ("Round 2 of this task")
6. When the round reaches the delivery gate, approve the push: the existing pull request is updated
7. Start a review but do not submit it: your draft comments are ignored. Submit it, and they are detected on the next check
8. Open **Settings → Pull requests** (sidebar) to change the interval or the automatic steps, globally or per repository
9. When a round reuses the plan, open it: the PM Architect step is marked *skipped* with the reason

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

## Feature 3: Merging a Pull Request, and Tasks That No Longer Stack

Two things were added together: the **Pull requests** panel can merge a pull request (after you
approve it), and a new task never starts from a branch the factory made for an earlier one.

### A. Stacking fix (no tokens, no GitHub)

The problem it fixes: after a run, the factory leaves its branch checked out; the next task used to be
cut from it, so its pull request contained the previous task's commits too.

1. In a test repository, leave the working copy on a `factory/...` branch that has commits
   `master` does not (this is what any finished run leaves behind):
   ```bash
   git -C <repo> checkout factory/<some-earlier-task>
   git -C <repo> log --oneline master..HEAD        # shows the earlier task's commit(s)
   ```
2. Start a new task from the Studio (or `run --repo <repo> --task "..." --dry-run` for a free check of the
   choice, which only records it).
3. Look at the run's events - it says where it started from and why:
   ```bash
   grep base_branch_chosen factory/logs/<run-id>/events.ndjson
   # "Started from master instead of factory/<some-earlier-task>: ... would carry its commits ..."
   ```
4. For a real (non-dry) run, once the branch exists: **`git -C <repo> log --oneline master..HEAD` must show
   only this task's own commits** - nothing from the earlier task. (Before the fix it showed both.)
5. A branch you made yourself is still respected: from `my-feature` (not `factory/...`, no pull request opened
   from it) the new branch is cut from `my-feature`.
6. After merging a pull request on GitHub (without the Studio), your local `master` is behind: a new task is
   still cut from GitHub's `master`, so it contains what was just merged. `git log --oneline -3` on the new
   branch shows the squash commit.

### B. Merging (Studio)

Needs a pull request the factory opened, with no unhandled review comments. Use a throwaway repository
the first time: **merging publishes** (a push to the default branch can trigger a deploy).

1. Open the repository in the Studio. Every open pull request is a card. One with no comments says
   *"Do you approve this pull request?"* and offers only **"Yes - I reviewed it and I have no comments"**.
   There is no merge button yet.
2. Click **Check now** if the PR is new. It must show no conflicts: with conflicts the card says
   *"It cannot be merged yet"* and offers nothing.
3. Click the approval button. The card shows **Approved**, the commit it applies to, and
   **Merge with squash...** (plus **Withdraw approval**).
4. *Approval is bound to a commit:* push anything to the PR branch (or let a round do it), then **Check now**.
   The card must go back to the question and say *"This pull request changed after you approved it"*.
5. Click **Merge with squash...**. After a few seconds a preview appears: *"Squash N commits into one on
   master"*, the size of the change, an editable **Subject** (ending in `(#<number>)`) and **Description**,
   and a ticked **Delete the branch ... after merging**.
   - The text should describe the final result, not the review back-and-forth ("address review feedback...").
   - Signed out of Claude (`claude login` needed)? The preview says so, shows the pull request's own title and
     summary instead, and offers **Try the AI again**. The merge still works.
6. Edit the subject if you like and click **Squash and merge**. Afterwards:
   - a green notice says *Merged #N* with the commit (a link) and what else happened;
   - on GitHub: one new commit on the base branch with exactly your message; the PR shows *Merged*;
     the branch is gone (if you left the box ticked);
   - locally: `git branch --show-current` is the base branch and `git status` is clean.
7. Cases to try:
   - uncommitted changes in the working copy -> merged, but the notice says the working copy stayed where it
     was and why (your changes are untouched);
   - a run still going in that repository -> same: merged, working copy left alone;
   - a new review comment on GitHub after approving, before merging -> refused: *"A review comment has arrived
     that nobody has dealt with yet"*.
8. **Dry run** (Settings -> dry run by default): the preview uses the plain title/summary (no model call) and
   **Squash and merge** reports *"Dry run - nothing was merged"* after checking everything.

Command-line equivalent (nothing is merged by the first two):
```bash
npm run factory -- pr-check --repo <repo>                                   # headSha, mergeBlockers, mergeWarnings
npm run factory -- pr-merge-draft --repo <repo> --pr N                      # PR_MERGE_DRAFT_JSON {subject, body, source, ...}
npm run factory -- pr-merge --repo <repo> --pr N --head-sha <sha> --subject="x (#N)" --dry-run
npm run factory -- pr-merge --repo <repo> --pr N --head-sha 0000000000000000000000000000000000000000 --subject="x"
#   -> refused: "The pull request changed after you approved it ..." (the approved commit must be the current one)
```

---

## Feature 4: The PR Writer (commit message and pull-request text)

The commit message, the pull-request title and the pull-request description used to be written by the
documentation agent. So a task that switched documentation off was published with the raw task text as its
title and a placeholder as its description. They now have their own mandatory agent, the **PR Writer**; the
documentation agent only decides whether the docs need updating.

### A. No tokens (dry run)

```bash
cd factory
npm run smoke        # 70 checks, including two scenarios for this:
                     #   documentation OFF            -> docs SKIPPED, PR writer COMPLETED, delivery uses its text
                     #   every optional stage OFF     -> the PR text still exists and says "not run" for all four
```

### B. In the Studio

1. Start a small task on a test repository with **Docs unchecked** (and, if you like, QA / Review / Security too).
2. Watch the pipeline strip: `... Docs ⊘ → PR Writer → Delivery`. The **PR Writer** node is always there and
   cannot be switched off.
3. Open the **PR Writer** node. It shows the **commit message**, the **pull-request title** and the
   **description** (with the labels), and says what was not shown to it (lockfiles are left out).
4. In the description, find **Quality gates**. For every stage you switched off it must read
   `not run (disabled for this task)`; for the others it shows the real result (QA: `PASS - 34 of 34 tests passed`).
   This section is written by the factory, not by the AI.
5. At the **delivery gate**, the commit message, title and description are the PR Writer's - not the raw task
   text and not a placeholder. Edit anything you like; push & open the pull request. On GitHub the title and
   description are exactly what the form showed.
6. `git log -1` on the branch: the commit message is the PR Writer's (it is no longer the planner's early guess,
   which was written before any code existed).
7. With **Docs on**, open the **Docs** node: it lists the documentation files it updated (or says
   "Nothing to do" with the reason) - and nothing about the pull request.

### C. When the AI cannot answer

This only happens if the model drops out at the very last step (a usage limit or an expired session right
after QA passed) - earlier steps would have failed first - so it is hard to provoke by hand. It is covered by
automated checks, and this is what you would see: the PR Writer node is marked **FALLBACK** ("Drafted without
the AI", with the reason), the delivery gate shows an amber note, and the form is filled with a real description
built from the run's reports (summary, changed files, QA commands, gates) instead of a placeholder. Nothing
blocks the delivery; read the text, edit it if you like, and continue.

### D. A round on an existing pull request

Comment on the pull request and let a round run. The PR Writer node is listed as **skipped** (amber ⊘): *"the
pull request already has its title and description"*. The round's commit message is the usual
`chore: address review feedback on PR #N (round R)`; the title and description on GitHub are left alone.

### Command line

```bash
npm run factory -- run --repo <repo> --task "..." --no-docs        # docs off; the PR writer still runs
ls factory/logs/<run-id>/ | grep 07-                                 # 07-documentation.json (SKIPPED) and 07-pr-writer.json
cat factory/logs/<run-id>/07-pr-writer.json | jq '.status, .data.pullRequest.title'
```

---

## GitHub Actions Integration (Self-Hosted Runner)

A template workflow is available at:
```
factory/templates/github-actions/factory-pr-feedback.yml
```

This workflow uses a **self-hosted runner** with your Claude Pro subscription (no per-run API costs).

### Quick Start

1. **Set up the runner**: Follow `SELF-HOSTED-RUNNER.md` for complete setup instructions
2. **Copy the workflow**: Place `factory-pr-feedback.yml` in your target repo at `.github/workflows/`
3. **Create a test PR**: Push a branch starting with `factory/` to trigger the workflow
4. **Add a review comment**: The runner will triage it and post a reply

### How It Works

The workflow triggers on:
```yaml
on:
  pull_request_review:          # Review summary (approve/request changes)
  pull_request_review_comment:  # Inline code comments
  issue_comment:                # Conversation comments on the PR
```

It only runs on:
- PRs with branches matching `factory/*` (factory-created branches)
- Comments not authored by bots (to prevent self-trigger loops)
- When the runner is online and idle

### Cost

- **Runner**: $5-6/month (VPS) or free (local machine)
- **Claude usage**: Counts against your Pro subscription (~2-10k tokens per triage)
- **Total**: No per-run cost, just the $20/month Pro subscription you already have

See `SELF-HOSTED-RUNNER.md` for full cost analysis and setup guide.

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

### PR Writer
- [ ] The PR Writer node is always in the pipeline and cannot be switched off (`--no-docs` only skips Docs)
- [ ] With Docs off, the delivery gate and the pull request on GitHub have a real title and description (not the raw task)
- [ ] The "Quality gates" section says `not run (disabled for this task)` for every switched-off stage
- [ ] The commit carries the PR Writer's message, not the planner's early draft
- [ ] Signed out of Claude: the step is FALLBACK, the gate shows a note, and the delivery still works
- [ ] A round on an existing pull request lists the PR Writer as skipped and leaves the title / description alone
- [ ] The Docs node lists the documentation files it updated, or says nothing needed updating

### Merging and Stacking
- [ ] A new task started while a `factory/...` branch is checked out is cut from the default branch (`git log master..HEAD` shows only its own commits)
- [ ] A pull request with no comments asks *"Do you approve this pull request?"*; there is no merge button before approving
- [ ] A pull request with conflicts says why it cannot be merged and offers no approval
- [ ] Pushing to the branch after approving makes the approval void (the question comes back)
- [ ] The squash message describes the final result and ends with `(#N)`; it can be edited before merging
- [ ] With Claude signed out, the message falls back to the PR title/summary and says so
- [ ] After merging: one new commit on the base branch, the branch deleted (if ticked), the working copy back on the base branch
- [ ] Uncommitted changes, or a run in progress, leave the working copy alone and the notice says why
- [ ] A review comment arriving after approval stops the merge

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
