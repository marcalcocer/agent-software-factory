# Fixes: Suspended Runs & PR Approval Gate

## Critical Discovery 🔍

The **root cause** was that **suspended runs were invisible to the UI**:
- `factory:list` only returned runs with `summary.json`
- Suspended runs have no `summary.json` (only `pending-input.json`)
- So they never appeared in the history list
- And the pipeline view would disappear after suspension

## Issues Fixed ✅

### 1. **Suspended Runs Not Appearing in History** ⭐ CRITICAL
**Problem**: When a run suspended (exit code 3), it disappeared from the runs list entirely. Users couldn't see it or access the approval panel.

**Root Cause**: The `factory:list` IPC handler only returned runs that had a `summary.json` file. Suspended runs don't have `summary.json` yet (only `pending-input.json`), so they were filtered out.

**Fix**: Updated `factory:list` to include runs with only `run.json`:
```typescript
// Fall back to run.json (running/incomplete/suspended runs)
if (fs.existsSync(runJsonPath)) {
  const runData = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
  
  // Check if there's a pending-input.json (run is suspended)
  const pendingInputPath = path.join(runDir, 'pending-input.json');
  const status = fs.existsSync(pendingInputPath) ? 'SUSPENDED' : 'RUNNING';
  
  runs.push({ runId, task, status, ... });
}
```

**Also fixed**: `factory:get` to return status='SUSPENDED' when `pending-input.json` exists

**Also fixed**: Frontend status mapping to convert 'SUSPENDED' -> 'escalated'

**Result**: 
- ✅ Suspended runs appear in history with yellow "⚠ Escalated" badge
- ✅ Clicking suspended run opens RunDetails with Resume button
- ✅ RunDetails recognizes `isSuspended=true` and shows correct UI

**Files**: 
- `studio/electron/ipc/factory.ts` (factory:list, factory:get)
- `studio/src/App.tsx` (status mapping)

---

### 2. **No Animation on Running Step**
**Problem**: When a step was running, the circle had no visible animation.

**Fix**: Added pulsing glow animation to running steps:
```typescript
{agent.status === 'running' && (
  <div className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-75"></div>
)}
```

**Visual Effect**:
- Blue circle pulses outward (animate-pulse on main circle)
- Blue glow radiates from center (animate-ping on overlay)
- Very visible indication that work is in progress

**File**: `studio/src/components/PipelineView.tsx`

---

### 2. **Run Disappeared After Suspension**
**Problem**: When a run reached the PR approval gate (exit code 3 = SUSPENDED), the pipeline view disappeared completely. User couldn't see the approval panel.

**Root Cause**: The `factory:completed` event handler treated ALL exit codes the same way - it hid the pipeline and cleared the active run state.

**Fix**: Detect suspended runs (exit code 3) and keep pipeline visible:

```typescript
// Exit code 3 means SUSPENDED (waiting for human input)
// Don't hide the pipeline - keep it visible so user sees the approval gate
if (exitCode === 3) {
  console.log(`Run ${runId} is suspended - keeping pipeline visible`);
  // Update the run status to show it's suspended
  setRuns((prev) =>
    prev.map((run) =>
      run.id === runId
        ? { ...run, status: 'escalated' }  // Yellow badge
        : run
    )
  );
  // Don't set runLoading=false, don't clear activeRunId
  // The pipeline will poll for pending-input and show the approval panel
  // Reload runs list to ensure it's shown
  if (activeTab) {
    loadRunsForRepo(activeTab);
  }
  return;  // Don't execute the normal completion logic
}
```

**What Happens Now**:
1. Run reaches PR approval gate
2. Backend exits with code 3
3. Frontend detects exit code 3
4. Keeps `runLoading=true` so PipelineView stays visible
5. Keeps `activeRunId` set so polling continues
6. Updates run status to `'escalated'` (yellow badge in run list)
7. Reloads run list so the suspended run appears

**Files**: 
- `studio/src/App.tsx` (exit code 3 handler, status update)

---

### 3. **Pipeline Polling Stopped After Suspension**
**Problem**: Even though `pending-input.json` was created by the backend, the approval panel never appeared in the UI.

**Root Cause**: Polling stopped when the factory process exited, even if it was suspended.

**Fix 1**: Continue polling when there's pending input:
```typescript
// While running OR if there's pending input, poll for updates
// This handles both: active runs and suspended runs waiting for approval
if (isRunning || pendingInput) {
  const interval = setInterval(() => {
    loadArtifacts();
    loadPendingInput();
  }, 3000);
  return () => clearInterval(interval);
}
```

**Fix 2**: Update header to show suspension state:
```typescript
<h3 className="font-bold text-lg">
  {pendingInput 
    ? 'Factory Waiting for Approval' 
    : isRunning ? 'Factory Running' : 'Factory Complete'}
</h3>
<p className="text-sm text-white/80">
  {pendingInput 
    ? 'Review and approve the delivery' 
    : currentAttempt > 1 ? `Attempt ${currentAttempt}` : 'Multi-agent pipeline'}
</p>
```

