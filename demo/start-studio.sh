#!/usr/bin/env bash
# Starts the real Studio (Electron) on the demo world made by demo/setup.sh - with its own settings folder, the
# demo's logs and workspace, and the pretend GitHub - so nothing of yours is touched.
#
#   DEMO_NO_MODEL=1     open the Studio without a Claude login: everything works except what calls a model
#                       (running a task, reading new comments, the AI's merge message, comparing the roadmap),
#                       which fails with an authentication error. Do not use it for those.
#   DEMO_SKIP_BUILD=1   do not rebuild the Studio first (it is rebuilt every time, so you test the current code)
#   DEMO_ELECTRON_FLAGS extra flags for Electron
#   DEMO_DEBUG_PORT     open Electron's remote-debugging port (for scripts that drive the window)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

if [ ! -f "$DEMO_DIR/.factory-demo" ] || [ ! -d "$DEMO_DIR/workspace/demo-app" ]; then
  echo "There is no demo in $DEMO_DIR yet: run demo/setup.sh first." >&2
  exit 1
fi

if [ "${DEMO_SKIP_BUILD:-}" != 1 ]; then
  echo "Building the Studio..."
  (cd "$DEMO_ROOT" && npm run -s build)
fi

if [ "${DEMO_NO_MODEL:-}" = 1 ]; then
  # The Studio shows its main screen when it finds a way to a model. This is not one: it only gets past the
  # login screen, and every model call then fails with an authentication error.
  export ANTHROPIC_API_KEY="demo-no-model"
  echo "No model: tasks, triage, the AI merge message and the roadmap comparison will fail. Everything else works."
fi

echo "Studio on the demo in $DEMO_DIR"
echo "The demo is for demo-app. Any folder can be added in the Studio, but a repository of yours added here is worked on for"
echo "real: its tasks run in checkouts under $DEMO_DIR (your folder is not touched), yet Push at the delivery gate pushes the"
echo "branch to that repository's own origin - only the pull request is pretend."
# shellcheck disable=SC2086
exec "$DEMO_ROOT/node_modules/electron/dist/electron" --no-sandbox ${DEMO_DEBUG_PORT:+--remote-debugging-port=$DEMO_DEBUG_PORT} ${DEMO_ELECTRON_FLAGS:-} \
  --user-data-dir="$DEMO_DIR/userdata" "$DEMO_ROOT/studio"
