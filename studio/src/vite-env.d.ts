/// <reference types="vite/client" />

import type { IPCChannels, IPCEvents } from '@shared/events';

// Declare window.api for the renderer process
declare global {
  interface Window {
    api: {
      invoke: <K extends keyof IPCChannels>(
        channel: K,
        ...args: Parameters<IPCChannels[K]>
      ) => ReturnType<IPCChannels[K]>;
      
      on: <K extends keyof IPCEvents>(
        channel: K,
        callback: IPCEvents[K]
      ) => () => void;
      
      once: <K extends keyof IPCEvents>(
        channel: K,
        callback: IPCEvents[K]
      ) => void;
    };
  }
}
