# Try the factory without GitHub - and, for most of it, without a model

This folder builds a small **demo world** and opens the real Studio on it, so you can click through what the factory
does around pull requests - a checkout per task, a project split into phases, review comments that belong to a later
phase - without touching your repositories, your run history, your Studio settings or GitHub.

```bash
demo/setup.sh          # about ten seconds, no model: builds the world and seeds a scenario
demo/start-studio.sh   # builds the Studio and opens it on the demo
```

If the Studio shows the **"Welcome Back"** login screen instead of the app, your Claude session has expired: run
`claude login` (it lasts roughly a day). To look around without a model, start it with
`DEMO_NO_MODEL=1 demo/start-studio.sh` - everything works except what calls a model (marked **MODEL** below), which
fails with an authentication error.

## What it touches

Nothing of yours. Everything lives in `$DEMO_DIR` - by default `demo/.world`, which git ignores and a reboot does not
clear (not `/tmp`, which it does: the checkouts, and any work in them, would go with it). `DEMO_DIR=/some/folder
demo/setup.sh` puts it elsewhere; `setup.sh` warns if that is under the temporary folder:

| | |
|---|---|
| `workspace/demo-app` | a small repository - the thing the factory works on |
| `origin.git` | its "GitHub": a bare repository. Pushes go here. |
| `demo/bin/gh` | a **pretend `gh`**, found only through the PATH the demo scripts set. It answers what the factory asks (view, diff, create, comment, merge, review threads) and does the git side for real. Nothing goes to the network. |
| `logs/` | the factory's run records and project database |
| `userdata/` | the Studio's settings, so yours are never read or written |
| `gh-calls.log` | what the factory asked the pretend GitHub - useful when something looks odd |

`setup.sh` only ever replaces a folder it made itself (a `.factory-demo` marker); it refuses anything else.

The demo world is inside this repository, which has a `node_modules`: a checkout below it would find that folder's
packages. That is harmless for `demo-app` (it has no dependencies, by design) and is why the world is not a place for a
project that does have some - see "Where a task works" in `factory/README.md`.

**Adding a repository of yours.** The Studio takes any folder (a git repository) - the factory is told which ones you
added, wherever they are - so you can look at your own project in the demo. Look only: a task on it runs in a checkout
under `$DEMO_DIR`, and your folder is not touched, but **Push** at the delivery gate pushes the task's branch to that
repository's own `origin` (only the pull request is pretend, made by the pretend `gh`).

## The seeded scenario (no model was used to make it)

* **Project "Redesign the frontend"**, four phases. Phase 1 is task **f0001**: a real git worktree with two real
  commits, pull request **#8** under review. Its two run records are real runs of an earlier UI refactor (kept in
  `fixtures/`), re-pointed at this world - their pipelines are real, the code in the checkout is a small stand-in.
* The reviewer's four comments on #8 and the triage of them: a defect, a request the roadmap covers (phase 2), a
  request no phase covers, and a question.
* Task **f0002** ("Add a percent formatter"), pull request **#9**: two comments, only to answer.
* Task **f0003** ("Add a changelog"), pull request **#10**: nothing to answer - the one to approve and merge.

Each task is in its own checkout under `$DEMO_DIR/workspace/.factory/worktrees/demo-app/`. Nothing starts by itself: the Studio
is set to watch, but not to triage or start rounds automatically, so you press the buttons.

## Playing the reviewer

In a shell of its own (it puts the pretend `gh` first on PATH):

```bash
source demo/env.sh
demo-review list
demo-review show 8                              # the comments, and what the factory said on them
demo-review comment 10 "Please also mention the date."
demo-review thread 10 CHANGELOG.md 3 "Say what is in review."
demo-review close 9                             # as in the browser
demo-review merge 10                            # squash-merge ON GITHUB, not through the Studio
```

The factory CLI works on the demo from the same shell: `cd factory && npm run factory -- list`.

## What to try

Each step says what to do and what you should see. **MODEL** = needs a valid Claude login.

### 1. First look

