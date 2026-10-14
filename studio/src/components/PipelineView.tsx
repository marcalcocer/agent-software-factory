import { useEffect, useState, useCallback, useRef } from 'react';
import type { PendingInput, RunArtifact } from '../../shared/types';
import { AgentDetail } from './AgentDetail';
import { HumanInputPanel } from './HumanInputPanel';

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
  { id: 'prepare-run', name: 'Prepare', icon: '⚙️', status: 'pending' },
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
  const [logs, setLogs] = useState<Array<{ text: string; agent?: string }>>([]);
  const [currentAttempt, setCurrentAttempt] = useState(1);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [pendingInput, setPendingInput] = useState<PendingInput | null>(null);
  const [submittingInput, setSubmittingInput] = useState(false);
  const currentRunningAgentRef = useRef<string | null>(null); // Track which agent is currently executing

  // Load run metadata and artifacts
  const loadRunData = useCallback(async () => {
    if (!runId) return;
    try {
      const run = await window.api.invoke('factory:get', runId);
      if (run) {
        setStartedAt(run.startedAt);
      }
    } catch {
      // Ignore errors
    }
  }, [runId]);

  const loadArtifacts = useCallback(async () => {
    if (!runId) return;
    try {
      const result = await window.api.invoke('factory:get-artifacts', runId);
      setArtifacts(result);
    } catch {
      // Ignore artifact load errors
    }
  }, [runId]);

  // Poll for an open human-in-the-loop gate. The workflow writes `pending-input.json`
  // when it suspends and removes it on resume, so this drives the input form.
  const loadPendingInput = useCallback(async () => {
    if (!runId) return;
    try {
      const result = await window.api.invoke('factory:get-pending-input', runId);
      setPendingInput(result);
      if (result) setSubmittingInput(false);
    } catch {
      // Ignore polling errors
    }
  }, [runId]);

  const handleSubmitInput = useCallback(
    async (answer: {
      clarifications?: string;
      decision?: 'ACKNOWLEDGE' | 'ABORT';
      guidance?: string;
      approvePush?: boolean;
      approvePullRequest?: boolean;
    }) => {
      if (!runId) return;
      setSubmittingInput(true);
      try {
        await window.api.invoke('factory:submit-input', { runId, ...answer });
        setPendingInput(null);
      } catch (error) {
        console.error('Failed to submit input:', error);
        setSubmittingInput(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    if (!runId) return;
    loadRunData();
    loadArtifacts();
    loadPendingInput();

    // While running, poll for new artifacts and for an input gate opening.
    if (isRunning) {
      const interval = setInterval(() => {
        loadArtifacts();
        loadPendingInput();
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [runId, isRunning, loadRunData, loadArtifacts, loadPendingInput]);

  // Also refresh artifacts right after the run completes
  useEffect(() => {
    if (runId && !isRunning) {
      loadArtifacts();
    }
  }, [runId, isRunning, loadArtifacts]);

  // Build dynamic pipeline from artifacts (each attempt gets its own node)
  // BUT always show full expected pipeline, even if artifacts don't exist yet
  useEffect(() => {
    const stepLabels: Record<string, string> = {
      'prepare-run': 'Prepare',
      'pm-architect': 'PM Architect',
      'developer': 'Dev',
      'qa-tester': 'QA',
      'triage': 'Triage',
      'reviewer': 'Review',
      'security': 'Security',
      'documentation': 'Docs',
    };
    const stepIcons: Record<string, string> = {
      'prepare-run': '⚙️',
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

    const nodes: AgentStep[] = [];

    // Prepare (no artifact, check via events/logs) - always show
    // We'll update its status via log detection in updateAgentFromLog
    const prepareStatus = agents.find(a => a.id === 'prepare-run')?.status || 'pending';
    nodes.push({
      id: 'prepare-run',
      name: 'Prepare',
      icon: '⚙️',
      status: prepareStatus,
      attempt: 1,
    });

    // PM (single) - always show, update from artifact if exists
    const pmArt = byStep['pm-architect']?.[0];
    nodes.push({
      id: 'pm-architect',
      name: 'PM Architect',
      icon: '📋',
      status: pmArt ? (pmArt.status === 'COMPLETED' ? 'completed' : 'failed') : 'pending',
      attempt: pmArt?.attempt || 1,
    });

    // Dev/QA/Triage cycles - show at least attempt 1, more if artifacts exist
    const maxAttempt = artifacts.length > 0 ? Math.max(...artifacts.map(a => a.attempt || 1), 1) : 1;
    for (let attempt = 1; attempt <= maxAttempt; attempt++) {
      // Developer
      const devArt = byStep['developer']?.find(a => a.attempt === attempt);
      if (attempt === 1 || devArt) {
        nodes.push({
          id: `developer-${attempt}`,
          name: `Dev ${attempt}`,
          icon: '💻',
          status: devArt 
            ? (devArt.status === 'COMPLETED' || devArt.status === 'PASS' ? 'completed' : 'failed')
            : 'pending',
          attempt,
        });
      }

      // QA
      const qaArt = byStep['qa-tester']?.find(a => a.attempt === attempt);
      if (attempt === 1 || qaArt) {
        let qaStatus: AgentStep['status'] = 'pending';
        if (qaArt) {
          qaStatus = qaArt.status === 'PASS' ? 'completed' : qaArt.status === 'FAIL' ? 'failed' : 'retry';
        }
        nodes.push({
          id: `qa-tester-${attempt}`,
          name: `QA ${attempt}`,
          icon: '🧪',
          status: qaStatus,
          attempt,
        });
      }

      // Triage (only show if artifact exists - doesn't always run)
      const triageArt = byStep['triage']?.find(a => a.attempt === attempt);
      if (triageArt) {
        nodes.push({
          id: `triage-${attempt}`,
          name: `Triage ${attempt}`,
          icon: '🔍',
          status: triageArt.status === 'COMPLETED' ? 'completed' : 'failed',
          attempt,
        });
      }
    }

    // Review, Security, Docs (single) - always show
    ['reviewer', 'security', 'documentation'].forEach(step => {
      const art = byStep[step]?.[0];
      let status: AgentStep['status'] = 'pending';
      
      if (art) {
        // Map various success statuses to completed
        if (art.status === 'COMPLETED' || 
            art.status === 'PASS' || 
            art.status === 'APPROVED' ||
            art.status === 'APPROVED_WITH_SUGGESTIONS' ||
            art.status === 'SKIPPED') {
          status = 'completed';
        } else if (art.status === 'FAIL' || art.status === 'FAILED' || art.status === 'BLOCKED') {
          status = 'failed';
        }
      }
      
      nodes.push({
        id: step,
        name: stepLabels[step] || step,
        icon: stepIcons[step] || '🤖',
        status,
        attempt: art?.attempt || 1,
      });
    });

    // Delivery - always show
    nodes.push({ id: 'delivery', name: 'Delivery', icon: '🚀', status: 'pending' });

    setAgents(nodes);
  }, [artifacts, isRunning]);

  // Timer for elapsed time - calculate from actual startedAt timestamp
  useEffect(() => {
    if (!startedAt) return;
    
    const updateElapsed = () => {
      const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      setElapsedTime(elapsed);
    };
    
    // Update immediately
    updateElapsed();
    
    // Then update every second if running
    if (isRunning) {
      const interval = setInterval(updateElapsed, 1000);
      return () => clearInterval(interval);
    }
  }, [startedAt, isRunning]);

  // Reset when new run starts
  useEffect(() => {
    if (runId && isRunning) {
      setAgents(INITIAL_AGENTS.map(a => ({ ...a, status: 'pending' })));
      setLogs([]);
      setCurrentAttempt(1);
      // Don't reset elapsedTime - it's calculated from startedAt
    }
  }, [runId, isRunning]);

  // Auto-select the currently running agent (or the first completed one if none running)
  useEffect(() => {
    if (!isRunning) return;
    
    const runningAgent = agents.find(a => a.status === 'running');
    if (runningAgent && selectedAgent !== runningAgent.id) {
      setSelectedAgent(runningAgent.id);
    }
  }, [agents, isRunning, selectedAgent]);

  // Update agent state based on the log line
  const updateAgentFromLog = useCallback((line: string) => {
    const lowerLine = line.toLowerCase();
    
    // Detect which agent is currently running from "Agent X started" messages
    const agentStartMatch = line.match(/Agent "([^"]+)" started/i);
    
    if (agentStartMatch) {
      const agentRole = agentStartMatch[1];
      // Map role names to step IDs
      const roleToStep: Record<string, string> = {
        'pm-architect': 'pm-architect',
        'developer': 'developer',
        'qa-tester': 'qa-tester',
        'triage': 'triage',
        'reviewer': 'reviewer',
        'security': 'security',
        'documentation': 'documentation',
      };
      const stepId = roleToStep[agentRole];
      if (stepId) {
        currentRunningAgentRef.current = stepId;
      }
    }
    
    // Add to logs with agent context - all logs from now until the next agent starts belong to this agent
    setLogs(prev => [...prev.slice(-100), { text: line, agent: currentRunningAgentRef.current || undefined }]); // Keep last 100 lines
    
    // Detect attempt number
    const attemptMatch = line.match(/attempt[:\s]+(\d+)/i);
    if (attemptMatch) {
      setCurrentAttempt(parseInt(attemptMatch[1], 10));
    }

    // Detect agent activity
    setAgents(prev => {
      const updated = [...prev];
      
      // Prepare step completes when we see "run prepared"
      if (lowerLine.includes('run prepared')) {
        const prepIdx = updated.findIndex(a => a.id === 'prepare-run');
        if (prepIdx >= 0) {
          updated[prepIdx] = { ...updated[prepIdx], status: 'completed', activity: 'Repository ready' };
        }
        // Start PM Architect after prepare completes
        const pmIdx = updated.findIndex(a => a.id === 'pm-architect');
        if (pmIdx >= 0 && updated[pmIdx].status === 'pending') {
          updated[pmIdx] = { ...updated[pmIdx], status: 'running', activity: 'Analyzing requirements...' };
        }
      }
      
      // PM Architect starts
      if (lowerLine.includes('pm-architect') && !lowerLine.includes('finished')) {
        const idx = updated.findIndex(a => a.id === 'pm-architect');
        if (idx >= 0 && updated[idx].status === 'pending') {
          updated[idx] = { ...updated[idx], status: 'running', activity: 'Creating implementation plan...' };
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
  const agentLogs = logs
    .filter(log => {
      if (!selectedAgent) return true;
      // Show logs that belong to the selected agent, or logs that mention "run prepared" for the prepare step
      return log.agent === selectedAgent || 
             (selectedAgent === 'prepare-run' && log.text.toLowerCase().includes('run prepared'));
    })
    .map(log => log.text); // Convert back to string array for AgentDetail

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

      {/* Human-in-the-loop gate: the pipeline is paused until this is answered */}
      {pendingInput && (
        <HumanInputPanel
          input={pendingInput}
          onSubmit={handleSubmitInput}
          submitting={submittingInput}
        />
      )}

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
            <AgentDetail 
              step={selectedAgentData.id} 
              artifact={selectedArtifact}
              logs={agentLogs}
              isRunning={isRunning && selectedAgentData.status === 'running'}
            />
          </div>
        </div>
      )}

      {/* Technical Logs - only show when no agent is selected (general overview) */}
      {!selectedAgent && isRunning && logs.length > 0 && (
        <div className="bg-slate-900 rounded-lg overflow-hidden">
          <div className="w-full px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-200">Live Output</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-600 text-white">
                <span className="w-2 h-2 bg-white rounded-full animate-pulse"></span>
                Live
              </span>
            </div>
          </div>
          <div className="p-4 max-h-48 overflow-y-auto font-mono text-xs text-slate-300 space-y-1">
            {logs.slice(-30).map((log, index) => (
              <div key={index} className="hover:bg-slate-800 px-1 rounded">
                {log.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
