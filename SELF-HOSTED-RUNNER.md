# Self-Hosted Runner Setup for PR Feedback Loop

This guide walks through setting up a self-hosted GitHub Actions runner that uses your Claude Pro subscription instead of API credits.

---

## Why Self-Hosted?

**Benefits**:
- Uses your $20/month Pro subscription (no per-run costs)
- Unlimited PR feedback triage within subscription limits
- Full control over the environment

**Tradeoffs**:
- Requires a machine running 24/7 (VPS, home server, or spare laptop)
- You maintain the runner and its dependencies
- Uses your Pro subscription quota (same pool as your interactive usage)

---

## Prerequisites

- A machine running Linux, macOS, or Windows (minimum 2GB RAM, 2 CPU cores)
- Admin access to your GitHub repository
- A Claude Pro subscription ($20/month)

---

## Step 1: Set Up the Machine

### Option A: Cloud VPS (Recommended for Production)

Choose a cheap VPS from any provider:
- **DigitalOcean Droplet**: $6/month (1GB RAM)
- **Hetzner Cloud**: €4.5/month (2GB RAM)
- **Linode Nanode**: $5/month (1GB RAM)
- **Oracle Cloud Free Tier**: Free (1GB RAM ARM instance)

Create an Ubuntu 22.04 or 24.04 instance and SSH in.

### Option B: Local Machine

Use a spare laptop, Raspberry Pi, or desktop that can run 24/7.

---

## Step 2: Install Dependencies

### On Ubuntu/Debian:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 22 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install git and build tools
sudo apt-get install -y git build-essential

