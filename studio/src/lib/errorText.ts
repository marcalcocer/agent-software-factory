/**
 * What went wrong, in the words of whoever said it.
 *
 * An error thrown in Electron's main process reaches the screen as "Error invoking remote method
 * 'factory:run-task': Error: Authentication required. Please log in to Claude CLI." - the wrapper is plumbing,
 * and the user should read only what the main process said.
 */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