* The sidebar shows `demo-app` with an orange badge **6** (comments waiting).
* **Run History**: "Design tokens and dark mode" with a purple line "Phase 1 of 4 · Redesign the frontend" and "2 rounds
  · review comments were addressed on the same pull request", its second round nested under it, and two plain tasks.
* **Pull requests**: "Watching 3 open pull requests · 2 need attention". #8 is **Choose where it goes**, #9 **Triaged**,
  #10 **Up to date**. Every card has a green **Isolated worktree** badge with a folder, *Copy path* and *Open folder*.
* **Projects**: "Redesign the frontend - 0 of 4 delivered": phase 1 *In review* (pull request #8); phases 2-4 *Planned*,
  each with an amber "It builds on phase N (...), which is not merged yet". "Backlog: 3 things seen on the way".
* **New task form**: "Where should it work?" with *Isolated worktree (recommended)* selected and the folder it would get;
  *My repository*; "Phases: Let the architect decide".

### 2. Settings

* **Where tasks work** shows *An isolated worktree (recommended)*; **Compare the roadmap with what a phase delivered**
  is ticked.
* **Workspace** and **Where worktrees are kept** each say "In use now: ..." - what the factory really uses, both under
  the demo world. The workspace adds "FACTORY_WORKSPACE_ROOT is set where the Studio was started, so this field is not
  used": the demo scripts decide it. The checkouts field is empty, so its folder is the default inside the workspace.
  In your own Studio the fields apply, and a checkouts folder under `/tmp` is flagged in words.
* **Checkouts -> Show them** (it is read on demand): the three tasks, each with its pull request ("#8 open"), folder and
  branch, and a *Remove* button. *Cancel* closes it.

### 3. Review comments about a later phase (#8)

1. The card says "2 comments ask for something that belongs to a later phase. Choose where each goes." and shows a
   purple box: "Nothing starts until you say where each goes." It offers no *Start round* yet.
2. **Defer to phase 2: Screens** on "Make the settings page dark too..." -> "1 comment asks for something...". In
   Projects, phase 2 gains "Asked for in review of an earlier phase: Make the settings page dark too. ... - from the
   review of pull request #8".
3. On "Could you add a keyboard shortcut...", either **Make it a phase of its own** -> a new phase "5. Keyboard shortcut
   for the theme toggle" (the title the triage proposed), waiting for phase 4, with the request under it; or **Do it in
   this pull request** -> no new phase; the comment stays for the next round.
4. When both are decided the chip becomes *Triaged* and the card says "1 comment needs code changes - start a round to
   address them." (the defect; "2 comments need..." if you chose *Do it in this pull request*). The pills list only
   what is still open.
5. `demo-review show 8` -> "what the factory said": "Noted. This is not part of this pull request; it goes to phase 2
   of the roadmap ("Screens"), where it will be planned." (and the one about the new phase). Nothing else was said.
6. **Answer 1 question on GitHub** -> the button and the "question" pill go; `demo-review show 8` shows the answer.
7. **MODEL** - **Start round 3** runs a round that plans in what you chose to do here. Without a model: "Could not
   start the round: Authentication required. Please log in to Claude CLI."

### 4. Questions only (#9)

**Answer 2 questions on GitHub** -> the card becomes "No unhandled review comments." and asks "Do you approve this pull
request?".

### 5. Where a task works - the run screen

Open "Add a percent formatter" from the history. At the top: **Isolated worktree**, the branch, the folder, and *Copy
path*, *Open folder*, *Check out here*, *Remove worktree*.

* *Copy path* -> "Path copied." (paste it somewhere to be sure). *Open folder* opens it in your file manager.
* `echo wip > <that folder>/ui/scratch.txt`, leave the run and open it again -> "1 file with changes not committed".
* **Remove worktree** -> *Remove* -> red: "The checkout at ... has 1 file with changes that are not committed, so it
  was kept." and a second question **Remove it anyway?** that says "Removing it throws them away". Cancel keeps it;
  **Remove and lose the changes** removes the folder: "The checkout is gone ..." and "The work is on the branch:
  git checkout factory/f0002/feat-percent-formatter in your repository". The branch is still there (`git branch`), and
  the #9 card says "(removed - made again when a round needs it)".

### 6. "Check out here" (task f0003, "Add a changelog")

Press **Check out here** -> *Check it out*, three times:

1. with an uncommitted file in the task's folder -> "...has 1 file with changes that are not committed, and they cannot
   come along. Commit or discard them there first." Nothing moved.
2. with an uncommitted edit in `workspace/demo-app` itself (say, to `README.md`) -> "Your repository has changes that are
   not committed. Commit or stash them, then try again: the branch will be checked out over them." Your edit is
   untouched.
3. with both clean -> "Your repository is now on factory/f0003/docs-changelog. The task's own folder was removed." and
   no "git checkout" hint. `git -C <demo-app> branch --show-current` agrees.

### 7. Merging in the Studio

* **#10** (do 6 first to see the tidy): *Yes - I reviewed it...* -> *Merge with squash...* -> a message form with the
  subject "docs: add a changelog (#10)". Without a model it says "The AI could not write the message (...). This is the
  pull request's own title and summary instead - edit it if you like." **Squash and merge** -> a green notice:
  "Squashed into main as ...", "Deleted the branch ... on GitHub.", "Your working copy is back on main, up to date with
  GitHub." (after 6) or "main on GitHub now has the merged change; your local main does not yet. Your repository was
  not touched - pull when you want it." (otherwise), "Deleted the local branch ...". **No sentence about phases or a
  project**: it is a one-off task.
* **#8** needs no open comments: **Dismiss comments** (or, with a model, run the round). Then approve and merge. The
  notice adds "Phase 1 of N of Redesign the frontend is delivered. Phase 2 ("Screens") is next - start it from the
  roadmap below." The task's folder is gone (`git worktree list`). In Projects: "1 of N delivered"; phase 1 is
  *Delivered*. **MODEL**: a summary of what it delivered (and notes on later phases that it already did part of).
  Without a model: "Not compared with the rest of the roadmap yet.", the reason in amber, and **Compare with the
  roadmap** to try again. Phase 2 shows **Start phase 2** and the request you deferred.
* **MODEL** - **Start phase 2** opens a run named "Screens", planned with that request. Without a model: "Authentication
  required. Please log in to Claude CLI." in the Projects panel.

### 8. The reviewer acts in the browser (run `setup.sh` again first)

* `demo-review close 8`, `demo-review close 9`, then **Check now**: both cards go; their clean checkouts are removed
  (the branches stay); phase 1 is *Planned* again with an amber "Pull request #8 was closed without being merged, so
  this phase is waiting again. Run it again, or skip it." and **Start phase 1**.
* (Again after `setup.sh`) `demo-review merge 8`, `demo-review merge 10`, **Check now**: the cards go, no merge notice
  (you did not merge it), "1 of 4 delivered", the checkouts removed.

### 9. With a model (after `claude login`)

1. **A task in its own folder.** Type a small task in the form, e.g. *Add a farewell(name) function to ui/src/lib/format.js
   that returns "Goodbye, <name>!", with a test*, and **Run Factory**. The run opens with "Preparing the working copy..."
   and then **Isolated worktree**, a new folder (`f0004`), its branch. While it runs, `git status` in `workspace/demo-app`
   stays clean and on `main`, and you can edit files there.
2. **Two at once.** Start a second task while the first runs: it starts (it is not blocked). Choosing **My repository**
   blocks a task only while another run is using the repository itself.
3. **The delivery gate.** *Push* -> the pretend GitHub opens the next pull request (#11) and its card appears. *Keep
   local* -> nothing is published; for a phase of a project, the phase returns to the roadmap with an amber note saying
   so.
4. **A big request.** Choose **Plan in phases** and ask for something large (a todo manager with storage, a CLI, tags,
   exports and docs). A new project appears in *Projects*, and the pull request's text has a **Roadmap** section.
5. **The review loop.** `demo-review comment 11 "..."`, **Read the comments**: a request for something beyond the pull
   request appears as a question about where it goes (3); a defect makes a round.
6. **Merge, then the next phase** (7), including the summary of what the phase delivered.
