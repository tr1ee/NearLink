import type {
  WindowsAdminInputEnvironment,
  WindowsAdminInputSource,
  WindowsLocalApproval,
} from "../../electron/windows-admin-input-policy";

export const source: WindowsAdminInputSource = {
  sessionId: "host-session",
  peerFingerprint: "paired-peer",
  linkId: "authenticated-link",
  channelId: "local-helper-channel",
};
export const approval: WindowsLocalApproval = {
  ...source,
  serial: 1,
  confirmedOnConsole: true,
  windowInstance: "eligible-window-instance",
  desktopInstance: "initial-input-desktop",
  displayLayoutId: "initial-desktop-layout",
};
export const key = { type: "key", code: "KeyA", down: true };
export const command = (sequence = 0, event: unknown = key) => ({
  grant: approval.serial,
  sessionId: approval.sessionId,
  sequence,
  event,
});

export function environment(): WindowsAdminInputEnvironment {
  const owner = {
    userSid: "user-sid",
    logonId: "local-logon",
    consoleSession: 2,
  };
  return {
    now: 100,
    trust: {
      signature: "pinned-publisher",
      imageAndDependenciesProtected: true,
    },
    channel: { id: source.channelId, authenticated: true, owner: { ...owner } },
    session: {
      id: source.sessionId,
      peerFingerprint: source.peerFingerprint,
      linkId: source.linkId,
      paired: true,
      authenticated: true,
      activeHostControl: true,
    },
    console: {
      owner: { ...owner },
      desktop: "interactive-unlocked",
      desktopInstance: approval.desktopInstance,
      displayLayoutId: approval.displayLayoutId,
    },
    target: {
      instance: approval.windowInstance,
      owner: { ...owner },
      kind: "eligible-app",
      foreground: true,
      pointerInTarget: true,
      systemModifiersClear: true,
    },
  };
}
