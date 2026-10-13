/**
 * Format a duration in milliseconds as a human-readable string.
 * Examples: "2.5s", "1m 23s", "1h 5m", "2h 15m 30s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    const m = minutes % 60;
    const s = seconds % 60;
    if (m === 0 && s === 0) return `${hours}h`;
    if (s === 0) return `${hours}h ${m}m`;
    return `${hours}h ${m}m ${s}s`;
  }
  
  if (minutes > 0) {
    const s = seconds % 60;
    if (s === 0) return `${minutes}m`;
    return `${minutes}m ${s}s`;
  }
  
  if (seconds >= 10) return `${seconds}s`;
  
  // For sub-10s durations, show one decimal place
  return `${(ms / 1000).toFixed(1)}s`;
}
