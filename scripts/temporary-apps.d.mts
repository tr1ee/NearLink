export function cleanupTemporaryApps(directory: string): Promise<{
  removed: string[];
  keptRunning: string[];
}>;
