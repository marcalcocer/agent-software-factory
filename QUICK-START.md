# Quick Start: New Features

Two new features are ready to use:

## 1. ⚙️ Per-Task Configurable Pipeline

Skip optional quality gates to save time and tokens.

### CLI
```bash
cd factory

# Skip QA and security (saves ~$0.50 per task)
npm run factory -- run \
  --repo /path/to/your/repo \
  --task "Add logging to user service" \
  --no-qa \
  --no-security
```

### Studio UI
```bash
cd studio
npm run dev
```
1. Add repo → Enter task
2. Expand **Pipeline** section
3. Toggle off unwanted stages (QA, Review, Security, Docs)
4. Click **Run Task**

**Available flags**: `--no-qa`, `--no-review`, `--no-security`, `--no-docs`

---

## 2. 🔁 PR Feedback Loop

Triage GitHub PR review comments and auto-generate replies.

### CLI (Local Testing)

**Read-only** (no replies posted):
```bash
npm run factory -- pr-feedback \
  --repo /path/to/your/repo \
  --pr 123
```

**With replies** (visible to reviewers):
```bash
npm run factory -- pr-feedback \
  --repo /path/to/your/repo \
  --pr 123 \
  --post-replies
```

**With auto-rerun** (starts a new factory run):
```bash
npm run factory -- pr-feedback \
  --repo /path/to/your/repo \
  --pr 123 \
  --post-replies \
  --auto-rerun
```

### Studio UI
```bash
cd studio
npm run dev
```
1. Select repo → Expand **PR Feedback** section
2. Enter PR number
3. Check **Post replies** (optional)
4. Check **Auto-rerun** (optional)
5. Click **Triage Feedback**

### GitHub Actions (Automatic)

Set up a self-hosted runner to automatically triage every PR review:

```bash
# See SELF-HOSTED-RUNNER.md for full setup
# Quick version:

# 1. Install dependencies on your runner machine
sudo apt update && sudo apt install -y nodejs git gh
npm install -g @anthropic-ai/claude-cli
claude auth login

# 2. Set up GitHub Actions runner
mkdir ~/actions-runner && cd ~/actions-runner
# Follow GitHub's setup instructions in Settings → Actions → Runners

# 3. Clone factory
git clone https://github.com/YOUR_USERNAME/agent-software-factory.git
cd agent-software-factory/factory && npm ci

# 4. Copy workflow to target repo
cp factory/templates/github-actions/factory-pr-feedback.yml \
   /path/to/your/repo/.github/workflows/
```

---

## Testing Checklist

- [ ] **Configurable pipeline**: Run with `--no-qa` and verify QA step shows "Stage disabled"
- [ ] **Studio UI**: Toggle pipeline stages and run a task
- [ ] **PR feedback (read-only)**: Run `pr-feedback --pr N` without posting replies
- [ ] **PR feedback (with replies)**: Run with `--post-replies` and check GitHub PR
- [ ] **Self-hosted runner**: Set up runner and test with a review comment (optional)

---

## Documentation

- **Detailed testing guide**: `TESTING-NEW-FEATURES.md`
- **Self-hosted runner setup**: `SELF-HOSTED-RUNNER.md`
- **Original README**: `README.md`

---

## Cost Summary

| Feature | CLI | Studio UI | GitHub Actions (Self-Hosted) |
|---------|-----|-----------|------------------------------|
| **Configurable pipeline** | Free (skip stages = save tokens) | Free | N/A |
| **PR feedback (read-only)** | ~$0.10-0.30/triage | ~$0.10-0.30/triage | N/A |
| **PR feedback (with replies)** | ~$0.10-0.30/triage | ~$0.10-0.30/triage | Included in Pro subscription |
| **PR feedback (auto-rerun)** | +$2-8 for full run | +$2-8 for full run | +$2-8 for full run |

**Self-hosted runner cost**: $5-6/month (VPS) + $20/month (Claude Pro, already required)

---

## What's Next?

1. **Try it locally**: Test both features with CLI first
2. **Use Studio UI**: Get comfortable with the visual interface
3. **Set up self-hosted runner**: Automate PR feedback (optional, requires VPS/local machine)
4. **Iterate**: Adjust pipeline configs per task, monitor token usage

**Questions?** Check the detailed guides or open an issue.
