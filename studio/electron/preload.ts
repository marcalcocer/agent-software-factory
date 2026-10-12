/**
 * Preload script - exposes safe IPC methods to the renderer.
 * Runs in the renderer context but has access to Node APIs.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IPCChannels, IPCEvents } from '../shared/events';

// Type-safe IPC invoke wrapper
function createIPC() {
  return {
    // Invoke methods (request-response)
    invoke: <K extends keyof IPCChannels>(
      channel: K,
      ...args: Parameters<IPCChannels[K]>
    ): ReturnType<IPCChannels[K]> => {
      return ipcRenderer.invoke(channel, ...args) as ReturnType<IPCChannels[K]>;
    },

    // Event listeners (main -> renderer)
    on: <K extends keyof IPCEvents>(
      channel: K,
      callback: IPCEvents[K]
    ) => {
      const subscription = (_event: Electron.IpcRendererEvent, ...args: any[]) => {
        callback(...args);
      };
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    },

    // One-time event listener
    once: <K extends keyof IPCEvents>(
      channel: K,
      callback: IPCEvents[K]
    ) => {
      ipcRenderer.once(channel, (_event, ...args: any[]) => {
        callback(...args);
      });
    },
  };
}

// Expose to renderer via window.api
contextBridge.exposeInMainWorld('api', createIPC());

// TypeScript declaration for window.api
declare global {
  interface Window {
    api: ReturnType<typeof createIPC>;
  }
}
