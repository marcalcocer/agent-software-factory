# Sourced (not run) by the other demo scripts, and by you when you want the factory CLI to work on the demo:
#
#     source demo/env.sh && cd factory && npm run factory -- list
#
# It points the factory and the Studio at the DEMO world - never at your real workspace, run logs or settings -
# and puts the pretend `gh` in front of the real one. Source it in a shell of its own.

DEMO_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEMO_ROOT="$(cd "$DEMO_HERE/.." && pwd)"
export DEMO_DIR="${DEMO_DIR:-${TMPDIR:-/tmp}/factory-demo}"

export FACTORY_WORKSPACE_ROOT="$DEMO_DIR/workspace"
export FACTORY_LOG_DIR="$DEMO_DIR/logs"
export FACTORY_STORAGE_URL="file:$DEMO_DIR/logs/factory.db"
export FACTORY_PROVIDER=claude-cli
# Pushes go to the demo's own bare repository, and "pull requests" are made by the pretend gh.
export FACTORY_ALLOW_PUSH=true
export FACTORY_ALLOW_PR=true

export PATH="$DEMO_HERE/bin:$PATH"
