# AI Factory Studio

A multi-agent software factory with desktop UI for autonomous code generation, testing, and delivery.

## Project Structure

This is a monorepo containing two packages:

```
agent-software-factory/
├── factory/          # Multi-agent backend (TypeScript/Node)
│   ├── src/          # Workflow, agents, tools
│   ├── global-rules/ # Coding conventions
│   └── README.md     # Full backend documentation
│
├── studio/           # Desktop UI (Electron + React)
│   ├── electron/     # Main process
│   ├── src/          # React renderer
│   └── package.json
│
└── logs/             # Shared run logs and traces
```

## Quick Start

### Factory CLI (Backend)

```bash
# Install dependencies
npm install --workspace=factory

# Run a task
cd factory
npm run factory -- run \
  --repo ~/workspace/my-project \
  --task "Add dark mode with system theme support"

# See full documentation
cat factory/README.md
```

### Studio (Desktop UI)

```bash
# Install dependencies  
npm install --workspace=studio

# Run in development mode
npm run dev:studio

# Build desktop app
npm run build:studio
```

## Features

### Factory Backend
- 7 specialized agents (PM, Developer, QA, Triage, Security, Review, Documentation)
- Monorepo-aware stack detection
- Suspend/resume on ambiguity
- Full observability (logs, traces, events)
- Multi-provider LLM support (Claude CLI, API keys)

### Studio UI
- Every run is named by a cheap AI step (the first stage) and can be renamed with a double-click
- Real-time agent activity: each step shows what its agent is doing (files read and edited, searches, what it says, the model) as it happens
- Automatic retry of a run stopped by Claude's usage limit, once the limit resets (countdown, retry now, cancel)
- Multi-repo tabs with parallel runs
- Integrated diff viewer
- Settings management (global + per-repo)
- Auto-login for Claude CLI
- Dark/light/system themes

## Requirements

- Node.js 20+
- Git
- Claude Code CLI (`claude`) for subscription-based auth (optional)
- Anthropic API key (optional, alternative to CLI)

## Documentation

- **Factory:** See `factory/README.md` for the multi-agent system architecture, safety model, and CLI usage
- **Studio:** UI features and keyboard shortcuts (coming soon)
- **Try it without GitHub:** `demo/README.md` - a small demo world (a project in phases, pull requests with review
  comments, a checkout per task) and a pretend GitHub, so you can click through the Studio without touching your
  repositories: `demo/setup.sh`, then `demo/start-studio.sh`

## Development

```bash
# Install all dependencies
npm run install:all

# Type-check both packages
npm run typecheck

# Run factory backend
npm run dev:factory

# Run studio desktop app
npm run dev:studio
```

## License

MIT
