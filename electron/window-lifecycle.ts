/** Closing a window is not permission to terminate the background service. */
export class QuitIntent {
  requested = false;
  request() {
    this.requested = true;
  }
  shouldKeepRunning(platform: NodeJS.Platform, primaryInstance: boolean) {
    return platform === "win32" && primaryInstance && !this.requested;
  }
}
