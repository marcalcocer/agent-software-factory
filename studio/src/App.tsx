import { useEffect, useState } from 'react';
import type { AuthProvider } from '@shared/types';

function App() {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Test IPC communication
    window.api.invoke('auth:status')
      .then(setProviders)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleLogin = async () => {
    try {
      const success = await window.api.invoke('auth:login', 'claude-cli');
      if (success) {
        // Refresh provider status
        const updated = await window.api.invoke('auth:status');
        setProviders(updated);
      }
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
        <div className="px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">AI Factory Studio</h1>
          <div className="text-sm text-slate-500">v0.1.0</div>
        </div>
      </header>

      {/* Main Content */}
      <main className="p-8">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Welcome */}
          <section className="bg-white dark:bg-slate-800 rounded-lg p-6 shadow-sm">
            <h2 className="text-2xl font-bold mb-4">Welcome to AI Factory Studio</h2>
            <p className="text-slate-600 dark:text-slate-300 mb-4">
              A desktop UI for the multi-agent software factory. This is Phase 1 - Foundation.
            </p>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                <span>Electron + Vite + React structure</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                <span>Type-safe IPC bridge</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                <span>Monorepo structure (factory/ + studio/)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">✓</span>
                <span>Auto-login flow for Claude CLI</span>
              </div>
            </div>
          </section>

          {/* Auth Status */}
          <section className="bg-white dark:bg-slate-800 rounded-lg p-6 shadow-sm">
            <h3 className="text-lg font-semibold mb-4">Authentication Status</h3>
            {loading ? (
              <div className="text-slate-500">Loading...</div>
            ) : (
              <div className="space-y-3">
                {providers.map((provider) => (
                  <div
                    key={provider.id}
                    className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded"
                  >
                    <div className="flex-1">
                      <div className="font-medium">{provider.name}</div>
                      {provider.details && (
                        <div className="text-sm text-slate-500">{provider.details}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium ${
                          provider.status === 'authenticated'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
                            : provider.status === 'expired'
                            ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100'
                            : 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-100'
                        }`}
                      >
                        {provider.status}
                      </span>
                      {provider.id === 'claude-cli' && provider.status !== 'authenticated' && (
                        <button
                          onClick={handleLogin}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm"
                        >
                          Login
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Next Steps */}
          <section className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-6 border border-blue-200 dark:border-blue-800">
            <h3 className="text-lg font-semibold mb-2 text-blue-900 dark:text-blue-100">
              Next: Phase 2 - Core UI
            </h3>
            <ul className="space-y-1 text-sm text-blue-800 dark:text-blue-200">
              <li>• Sidebar with repository list</li>
              <li>• Tab management for multiple repos</li>
              <li>• Task input form</li>
              <li>• Run execution and history</li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
