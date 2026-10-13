import { useEffect, useState, useCallback } from 'react';
import type { RunArtifact } from '../../shared/types';
import { AgentDetail } from './AgentDetail';

interface AgentStep {
  id: string;
  name: string;
  icon: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'retry';
  attempt?: number;
  duration?: number;
  activity?: string; // What the agent is currently doing
  filesChanged?: number;
  testsPassed?: number;
  findings?: number;
}

interface PipelineViewProps {
  runId: string | null;
  isRunning: boolean;
  onClose?: () => void;
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

export function PipelineView({ runId, isRunning, onClose }: PipelineViewProps) {
  const [agents, setAgents] = useState<AgentStep[]>(INITIAL_AGENTS);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [currentAttempt, setCurrentAttempt] = useState(1);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);

  // Load agent artifacts (rich step reports) for the run
  const loadArtifacts = useCallback(async () => {
    if (!runId) return;
    try {
      const result = await window.api.invoke('factory:get-artifacts', runId);
      setArtifacts(result);
    } catch {
      // Ignore artifact load errors
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    loadArtifacts();

    // While running, poll for new artifacts as agents finish
    if (isRunning) {
      const interval = setInterval(loadArtifacts, 3000);
      return () => clearInterval(interval);
    }
  }, [runId, isRunning, loadArtifacts]);

  // Also refresh artifacts right after the run completes
  useEffect(() => {
    if (runId && !isRunning) {
      loadArtifacts();
    }
  }, [runId, isRunning, loadArtifacts]);

  // Build dynamic pipeline from artifacts (each attempt gets its own node)
  useEffect(() => {
    if (artifacts.length === 0) return;

    const nodes: AgentStep[] = [];
    const stepLabels: Record<string, string> = {
      'pm-architect': 'PM',
      'developer': 'Dev',
      'qa-tester': 'QA',
      'triage': 'Triage',
      'reviewer': 'Review',
      'security': 'Security',
      'documentation': 'Docs',
    };
    const stepIcons: Record<string, string> = {
      'pm-architect': '📋',
      'developer': '💻',
      'qa-tester': '🧪',
      'triage': '🔍',
      'reviewer': '👀',
      'security': '🔒',
      'documentation': '📝',
    };

    // Group artifacts by step
    const byStep: Record<string, RunArtifact[]> = {};
    artifacts.forEach(art => {
      if (!byStep[art.step]) byStep[art.step] = [];
      byStep[art.step].push(art);
    });

    // PM (single)
    if (byStep['pm-architect']) {
      const art = byStep['pm-architect'][0];
      nodes.push({
        id: 'pm-architect',
        name: 'PM Architect',
        icon: '📋',
        status: art.status === 'COMPLETED' ? 'completed' : 'failed',
        attempt: art.attempt,
      });
    }

    // Dev/QA/Triage cycles (multiple attempts possible)
    const maxAttempt = Math.max(...artifacts.map(a => a.attempt || 1), 1);
    for (let attempt = 1; attempt <= maxAttempt; attempt++) {
      ['developer', 'qa-tester', 'triage'].forEach(step => {
        const art = byStep[step]?.find(a => a.attempt === attempt);
        if (art) {
          let status: AgentStep['status'] = 'pending';
          if (step === 'qa-tester') {
            status = art.status === 'PASS' ? 'completed' : art.status === 'FAIL' ? 'failed' : 'retry';
          } else if (art.status === 'COMPLETED' || art.status === 'PASS') {
            status = 'completed';
          } else if (art.status?.includes('FAIL')) {
            status = 'failed';
          } else if (art.status?.includes('RETRY')) {
            status = 'retry';
          }
          nodes.push({
            id: `${step}-${attempt}`,
            name: `${stepLabels[step] || step} ${attempt}`,
            icon: stepIcons[step] || '🤖',
            status,
            attempt,
          });
        }
      });
    }

    // Review, Security, Docs (single)
    ['reviewer', 'security', 'documentation'].forEach(step => {
      if (byStep[step]) {
        const art = byStep[step][0];
        nodes.push({
          id: step,
          name: stepLabels[step] || step,
          icon: stepIcons[step] || '🤖',
          status: art.status === 'COMPLETED' || art.status === 'PASS' ? 'completed' : 'failed',
          attempt: art.attempt,
        });
      }
    });

    // Delivery placeholder
    nodes.push({ id: 'delivery', name: 'Delivery', icon: '🚀', status: 'pending' });

    setAgents(nodes);
  }, [artifacts]);

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
          updated[idx] = { ...updated[idx], status: 'running', activity: 'Analyzing requirements and creating implementation plan...' };
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
          updated[pmIdx] = { ...updated[pmIdx], status: 'completed', activity: 'Implementation plan created' };
        }
      }
      
      // Developer finished
      if (lowerLine.includes('developer step finished') || lowerLine.includes('developer') && lowerLine.includes('completed')) {
        const idx = updated.findIndex(a => a.id === 'developer');
        if (idx >= 0) {
          // Extract files changed
          const filesMatch = line.match(/changedFiles[:\s]+(\d+)/i);
          const filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : undefined;
          updated[idx] = { 
            ...updated[idx], 
            status: 'completed',
            activity: filesChanged ? `Modified ${filesChanged} file${filesChanged > 1 ? 's' : ''}` : 'Completed',
            filesChanged
          };
        }
      }
      
      // Developer activity hints
      if (lowerLine.includes('developer') && updated.findIndex(a => a.id === 'developer' && a.status === 'running') >= 0) {
        const idx = updated.findIndex(a => a.id === 'developer');
        if (idx >= 0 && !updated[idx].activity) {
          updated[idx] = { ...updated[idx], activity: 'Writing code and implementing changes...' };
        }
      }
      
      // QA
      if (lowerLine.includes('qa') && !lowerLine.includes('finished')) {
        const idx = updated.findIndex(a => a.id === 'qa-tester');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running', activity: 'Running tests and checking functionality...' };
        }
      }
      if (lowerLine.includes('qa step finished') || (lowerLine.includes('qa') && lowerLine.includes('pass'))) {
        const idx = updated.findIndex(a => a.id === 'qa-tester');
        if (idx >= 0) {
          const verdictMatch = line.match(/verdict[:\s]+"?(\w+)"?/i);
          const passed = verdictMatch ? verdictMatch[1].toUpperCase() === 'PASS' : undefined;
          updated[idx] = {
            ...updated[idx],
            status: passed === false ? 'failed' : 'completed',
            activity: passed === false ? 'Verification failed ✗' : passed ? 'All checks passed ✓' : 'Tests completed',
          };
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

  // Show starting state when runId is not yet available
  if (!runId && isRunning) {
    return (
      <div className="space-y-4">
        {/* Starting header */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-lg p-6 text-white">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-5 h-5 bg-white rounded-full animate-pulse"></div>
              </div>
            </div>
            <div>
              <h3 className="font-bold text-xl">Starting Factory...</h3>
              <p className="text-sm text-white/80">Initializing multi-agent pipeline</p>
            </div>
          </div>
        </div>
        
        {/* Skeleton pipeline */}
        <div className="bg-white dark:bg-slate-800 rounded-lg p-6 overflow-x-auto">
          <div className="flex items-center justify-between min-w-[800px]">
            {INITIAL_AGENTS.map((agent, index) => (
              <div key={agent.id} className="flex items-center">
                <div className="flex flex-col items-center opacity-50">
                  <div className="w-16 h-16 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-2xl animate-pulse">
                    {agent.icon}
                  </div>
                  <span className="mt-2 text-sm font-medium text-slate-400">{agent.name}</span>
                </div>
                {index < INITIAL_AGENTS.length - 1 && (
                  <div className="flex items-center mx-2">
                    <div className="h-1 w-8 bg-slate-200 dark:bg-slate-700"></div>
                    <div className="w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[8px] border-l-slate-200 dark:border-l-slate-700"></div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!runId) {
    return null;
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const selectedAgentData = agents.find(a => a.id === selectedAgent);
  // Latest artifact for the selected agent (prefer the newest attempt)
  const selectedArtifact = selectedAgent
    ? [...artifacts]
        .filter(a => a.step === selectedAgent)
        .sort((a, b) => (b.attempt || 0) - (a.attempt || 0))[0]
    : undefined;
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
            {!isRunning && onClose && (
              <button
                onClick={onClose}
                className="p-2 hover:bg-white/10 rounded transition-colors"
                title="Back to runs"
              >
                ← Back
              </button>
            )}
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

      {/* Current Agent Activity Card */}
      {(() => {
        const runningAgent = agents.find(a => a.status === 'running');
        if (!runningAgent) return null;
        
        return (
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-lg p-4 text-white">
            <div className="flex items-center gap-3">
              <div className="text-4xl animate-pulse">{runningAgent.icon}</div>
              <div className="flex-1">
                <h4 className="font-bold text-lg">{runningAgent.name}</h4>
                <p className="text-sm text-white/80">
                  {runningAgent.activity || 'Processing...'}
                </p>
                {(runningAgent.filesChanged || runningAgent.testsPassed || runningAgent.findings) && (
                  <div className="flex gap-4 mt-2 text-xs">
                    {runningAgent.filesChanged && (
                      <span className="bg-white/20 px-2 py-1 rounded">
                        📄 {runningAgent.filesChanged} file{runningAgent.filesChanged > 1 ? 's' : ''}
                      </span>
                    )}
                    {runningAgent.testsPassed !== undefined && (
                      <span className="bg-white/20 px-2 py-1 rounded">
                        ✓ {runningAgent.testsPassed} tests
                      </span>
                    )}
                    {runningAgent.findings && (
                      <span className="bg-white/20 px-2 py-1 rounded">
                        🔍 {runningAgent.findings} finding{runningAgent.findings > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Selected agent report */}
      {selectedAgentData && (
        <div className="bg-slate-900 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xl">{selectedAgentData.icon}</span>
              <span className="text-sm font-semibold text-slate-100">
                {selectedAgentData.name} Report
              </span>
            </div>
            <button
              onClick={() => setSelectedAgent(null)}
              className="text-xs text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="p-4">
            <AgentDetail step={selectedAgentData.id} artifact={selectedArtifact} />
          </div>
        </div>
      )}

      {/* Technical Logs (collapsible) */}
      <div className="bg-slate-900 rounded-lg overflow-hidden">
        <div className="w-full px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
          <button
            onClick={() => setLogsExpanded(!logsExpanded)}
            className="flex items-center gap-2 flex-1 text-left"
          >
            <span className="text-slate-400">{logsExpanded ? '▼' : '▶'}</span>
            {selectedAgentData ? (
              <>
                <span className="text-xl">{selectedAgentData.icon}</span>
                <span className="text-sm font-medium text-slate-200">{selectedAgentData.name} Technical Logs</span>
              </>
            ) : (
              <span className="text-sm font-medium text-slate-200">Technical Logs</span>
            )}
            {isRunning && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-600 text-white">
                <span className="w-2 h-2 bg-white rounded-full animate-pulse"></span>
                Live
              </span>
            )}
          </button>
          <div className="flex items-center gap-3">
            {selectedAgent && (
              <button
                onClick={() => setSelectedAgent(null)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Show All
              </button>
            )}
            <button
              onClick={() => setLogsExpanded(!logsExpanded)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              {logsExpanded ? 'Click to collapse' : 'Click to expand'}
            </button>
          </div>
        </div>
        {logsExpanded && (
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
        )}
      </div>
    </div>
  );
}
