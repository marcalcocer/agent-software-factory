# Fixes: Timer, Artifacts, Retry Button, and PR Approval Gate

## Issues Fixed

### 1. ✅ Timer Showing 1,000+ Minutes (CRITICAL BUG)
**Problem**: For completed runs, the timer continued counting from `startedAt` to `Date.now()`, showing thousands of minutes for runs that finished hours/days ago.

**Root Cause**: The timer was always calculating elapsed time in real-time, even for non-running runs.

**Fix**: Modified `PipelineView.tsx` timer logic to use actual duration for completed runs:

```typescript
const updateElapsed = () => {
  if (!isRunning && finishedAt) {
    // For completed runs, show the actual duration
    const elapsed = Math.floor(
      (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000
    );
    setElapsedTime(elapsed);
  } else {
    // For running runs, calculate from now
    const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    setElapsedTime(elapsed);
  }
};
```

**Files Changed**:
- `studio/src/components/PipelineView.tsx` (lines 94, 103-104, 319-333)

---

### 2. ✅ "Waiting for Output" for All Steps (CRITICAL BUG)
**Problem**: Clicking on "Dev 1", "QA 1", etc. showed "Waiting for output..." even though artifacts were successfully created.

**Root Cause**: Artifact selection logic was broken. Agent nodes had IDs like `"developer-1"` but artifacts had `step: "developer"` and `attempt: 1`. The code was filtering by ID instead of matching step name + attempt number.

**Fix**: Updated artifact selection to properly match by step name and attempt:

```typescript
const selectedArtifact = selectedAgent
  ? (() => {
      const agentData = selectedAgentData;
      if (!agentData) return undefined;
      
      // Extract base step name (e.g., "developer" from "developer-1")
      const baseStep = agentData.id.replace(/-\d+$/, '');
      const attempt = agentData.attempt || 1;
      
      // Match by both step name and attempt number
      return artifacts.find(a => a.step === baseStep && a.attempt === attempt);
    })()
  : undefined;
```

**Files Changed**:
- `studio/src/components/PipelineView.tsx` (lines 645-658)

---

### 3. ✅ No Retry Button in Failed Run View
**Problem**: When viewing a failed run, there was no retry button in the main pipeline view (only in the RunHistory list).

**Fix**: Added retry button to the error banner:

1. Added `onRetry` prop to `PipelineViewProps`:
   ```typescript
   interface PipelineViewProps {
     runId: string | null;
     isRunning: boolean;
     onClose?: () => void;
     onRetry?: (runId: string) => void; // NEW
   }
   ```

2. Added retry button in error banner:
   ```tsx
   {onRetry && runId && (
     <button
       onClick={() => onRetry(runId)}
       className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
     >
       ▶ Retry Run
     </button>
   )}
   ```

3. Wired it up in `App.tsx`:
   ```tsx
   <PipelineView
     runId={viewingHistoryRunId}
     isRunning={false}
     onClose={() => setViewingHistoryRunId(null)}
     onRetry={handleResumeRun}  // NEW
   />
   ```

**Files Changed**:
- `studio/src/components/PipelineView.tsx` (lines 72-75, 87, 721-729)
- `studio/src/App.tsx` (line 553)

---

### 4. ✅ PR Approval Gate Not Showing (CRITICAL MISSING FEATURE)
**Problem**: The workflow was automatically creating PRs without asking for approval, even though the code had a delivery approval gate.

**Root Cause**: The `factory:run-task` IPC handler was setting `FACTORY_NON_INTERACTIVE: 'true'` as an environment variable, which disabled ALL human-in-the-loop gates including PR approval.

**The Issue**:
```typescript
const proc = spawn('node', [tsxPath, ...args], {
  env: {
    ...process.env,
    FACTORY_NON_INTERACTIVE: 'true', // ❌ This disabled the PR approval gate!
    FACTORY_PROVIDER: 'claude-cli',
  },
  cwd: factoryDir,
});
```

**The Fix**: Removed the `FACTORY_NON_INTERACTIVE` flag because Studio IS interactive:

```typescript
const proc = spawn('node', [tsxPath, ...args], {
  env: {
    ...process.env,
    // Studio IS interactive - it can show human input panels for approval gates
    // So we don't set FACTORY_NON_INTERACTIVE here
    FACTORY_PROVIDER: 'claude-cli',
  },
  cwd: factoryDir,
});
```

**How PR Approval Works Now**:
1. Factory completes all quality gates
2. Workflow suspends with `reason: 'DELIVERY_APPROVAL_REQUIRED'`
3. Writes `pending-input.json` with PR details
4. PipelineView detects the pending input via polling
5. Shows `HumanInputPanel` asking user to approve push/PR
6. User approves or declines
7. Studio calls `factory:submit-input` to resume the workflow
8. Workflow continues with user's decision

**Files Changed**:
- `studio/electron/ipc/factory.ts` (lines 206-213)

---

## Testing Checklist

### Timer Fix
- [x] Open a completed run → timer shows correct duration (not thousands of minutes)
- [x] Open a failed run → timer shows duration from start to failure
- [x] Switch tabs while run is active → timer continues correctly
- [x] View same run multiple times → timer is consistent

### Artifacts Fix
- [x] Click "Dev 1" → shows developer report with files changed
- [x] Click "QA 1" → shows QA test results and acceptance criteria
- [x] Click "Dev 2" (retry) → shows second attempt's report
- [x] Click "PM Architect" → shows plan
- [x] Click "Review" → shows code review findings
- [x] Click "Security" → shows security scan results
- [x] Click "Docs" → shows documentation updates

### Retry Button
- [x] Open a failed run → retry button appears in error banner
- [x] Click retry button → calls `handleResumeRun(runId)`
- [x] Retry starts from last failed step

### PR Approval Gate
- [ ] Run a task to completion
- [ ] After all quality gates pass, approval panel should appear
- [ ] Panel should show:
  - Branch name
  - Commit message
  - Files changed count
  - PR title and body preview
  - "Approve Push" checkbox
  - "Approve Pull Request" checkbox
  - Submit button
- [ ] Approve both → PR is created
- [ ] Approve push only → code is pushed but no PR
- [ ] Decline push → code stays local

---

## Summary of Changes

| File | Lines Changed | Purpose |
|------|---------------|---------|
| `studio/src/components/PipelineView.tsx` | ~50 | Timer fix, artifact selection fix, retry button |
| `studio/src/App.tsx` | 1 | Wire up retry button |
| `studio/electron/ipc/factory.ts` | 7 | Enable interactive mode for PR approval |

**Total**: 3 files, ~58 lines changed, 4 critical bugs fixed.

---

## Next Run Behavior

**For Failed Runs**:
1. Click failed run → Shows PipelineView
2. See prominent error banner with retry button
3. Timer shows correct duration (not inflated)
4. Click any agent step → See actual output (not "waiting for output")
5. Click retry → Resumes from last failed step

**For Successful Runs**:
1. All quality gates pass
2. **NEW**: Approval panel appears asking about push/PR
3. User approves or declines
4. If approved, PR is created as draft
5. Run completes with `DELIVERED_WITH_PR` status

**For In-Progress Runs**:
1. Timer counts up in real-time
2. Pipeline updates as agents complete
3. Selected agent shows live logs
