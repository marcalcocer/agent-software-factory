#!/usr/bin/env bash
# Builds the factory demo from nothing, in $DEMO_DIR (default: /tmp/factory-demo):
#
#   workspace/demo-app   a small repository - the thing the factory works on
#   origin.git           its "GitHub": a bare repository, plus the pretend gh in demo/bin
#   logs/                the factory's run records and project database
#   userdata/            the Studio's settings (so your own are never touched)
#
# and, unless you pass --empty, a SEEDED scenario that needs no model: a project of four phases whose first
# phase is a pull request under review (with a reviewer's comments waiting), and a second, plain task with its
# own pull request - each in a real git worktree. Running it again starts over.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SEED=1
[ "${1:-}" = "--empty" ] && SEED=0

# Only ever replace a world this script made.
if [ -e "$DEMO_DIR" ]; then
  if [ ! -f "$DEMO_DIR/.factory-demo" ]; then
    echo "$DEMO_DIR already exists and was not made by this script (no .factory-demo marker), so it is left alone." >&2
    echo "Pick another place with: DEMO_DIR=/some/folder demo/setup.sh" >&2
    exit 1
  fi
  # Checkouts of a world that is about to be replaced must not stay registered anywhere: they live inside it.
  rm -rf "$DEMO_DIR"
fi
mkdir -p "$DEMO_DIR/workspace" "$DEMO_DIR/logs" "$DEMO_DIR/userdata"
touch "$DEMO_DIR/.factory-demo"

REPO="$DEMO_DIR/workspace/demo-app"
ORIGIN="$DEMO_DIR/origin.git"

git init -q --bare -b main "$ORIGIN"
mkdir -p "$REPO/ui/src/lib" "$REPO/ui/src/pages" "$REPO/ui/test" "$REPO/ui/node_modules/left-pad"
cd "$REPO"
git init -q -b main
git config user.name "Demo Developer"
git config user.email "demo@example.com"

cat > AGENTS.md <<'EOT'
# Project rules

- JavaScript, ES modules, no dependencies: do not add any package.
- Tests use `node:test` and `node:assert/strict`, in `ui/test/`, named `<module>.test.js`.
- Keep modules small: one responsibility per file in `ui/src/`.
EOT
cat > README.md <<'EOT'
# demo-app

A tiny front end used to try the software factory. Run its tests with `npm test` in `ui/`.
EOT
printf 'node_modules/\n.env\n' > .gitignore
cat > ui/package.json <<'EOT'
{
  "name": "demo-ui",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOT
cat > ui/package-lock.json <<'EOT'
{
  "name": "demo-ui",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": { "": { "name": "demo-ui", "version": "1.0.0" } }
}
EOT
cat > ui/src/index.js <<'EOT'
export { money } from './lib/format.js';
export { investmentPage } from './pages/investment.js';
export { settingsPage } from './pages/settings.js';
EOT
cat > ui/src/lib/format.js <<'EOT'
/** Formats an amount of money: 1234.5 -> "$1,234.50". */
export function money(amount) {
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
EOT
cat > ui/src/pages/investment.js <<'EOT'
export function investmentPage(name = 'Savings') {
  return `<main class="bg-white text-slate-900"><h1>Investment: ${name}</h1></main>`;
}
EOT
cat > ui/src/pages/settings.js <<'EOT'
export function settingsPage() {
  return '<main class="bg-white text-slate-900"><h1>Settings</h1></main>';
}
EOT
cat > ui/test/format.test.js <<'EOT'
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { money } from '../src/lib/format.js';

test('money groups thousands and keeps two decimals', () => {
  assert.equal(money(1234.5), '$1,234.50');
});
EOT
cat > ui/test/pages.test.js <<'EOT'
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { investmentPage } from '../src/pages/investment.js';
import { settingsPage } from '../src/pages/settings.js';

test('the investment page names the investment', () => {
  assert.match(investmentPage('Savings'), /Investment: Savings/);
});

test('the settings page has a title', () => {
  assert.match(settingsPage(), /<h1>Settings<\/h1>/);
});
EOT
# What an installed project has: dependencies git ignores. A task's checkout links them instead of installing.
echo '{"name":"left-pad","version":"1.3.0"}' > ui/node_modules/left-pad/package.json

git add -A
git commit -q -m "chore: initial commit"
git remote add origin "$ORIGIN"
git push -q -u origin main
(cd ui && npm test --silent >/dev/null) || { echo "The demo repository's own tests fail - something is wrong with this setup." >&2; exit 1; }

# The Studio's settings, in its own user-data folder.
node -e '
  const [dir] = process.argv.slice(1);
  const settings = {
    global: {
      theme: "light", workspaceRoot: `${dir}/workspace`, defaultMaxAttempts: 3, dryRunByDefault: false, logLevel: "info",
      activeProvider: "claude-cli", savedRepositories: [{ name: "demo-app", path: `${dir}/workspace/demo-app` }],
    },
    repos: {},
    // Nothing starts by itself: you press the buttons. Replies go to the pretend GitHub, where you can read them.
    prWatch: { enabled: true, intervalSeconds: 30, autoTriage: false, autoRevise: false, replyOnGitHub: true },
  };
  require("node:fs").writeFileSync(`${dir}/userdata/settings.json`, JSON.stringify(settings, null, 2));
' "$DEMO_DIR"

if [ "$SEED" = 1 ]; then
  echo "Seeding the scenario (no model is used)..."
  (cd "$DEMO_ROOT/factory" && npx --no-install tsx "$HERE/seed.mts")
fi

echo
echo "The demo is ready in $DEMO_DIR"
echo "  Start the Studio on it:   demo/start-studio.sh"
echo "  Play the reviewer:        source demo/env.sh   (in a shell of its own), then: demo-review help"
echo "  What to try:              demo/README.md"