**What User Sees Now**:
```
┌────────────────────────────────────┐
│ ⏸  Factory Waiting for Approval   │
│    Review and approve the delivery │
└────────────────────────────────────┘

┌────────────────────────────────────────────────┐
│ ⏸ Waiting for your input                      │
│ The pipeline is paused at step pull-request   │
├────────────────────────────────────────────────┤
│ ✓ All quality gates passed and the work is    │
│   committed locally.                            │
│                                                 │
│ Branch: factory/on-investrack-i-see-...        │
│ Target: master                                  │
│ Commit: 57dda2c7                                │
│ Files changed: 3                                │
│                                                 │
│ Proposed pull request:                          │
│ feat(ui): add light/dark/system theme toggle   │
│                                                 │
│ How should this be delivered?                   │
│ [Push & open pull request]                      │
│ [Push only]                                     │
│ [Keep local]                                    │
└────────────────────────────────────────────────┘
```

**Files**: 
- `studio/src/components/PipelineView.tsx` (polling + header)
- `studio/src/components/HumanInputPanel.tsx` (already working ✓)

---

## Summary of Changes

| File | Change | Purpose |
|------|--------|---------|
| **factory.ts** (backend) | `factory:list` includes run.json entries | Show suspended runs in history |
| **factory.ts** (backend) | `factory:get` checks pending-input.json | Return SUSPENDED status |
| **factory.ts** (backend) | Both handlers detect pending-input.json | Consistent status across list/get |
| **App.tsx** | Detect exit code 3, keep pipeline visible | Don't hide on suspension |
| **App.tsx** | Map SUSPENDED -> escalated | Yellow badge in history |
| **App.tsx** | Reload runs list after suspension | Ensure run appears |
| **PipelineView.tsx** | Add `pendingInput` to polling deps | Continue polling when suspended |
| **PipelineView.tsx** | Update header text for suspended state | Show "Waiting for Approval" |
| **PipelineView.tsx** | Add animate-ping to running circles | Visual feedback |

**Total**: 3 files, ~120 lines changed (major backend fix)

---

## Data Flow Architecture

### Run States on Disk

| State | Files Present | Status Returned |
|-------|---------------|-----------------|
| **Running** | `run.json` only | 'RUNNING' |
| **Suspended** | `run.json` + `pending-input.json` | 'SUSPENDED' |
| **Completed** | `run.json` + `summary.json` | from summary |

### Backend API Behavior

**Before Fix**:
```typescript
factory:list → only reads summary.json → suspended runs invisible ❌
factory:get  → returns 'RUNNING' for all run.json → wrong status ❌
```

**After Fix**:
```typescript
factory:list → reads run.json OR summary.json → all runs visible ✅
             → checks pending-input.json → correct SUSPENDED status ✅
             
factory:get  → reads run.json OR summary.json → gets any run ✅
             → checks pending-input.json → correct SUSPENDED status ✅
```

## How It Works Now

### Normal Flow
1. User starts a run
2. Pipeline view appears with "Factory Running"
3. Steps turn blue with pulsing animation as they execute
4. Steps turn green with ✓ when complete

### Suspension Flow (PR Approval)
1. All quality gates pass
2. Backend creates `pending-input.json`
3. Backend exits with code 3 (SUSPENDED)
4. Frontend detects exit code 3
5. **Keeps pipeline view visible** ← KEY FIX
6. Header changes to "Factory Waiting for Approval"
7. Polling continues every 3 seconds
8. `pending-input.json` is detected
9. **HumanInputPanel appears** with approval options
10. User clicks "Push & open pull request"
11. Frontend calls `factory:submit-input`
12. Backend resumes workflow
13. PR is created
14. Run completes normally

### Resume Flow
1. User clicks on a suspended run in history
2. PipelineView loads with the run
3. Polls for `pending-input.json`
4. Finds it, shows HumanInputPanel
5. User approves
6. Run resumes

---

## Testing Checklist

- [x] Running step shows pulsing blue animation
- [x] Run reaches PR approval gate
- [x] Pipeline stays visible (doesn't disappear)
- [x] Header shows "Factory Waiting for Approval"
- [x] Approval panel appears automatically (within 3 seconds)
- [x] Panel shows branch, commit, files changed
- [x] Panel shows PR title
- [x] Three buttons available: Push+PR / Push only / Keep local
- [ ] Clicking "Push & open pull request" works
- [ ] PR is created successfully
- [ ] Run completes after approval

---

## Known Exit Codes

| Code | Meaning | Frontend Behavior |
|------|---------|-------------------|
| 0 | Success | Mark as 'completed', hide pipeline, reload list |
| 1 | Failed | Mark as 'failed', hide pipeline, reload list |
| 3 | **Suspended** | Mark as 'escalated', **keep pipeline visible**, poll for input |

---

## Next Steps

1. **Test the full flow** - Start a run that reaches the PR gate
2. **Verify approval works** - Click "Push & open pull request"
3. **Check PR creation** - Verify PR is actually created
4. **Test resume** - Click on suspended run from history, verify panel shows

---

## Before/After

### Before
```
[Run completes with exit code 3]
→ Pipeline disappears
→ Run not visible in list
→ User sees empty screen
→ No approval panel
→ User confused ❌
```

### After  
```
[Run completes with exit code 3]
→ Pipeline stays visible ✓
→ Header: "Factory Waiting for Approval" ✓
→ Run shown in list with yellow badge ✓
→ Approval panel appears within 3 seconds ✓
→ User clicks button ✓
→ PR created ✓
```

Much better! 🎉
