import { useEffect, useState, useCallback } from 'react';

interface AgentStep {
  id: string;
  name: string;
  icon: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'retry';
  attempt?: number;
  duration?: number;
  details?: string[];
}

interface PipelineViewProps {
  runId: string | null;
  isRunning: boolean;
}

const INITIAL_AGENTS: AgentStep[] = [
  { id: 'pm-architect', name: 'PM Architect', icon: '📋', status: 'pending' },
  { id: 'developer', name: 'Developer', icon: '💻', status: 'pending' },
  { id: 'qa-tester', name: 'QA', icon: '🧪', status: 'pending' },
  { id: 'security', name: 'Security', icon: '🔒', status: 'pending' },
  { id: 'reviewer', name: 'Review', icon: '👀', status: 'pending' },
  { id: 'documentation', name: 'Docs', icon: '📝', status: 'pending' },
  { id: 'delivery', name: 'Delivery', icon: '🚀', status: 'pending' },
];

export function PipelineView({ runId, isRunning }: PipelineViewProps) {
  const [agents, setAgents] = useState<AgentStep[]>(INITIAL_AGENTS);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [currentAttempt, setCurrentAttempt] = useState(1);
  const [elapsedTime, setElapsedTime] = useState(0);

  // Timer for elapsed time
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setElapsedTime(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  // Reset when new run starts
  useEffect(() => {
    if (runId && isRunning) {
      setAgents(INITIAL_AGENTS.map(a => ({ ...a, status: 'pending' })));
      setLogs([]);
      setElapsedTime(0);
      setCurrentAttempt(1);
    }
  }, [runId, isRunning]);

  // Update agent state based on the log line
  const updateAgentFromLog = useCallback((line: string) => {
    const lowerLine = line.toLowerCase();
    
    // Add to logs
    setLogs(prev => [...prev.slice(-100), line]); // Keep last 100 lines
    
    // Detect attempt number
    const attemptMatch = line.match(/attempt[:\s]+(\d+)/i);
    if (attemptMatch) {
      setCurrentAttempt(parseInt(attemptMatch[1], 10));
    }

    // Detect agent activity
    setAgents(prev => {
      const updated = [...prev];
      
      // PM Architect
      if (lowerLine.includes('pm-architect') || lowerLine.includes('run prepared')) {
        const idx = updated.findIndex(a => a.id === 'pm-architect');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running' };
        }
      }
      
      // Developer start
      if (lowerLine.includes('developer') && !lowerLine.includes('finished')) {
        const idx = updated.findIndex(a => a.id === 'developer');
        if (idx >= 0 && (updated[idx].status === 'pending' || updated[idx].status === 'retry')) {
          updated[idx] = { ...updated[idx], status: 'running' };
        }
        // Mark PM as complete if developer starts
        const pmIdx = updated.findIndex(a => a.id === 'pm-architect');
        if (pmIdx >= 0 && updated[pmIdx].status === 'running') {
          updated[pmIdx] = { ...updated[pmIdx], status: 'completed' };
        }
      }
      
      // Developer finished
      if (lowerLine.includes('developer step finished') || lowerLine.includes('developer') && lowerLine.includes('completed')) {
        const idx = updated.findIndex(a => a.id === 'developer');
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], status: 'completed' };
        }
      }
      
      // QA
      if (lowerLine.includes('qa') && !lowerLine.includes('finished')) {
        const idx = updated.findIndex(a => a.id === 'qa-tester');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running' };
        }
      }
      if (lowerLine.includes('qa step finished') || lowerLine.includes('qa') && lowerLine.includes('pass')) {
        const idx = updated.findIndex(a => a.id === 'qa-tester');
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], status: 'completed' };
        }
      }
      
      // Security
      if (lowerLine.includes('security') && !lowerLine.includes('finished')) {
        const idx = updated.findIndex(a => a.id === 'security');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running' };
        }
      }
      if (lowerLine.includes('security scan finished') || lowerLine.includes('security') && lowerLine.includes('pass')) {
        const idx = updated.findIndex(a => a.id === 'security');
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], status: 'completed' };
        }
      }
      
      // Code Review
      if (lowerLine.includes('review') && !lowerLine.includes('finished')) {
        const idx = updated.findIndex(a => a.id === 'reviewer');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running' };
        }
      }
      if (lowerLine.includes('code review finished')) {
        const idx = updated.findIndex(a => a.id === 'reviewer');
        if (idx >= 0) {
          if (lowerLine.includes('changes_requested')) {
            updated[idx] = { ...updated[idx], status: 'retry' };
            // Mark developer for retry
            const devIdx = updated.findIndex(a => a.id === 'developer');
            if (devIdx >= 0) {
              updated[devIdx] = { ...updated[devIdx], status: 'retry' };
            }
          } else {
            updated[idx] = { ...updated[idx], status: 'completed' };
          }
        }
      }
      
      // Triage (retry decision)
      if (lowerLine.includes('triage') && lowerLine.includes('retry_developer')) {
        const devIdx = updated.findIndex(a => a.id === 'developer');
        if (devIdx >= 0) {
          updated[devIdx] = { ...updated[devIdx], status: 'retry' };
        }
      }
      
      // Documentation
      if (lowerLine.includes('documentation') && !lowerLine.includes('finished')) {
        const idx = updated.findIndex(a => a.id === 'documentation');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running' };
        }
      }
      if (lowerLine.includes('documentation step finished')) {
        const idx = updated.findIndex(a => a.id === 'documentation');
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], status: 'completed' };
        }
      }
      
      // Delivery
      if (lowerLine.includes('delivery') || lowerLine.includes('commit')) {
        const idx = updated.findIndex(a => a.id === 'delivery');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running' };
        }
      }
      if (lowerLine.includes('delivery step finished') || lowerLine.includes('run finished')) {
        const idx = updated.findIndex(a => a.id === 'delivery');
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], status: 'completed' };
        }
      }
      
      return updated;
    });
  }, []);

  // Listen for factory output
  useEffect(() => {
    if (!runId) return;

    const unsubscribe = window.api.on('factory:output', (outputRunId: string, line: string) => {
      if (outputRunId === runId) {
        updateAgentFromLog(line);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [runId, updateAgentFromLog]);

  if (!runId) {
    return null;
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const selectedAgentData = agents.find(a => a.id === selectedAgent);
  const agentLogs = logs.filter(log => {
    if (!selectedAgent) return true;
    const lower = log.toLowerCase();
    return lower.includes(selectedAgent) || 
           (selectedAgent === 'qa-tester' && lower.includes('qa')) ||
           (selectedAgent === 'reviewer' && lower.includes('review'));
  });

  return (
    <div className="space-y-4">
      {/* Header with timer */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-lg p-4 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isRunning && (
              <div className="relative">
                <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-4 h-4 bg-white rounded-full animate-pulse"></div>
                </div>
              </div>
            )}
            <div>
              <h3 className="font-bold text-lg">
                {isRunning ? 'Factory Running' : 'Factory Complete'}
              </h3>
              <p className="text-sm text-white/80">
                {currentAttempt > 1 ? `Attempt ${currentAttempt}` : 'Multi-agent pipeline'}
              </p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-mono font-bold">{formatTime(elapsedTime)}</div>
            <div className="text-sm text-white/70">{runId}</div>
          </div>
        </div>
      </div>

      {/* Pipeline visualization */}
      <div className="bg-white dark:bg-slate-800 rounded-lg p-6 overflow-x-auto">
        <div className="flex items-center justify-between min-w-[800px]">
          {agents.map((agent, index) => (
            <div key={agent.id} className="flex items-center">
              {/* Agent node */}
              <button
                onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
                className={`relative flex flex-col items-center group transition-all duration-300 ${
                  selectedAgent === agent.id ? 'scale-110' : 'hover:scale-105'
                }`}
              >
                {/* Circle */}
                <div
                  className={`w-16 h-16 rounded-full flex items-center justify-center text-2xl transition-all duration-300 shadow-lg ${
                    agent.status === 'running'
                      ? 'bg-blue-500 ring-4 ring-blue-300 ring-opacity-50 animate-pulse'
                      : agent.status === 'completed'
                      ? 'bg-green-500'
                      : agent.status === 'failed'
                      ? 'bg-red-500'
                      : agent.status === 'retry'
                      ? 'bg-yellow-500 animate-bounce'
                      : 'bg-slate-300 dark:bg-slate-600'
                  } ${selectedAgent === agent.id ? 'ring-4 ring-indigo-400' : ''}`}
                >
                  {agent.status === 'completed' ? (
                    <span className="text-white text-xl">✓</span>
                  ) : agent.status === 'failed' ? (
                    <span className="text-white text-xl">✗</span>
                  ) : agent.status === 'retry' ? (
                    <span className="text-white text-xl">↻</span>
                  ) : (
                    <span className={agent.status === 'running' ? 'animate-bounce' : ''}>
                      {agent.icon}
                    </span>
                  )}
                </div>
                
                {/* Label */}
                <span className={`mt-2 text-sm font-medium ${
                  agent.status === 'running' 
                    ? 'text-blue-600 dark:text-blue-400' 
                    : agent.status === 'completed'
                    ? 'text-green-600 dark:text-green-400'
                    : agent.status === 'retry'
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-slate-500'
                }`}>
                  {agent.name}
                </span>

                {/* Running indicator */}
                {agent.status === 'running' && (
                  <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 flex space-x-1">
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                )}
              </button>

              {/* Connector arrow */}
              {index < agents.length - 1 && (
                <div className="flex items-center mx-2">
                  <div className={`h-1 w-8 transition-colors duration-300 ${
                    agent.status === 'completed' ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'
                  }`}></div>
                  <div className={`w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[8px] transition-colors duration-300 ${
                    agent.status === 'completed' ? 'border-l-green-400' : 'border-l-slate-300 dark:border-l-slate-600'
                  }`}></div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Agent details / Logs panel */}
      <div className="bg-slate-900 rounded-lg overflow-hidden">
        <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {selectedAgentData ? (
              <>
                <span className="text-xl">{selectedAgentData.icon}</span>
                <span className="text-sm font-medium text-slate-200">{selectedAgentData.name} Logs</span>
              </>
            ) : (
              <span className="text-sm font-medium text-slate-200">All Output</span>
            )}
            {isRunning && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-600 text-white">
                <span className="w-2 h-2 bg-white rounded-full animate-pulse"></span>
                Live
              </span>
            )}
          </div>
          {selectedAgent && (
            <button
              onClick={() => setSelectedAgent(null)}
              className="text-xs text-slate-400 hover:text-white"
            >
              Show All
            </button>
          )}
        </div>
        <div className="p-4 h-48 overflow-y-auto font-mono text-xs text-slate-300 space-y-1">
          {agentLogs.length === 0 ? (
            <span className="text-slate-500">
              {isRunning ? 'Waiting for output...' : 'No logs available'}
            </span>
          ) : (
            agentLogs.slice(-50).map((log, index) => (
              <div key={index} className="hover:bg-slate-800 px-1 rounded">
                {log}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
