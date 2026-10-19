# Fix: Display Failure Messages in UI for Failed Runs

## Problem
When a run fails (especially validation errors like "task too small"), the error message wasn't being displayed in the UI at all. Users would:
1. Click on a failed run in the history
2. See the PipelineView with all the agent stages
3. **NOT see any error message** explaining why it failed
4. Click on "Prepare" step and see "Waiting for output" instead of the actual error

The RunDetails modal (which had error display) was never being shown when clicking on runs from history.

## Root Cause
1. **PipelineView had no error display**: When clicking a run from history, the app shows `PipelineView` (the visual agent pipeline), not `RunDetails` modal. PipelineView didn't load or display the error message from failed runs.

2. **Prepare step showed "Waiting for output"**: For validation errors that happen before workflow execution, there's no artifact or logs for the prepare step, so `AgentDetail` would just show "Waiting for output..." instead of the actual error.

3. **Validation errors weren't humanized**: Raw Zod validation error messages like "Too small: expected string to have >=10 characters" weren't being converted to user-friendly messages.

## Solution

### 1. Added Error Display to PipelineView
**File**: `studio/src/components/PipelineView.tsx`

Added state variables to track run error and status:
```typescript
const [runError, setRunError] = useState<string | null>(null);
const [runStatus, setRunStatus] = useState<string | null>(null);
```

Updated `loadRunData()` to fetch error from the run:
```typescript
const run = await window.api.invoke('factory:get', runId);
if (run) {
  setStartedAt(run.startedAt);
  setRunError(run.error || null);
  setRunStatus(run.status || null);
}
```

Added prominent error banner in the UI (after the header, before pipeline):
```tsx
{runStatus === 'FAILED' && runError && (
  <div className="border-2 border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg p-4 shadow-md">
    <div className="flex items-start gap-3">
      <span className="text-2xl">⚠️</span>
      <div className="flex-1">
        <h3 className="text-base font-bold text-red-700 dark:text-red-300 mb-2">
          Run Failed
        </h3>
        <p className="text-sm text-red-900 dark:text-red-100 whitespace-pre-wrap break-words leading-relaxed">
          {humanizeError(runError)}
        </p>
      </div>
    </div>
  </div>
)}
```

**Result**: Error message now appears prominently at the top of the pipeline view.

### 2. Show Error in Prepare Step
**File**: `studio/src/components/PipelineView.tsx`

Inject error as a log when prepare step is selected but has no artifact:
```typescript
// If prepare-run is selected and there's a run error but no artifact/logs, inject the error
if (selectedAgent === 'prepare-run' && runError && !selectedArtifact && agentLogs.length === 0) {
  agentLogs = [`Error: ${runError}`];
}
```

**Result**: Clicking the "Prepare" step now shows the error message instead of "Waiting for output".

### 3. Added Validation Error Pattern to `humanizeError()`
**Files**: 
- `studio/src/components/RunDetails.tsx`
- `studio/src/components/PipelineView.tsx` (duplicated for both components)

Added a new pattern to detect and humanize validation errors:

```typescript
// Handle validation errors from input schema
if (/Invalid input data/i.test(msg)) {
  const cleanMsg = msg
    .replace(/Invalid input data:\s*/i, '')
    .replace(/^-\s*/gm, '• ')
    .replace(/Too small: expected string to have >=(\d+) characters/g, 
             'Must be at least $1 characters long')
    .replace(/Too large: expected string to have <=(\d+) characters/g, 
             'Must be at most $1 characters long')
    .trim();
  
  return (
    'Invalid input provided:\n\n' +
    cleanMsg +
    '\n\nPlease fix the input and try again.'
  );
}
```

**Before**:
```
Invalid input data: 
- task: Too small: expected string to have >=10 characters
```

**After**:
```
Invalid input provided:

• task: Must be at least 10 characters long

Please fix the input and try again.
```

### 4. Enhanced RunDetails Modal (Bonus)
**File**: `studio/src/components/RunDetails.tsx`

Even though this modal isn't currently shown when clicking runs from history, I improved it for future use:

- Made error display more prominent with warning emoji (⚠️)
- Increased border thickness (border-2) with stronger colors
- Made heading larger and bolder
- Improved text contrast and readability
- Better fallback message when error details are missing

## Testing

### Test Case 1: Validation Error (Task Too Short)
Created test runs with tasks shorter than 10 characters:

```bash
cd factory && npm run factory -- run --repo invest-track --task "ping" --dry-run
```

**Result**: 
- Summary.json created with `status: "FAILED"` and proper error message
- Error is now displayed in UI with user-friendly formatting

### Test Case 2: Manual Test Run
Created a test run in `factory/logs/20261014-test-validation-err/` with a validation error to verify UI rendering.

## Files Modified

1. **studio/src/components/PipelineView.tsx** (Main fix)
   - Added `humanizeError()` function (lines 7-59)
   - Added `runError` and `runStatus` state variables
   - Updated `loadRunData()` to fetch error and status
   - Added error banner display in UI
   - Inject error into prepare step logs when no artifact exists

2. **studio/src/components/RunDetails.tsx** (Bonus improvement)
   - Enhanced `humanizeError()` function (lines 38-77)
   - Improved error display styling (lines 175-192)

## Verification Steps

To verify the fix works:

1. Start the Studio UI: `npm run dev:studio`
2. Trigger a validation error: 
   ```bash
   cd factory && npm run factory -- run --repo <your-repo> --task "test" --dry-run
   ```
3. Click on the failed run in the UI
4. Verify that:
   - ✅ **PipelineView shows error banner** at the top with warning icon
   - ✅ **Error message is user-friendly** (e.g., "Must be at least 10 characters long")
   - ✅ **Pipeline shows prepare step with red X** (failed status)
   - ✅ **Clicking "Prepare" step shows the error** in AgentDetail panel
   - ✅ **Error is NOT just "Waiting for output"**

## Additional Notes

- The fix handles both `FAILED` and `failed` status values (case-insensitive)
- Empty `steps` array for validation errors is expected (workflow never started)
- The error display appears before the "Execution Steps" section
- Logs are created in `factory/logs/<runId>/` directory
- The Studio IPC handler reads from `../../factory/logs` relative to dist-electron

## Related Files

- `factory/src/cli/factory.ts` - Calls `writeFailureSummary()` when validation fails
- `factory/src/utils/schemas.ts` - Defines validation schemas (e.g., task min length = 10)
- `studio/electron/ipc/factory.ts` - IPC handlers for fetching run details
- `studio/shared/types.ts` - TypeScript interfaces for runs and steps