# Install GitHub CLI
(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
&& sudo mkdir -p -m 755 /etc/apt/keyrings \
&& wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
&& sudo apt update \
&& sudo apt install gh -y

# Install Claude CLI (via npm)
sudo npm install -g @anthropic-ai/claude-cli

# Verify installations
node --version   # should be v22.x
git --version
gh --version
claude --version
```

### On macOS:

```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install dependencies
brew install node@22 git gh

# Install Claude CLI
npm install -g @anthropic-ai/claude-cli

# Verify installations
node --version
git --version
gh --version
claude --version
```

---

## Step 3: Authenticate Claude CLI

```bash
# Log in with your Claude Pro account
claude auth login

# Follow the prompts to authenticate in your browser
# This stores credentials in ~/.config/claude/ (Linux/macOS)
```

**Test it works**:
```bash
echo "What is 2+2?" | claude --no-prompt
```

You should see Claude respond.

---

## Step 4: Set Up GitHub Actions Runner

### 4.1: Create a Runner

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Actions** → **Runners**
3. Click **New self-hosted runner**
4. Choose your OS (Linux, macOS, or Windows)
5. Follow the download and configuration commands shown

**Example for Linux**:
```bash
# Create a folder for the runner
mkdir -p ~/actions-runner && cd ~/actions-runner

# Download the latest runner package
curl -o actions-runner-linux-x64-2.319.1.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-x64-2.319.1.tar.gz

# Extract the installer
tar xzf ./actions-runner-linux-x64-2.319.1.tar.gz

# Configure the runner
./config.sh --url https://github.com/YOUR_USERNAME/YOUR_REPO --token YOUR_TOKEN

# When prompted:
# - Runner name: factory-runner (or any name)
# - Runner group: Default
# - Labels: self-hosted,Linux,X64 (defaults are fine)
# - Work folder: _work (default is fine)
```

### 4.2: Install as a Service (Recommended)

This ensures the runner starts automatically on boot:

**Linux (systemd)**:
```bash
cd ~/actions-runner
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

**macOS (launchd)**:
```bash
cd ~/actions-runner
./svc.sh install
./svc.sh start
./svc.sh status
```

**Manual start** (for testing):
```bash
cd ~/actions-runner
./run.sh
```

---

## Step 5: Clone and Set Up the Factory

The runner needs the factory repository to execute the `pr-feedback` command.

```bash
# Clone the factory (in your home directory or wherever)
cd ~
git clone https://github.com/YOUR_USERNAME/agent-software-factory.git
cd agent-software-factory/factory

# Install dependencies
npm ci --ignore-scripts

# Verify the factory CLI works
npm run factory -- --help
```

**Update the workflow** to point to your local factory clone:

In your target repo's `.github/workflows/factory-pr-feedback.yml`, change:

```yaml
- name: Check out the factory
  if: steps.pr.outputs.is_factory == 'true'
  uses: actions/checkout@v4
  with:
    repository: ${{ vars.FACTORY_REPOSITORY || 'YOUR_USERNAME/agent-software-factory' }}
    path: .factory
    ref: ${{ vars.FACTORY_REF || 'master' }}
```

Or, **skip the checkout step entirely** and use the pre-installed factory:

```yaml
- name: Triage the review feedback
  if: steps.pr.outputs.is_factory == 'true'
  working-directory: /home/YOUR_USER/agent-software-factory/factory
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    FACTORY_PROVIDER: 'claude-cli'
    FACTORY_NON_INTERACTIVE: 'true'
    FACTORY_ALLOW_PUSH: 'true'
    FACTORY_ALLOW_PR: 'true'
  run: |
    # Pull latest factory changes
    git pull origin master
    npm ci --ignore-scripts

    ARGS=(
      run factory -- pr-feedback
      --repo "$GITHUB_WORKSPACE"
      --pr "${{ steps.pr.outputs.number }}"
      --post-replies
    )
    if [[ "${{ inputs.auto_rerun || vars.FACTORY_AUTO_RERUN }}" == "true" ]]; then
      ARGS+=(--auto-rerun)
    fi
    npm "${ARGS[@]}"
```

---

## Step 6: Configure GitHub Repository Settings

### 6.1: Set Repository Variables

Go to **Settings** → **Secrets and variables** → **Actions** → **Variables**:

| Variable | Value | Description |
|----------|-------|-------------|
| `FACTORY_AUTO_RERUN` | `false` | Set to `true` to auto-rerun on every review (costs tokens) |

### 6.2: Verify Permissions

Go to **Settings** → **Actions** → **General** → **Workflow permissions**:
- ✅ Read and write permissions
- ✅ Allow GitHub Actions to create and approve pull requests

---

## Step 7: Test the Setup

### 7.1: Create a Test PR

```bash
cd /path/to/your/test/repo
git checkout -b factory/test-feedback
echo "// test change" >> README.md
git add -A
git commit -m "test: trigger PR feedback"
git push -u origin factory/test-feedback

gh pr create --draft --title "test: trigger PR feedback" --body "Testing self-hosted runner"
```

### 7.2: Add a Review Comment

On GitHub:
1. Go to the PR
2. Add a comment: "Can you explain this change?"
3. Submit as "Request changes"

### 7.3: Watch the Runner

On your self-hosted machine:
```bash
# If running as a service
sudo journalctl -u actions.runner.* -f

# If running manually
cd ~/actions-runner && ./run.sh
```

You should see:
```
Job started
Check out the target repository
Triage the review feedback
[factory] Starting pr-feedback workflow...
[factory] Feedback triage complete
Job completed
```

### 7.4: Verify the Output

Check the PR on GitHub - you should see a reply from the factory:
```
<!-- factory-reply: 12345 -->

This is a clarification question. The PM architect will address this in the next iteration.

**Category**: CLARIFICATION  
**Assigned to**: pm-architect  
**Action**: The factory will incorporate this into the follow-up task.
```

---

## Security Considerations

### Runner Isolation

- The runner has write access to your repositories
- Only run it on a trusted machine
- Don't share the machine with untrusted users

### Authentication

- The `claude` CLI stores credentials in `~/.config/claude/`
- Keep this directory secure (it's tied to your Pro account)
- The runner uses your Claude Pro quota - monitor usage

### Logs

- Factory logs are stored in `~/agent-software-factory/factory/logs/`
- They may contain sensitive repo details (code, diffs, prompts)
- Rotate or delete old logs periodically:

```bash
# Clean logs older than 30 days
find ~/agent-software-factory/factory/logs/ -type d -mtime +30 -exec rm -rf {} +
```

### Updates

Keep the runner updated:
```bash
cd ~/actions-runner
./config.sh remove  # Unregister old runner
# Download latest version from GitHub
./config.sh --url ... --token ...  # Re-register
sudo ./svc.sh install  # Reinstall service
sudo ./svc.sh start
```

---

## Troubleshooting

### Runner doesn't start
```bash
# Check service status
sudo systemctl status actions.runner.*

# View logs
sudo journalctl -u actions.runner.* --no-pager
```

### Claude authentication fails
```bash
# Re-authenticate
claude auth logout
claude auth login

# Test
echo "Hello" | claude --no-prompt
```

### Factory not found
```bash
# Verify factory is cloned and installed
ls -la ~/agent-software-factory/factory/
cd ~/agent-software-factory/factory && npm run factory -- --help
```

### GitHub API rate limit
The runner uses `gh` CLI with `GITHUB_TOKEN`. Check rate limit:
```bash
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/rate_limit
```

For more quota, create a Personal Access Token (classic) with `repo` scope and store it as a secret `GH_PAT`, then use `GH_TOKEN: ${{ secrets.GH_PAT }}` in the workflow.

---

## Cost Analysis

### Infrastructure
- **VPS**: $5-6/month
- **Electricity** (local machine): ~$2-5/month

### Claude Usage
- **PR feedback triage**: Counts against your Pro subscription
- **Pro limits**: ~500k tokens/month included
- **Typical PR feedback**: 2k-10k tokens per triage
- **Estimate**: ~50-250 PR reviews/month within Pro limits

**Total cost**: $5-11/month (VPS + subscription)

Compare to API-based:
- **API credits**: ~$0.10-0.50 per triage
- **50 reviews/month**: $5-25 in API costs
- **Total**: $5-25/month (API only, no subscription)

**Recommendation**: Self-hosted is cheaper if you review >10 PRs/month.

---

## Maintenance Checklist

**Weekly**:
- [ ] Check runner is online: GitHub Settings → Actions → Runners
- [ ] Verify logs are rotating (not filling disk)

**Monthly**:
- [ ] Update runner: `cd ~/actions-runner && ./config.sh remove && ./config.sh --url ...`
- [ ] Update factory: `cd ~/agent-software-factory && git pull && npm ci`
- [ ] Update dependencies: `sudo apt update && sudo apt upgrade -y` (Linux)

**As Needed**:
- [ ] Clean old logs: `find ~/agent-software-factory/factory/logs/ -mtime +30 -exec rm -rf {} +`
- [ ] Re-authenticate Claude if session expires: `claude auth login`

---

## Next Steps

Once the runner is working:

1. **Enable auto-rerun** (optional): Set `FACTORY_AUTO_RERUN=true` to automatically kick off follow-up factory runs when reviews have actionable feedback

2. **Add to other repos**: Copy the workflow file to any repo where you want PR feedback automation

3. **Scale up**: Add more runners to handle concurrent PRs across multiple repos

4. **Monitor**: Set up alerts for runner downtime (GitHub has built-in runner health checks)

---

## Alternative: Docker-Based Runner

For easier updates and isolation, run the runner in Docker:

```bash
docker run -d \
  --name factory-runner \
  --restart unless-stopped \
  -e REPO_URL=https://github.com/YOUR_USERNAME/YOUR_REPO \
  -e RUNNER_TOKEN=YOUR_TOKEN \
  -v /home/runner/.config/claude:/root/.config/claude \
  -v /home/runner/agent-software-factory:/root/agent-software-factory \
  myoung34/github-runner:latest
```

(This requires building a custom image with Node.js, gh, and claude CLI pre-installed)

---

**Questions?** Open an issue in the factory repo or check the logs in `~/agent-software-factory/factory/logs/`.
