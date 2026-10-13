import { useEffect, useState } from 'react';

interface Agent {
  id: string;
  name: string;
  icon: string;
  description: string;
}

interface AgentTimelineProps {
  runId: string | null;
  isRunning: boolean;
}

const AGENTS: Agent[] = [
  { id: 'pm-architect', name: 'PM Architect', icon: '📋', description: 'Analyzing requirements and planning' },
  { id: 'developer', name: 'Developer', icon: '💻', description: 'Implementing changes' },
  { id: 'qa-tester', name: 'QA Tester', icon: '🧪', description: 'Running tests' },
  { id: 'security', name: 'Security', icon: '🔒', description: 'Security scan' },
  { id: 'reviewer', name: 'Code Review', icon: '👀', description: 'Reviewing code quality' },
  { id: 'triage', name: 'Triage', icon: '🔍', description: 'Analyzing feedback' },
  { id: 'documentation', name: 'Documentation', icon: '📝', description: 'Updating docs' },
  { id: 'delivery', name: 'Delivery', icon: '🚀', description: 'Committing and pushing' },
];

export function AgentTimeline({ runId, isRunning }: AgentTimelineProps) {
  const [currentAgent, setCurrentAgent] = useState<string | null>(null);
  const [completedAgents, setCompletedAgents] = useState<Set<string>>(new Set());
  const [attempt, setAttempt] = useState(1);

  useEffect(() => {
    if (!runId || !isRunning) return;

    // Listen for output to determine current agent
    const unsubscribe = window.api.on('factory:output', (outputRunId: string, line: string) => {
      if (outputRunId !== runId) return;

      // Parse agent activity from log lines
      const lowerLine = line.toLowerCase();
      
      // Detect agent starts
      if (lowerLine.includes('pm-architect') || lowerLine.includes('[factory] pm architect')) {
        setCurrentAgent('pm-architect');
      } else if (lowerLine.includes('developer') || lowerLine.includes('[factory] developer')) {
        setCurrentAgent('developer');
      } else if (lowerLine.includes('qa') || lowerLine.includes('tester')) {
        setCurrentAgent('qa-tester');
      } else if (lowerLine.includes('security')) {
        setCurrentAgent('security');
      } else if (lowerLine.includes('review')) {
        setCurrentAgent('reviewer');
      } else if (lowerLine.includes('triage')) {
        setCurrentAgent('triage');
      } else if (lowerLine.includes('documentation')) {
        setCurrentAgent('documentation');
      } else if (lowerLine.includes('delivery') || lowerLine.includes('commit')) {
        setCurrentAgent('delivery');
      }

      // Detect completions
      if (lowerLine.includes('step finished') || lowerLine.includes('completed')) {
        const agentMatch = lowerLine.match(/(pm-architect|developer|qa|security|review|triage|documentation|delivery)/);
        if (agentMatch) {
          const agentId = agentMatch[1] === 'qa' ? 'qa-tester' : 
                         agentMatch[1] === 'review' ? 'reviewer' : 
                         agentMatch[1];
          setCompletedAgents(prev => new Set(prev).add(agentId));
        }
      }

      // Detect attempt number
      const attemptMatch = line.match(/attempt[:\s]+(\d+)/i);
      if (attemptMatch) {
        setAttempt(parseInt(attemptMatch[1], 10));
      }
    });

    return () => {
      unsubscribe();
    };
  }, [runId, isRunning]);

  if (!runId || !isRunning) {
    return null;
  }

  return (
    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-900 dark:to-slate-800 border border-blue-200 dark:border-blue-800 rounded-lg p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        <div>
          <h3 className="font-semibold text-lg text-slate-900 dark:text-slate-100">
            Factory Running
            {attempt > 1 && <span className="ml-2 text-sm text-blue-600 dark:text-blue-400">(Attempt {attempt})</span>}
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">Multi-agent software development in progress</p>
        </div>
      </div>

      <div className="space-y-3">
        {AGENTS.map((agent, index) => {
          const isActive = currentAgent === agent.id;
          const isCompleted = completedAgents.has(agent.id);

          return (
            <div
              key={agent.id}
              className={`relative flex items-center gap-4 p-3 rounded-lg transition-all duration-300 ${
                isActive
                  ? 'bg-blue-100 dark:bg-blue-900/30 scale-105 shadow-md'
                  : isCompleted
                  ? 'bg-green-50 dark:bg-green-900/20'
                  : 'bg-white dark:bg-slate-800/50 opacity-60'
              }`}
            >
              {/* Connector line */}
              {index < AGENTS.length - 1 && (
                <div
                  className={`absolute left-6 top-12 w-0.5 h-6 transition-colors ${
                    isCompleted ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'
                  }`}
                />
              )}

              {/* Icon */}
              <div
                className={`relative z-10 w-12 h-12 flex items-center justify-center text-2xl rounded-full ${
                  isActive
                    ? 'bg-blue-600 animate-pulse'
                    : isCompleted
                    ? 'bg-green-500'
                    : 'bg-slate-200 dark:bg-slate-700'
                }`}
              >
                {isCompleted ? (
                  <span className="text-white text-xl">✓</span>
                ) : (
                  <span className={isActive ? 'animate-bounce' : ''}>{agent.icon}</span>
                )}
              </div>

              {/* Agent info */}
              <div className="flex-1">
                <div className={`font-medium ${
                  isActive ? 'text-blue-900 dark:text-blue-100' : 
                  isCompleted ? 'text-green-900 dark:text-green-100' :
                  'text-slate-600 dark:text-slate-400'
                }`}>
                  {agent.name}
                  {isActive && <span className="ml-2 text-xs">●</span>}
                </div>
                <div className={`text-sm ${
                  isActive ? 'text-blue-700 dark:text-blue-300' : 
                  isCompleted ? 'text-green-700 dark:text-green-300' :
                  'text-slate-500 dark:text-slate-500'
                }`}>
                  {isActive ? agent.description : isCompleted ? 'Completed' : 'Pending'}
                </div>
              </div>

              {/* Status indicator */}
              {isActive && (
                <div className="flex items-center gap-2">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
