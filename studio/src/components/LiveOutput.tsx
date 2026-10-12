import { useEffect, useRef, useState } from 'react';

interface LiveOutputProps {
  runId: string;
  isRunning: boolean;
}

export function LiveOutput({ runId, isRunning }: LiveOutputProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!runId) return;

    // Subscribe to factory output events
    const unsubscribe = window.api.on('factory:output', (outputRunId: string, data: string) => {
      if (outputRunId === runId) {
        setLogs((prev) => [...prev, data]);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [runId]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [logs]);

  if (!runId) {
    return null;
  }

  return (
    <div className="bg-slate-900 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-200">Output</span>
          {isRunning && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-600 text-white">
              <span className="animate-pulse">●</span>
              Running
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{runId}</span>
      </div>
      <div
        ref={outputRef}
        className="p-4 h-64 overflow-y-auto font-mono text-sm text-slate-300 whitespace-pre-wrap"
      >
        {logs.length === 0 ? (
          <span className="text-slate-500">Waiting for output...</span>
        ) : (
          logs.map((log, index) => (
            <div key={index}>{log}</div>
          ))
        )}
      </div>
    </div>
  );
}
