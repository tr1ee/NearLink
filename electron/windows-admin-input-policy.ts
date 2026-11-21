import { z } from "zod";

// There is no production transport, helper, launcher, or trust verifier yet.
export const WINDOWS_ADMIN_INPUT_AVAILABLE = false;

const coordinate = z.number().min(0).max(1);
const wheelDelta = z.number().min(-2000).max(2000);
const adminCommandSchema = z.strictObject({
  grant: z.number().int().positive(),
  sessionId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  event: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("move"), x: coordinate, y: coordinate }),
    z.strictObject({
      type: z.literal("button"),
      x: coordinate,
      y: coordinate,
      button: z.number().int().min(0).max(2),
      down: z.boolean(),
    }),
    z.strictObject({
      type: z.literal("wheel"),
      dx: wheelDelta,
      dy: wheelDelta,
    }),
    z.strictObject({
      type: z.literal("key"),
      down: z.boolean(),
      code: z
        .string()
        .regex(
          /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|Enter|Escape|Backspace|Tab)$/,
        ),
    }),
  ]),
});
type AdminInputEvent = z.infer<typeof adminCommandSchema>["event"];

type ConsolePrincipal = {
  userSid: string;
  logonId: string;
  consoleSession: number;
};

type Enrollment = {
  sessionId: string;
  peerFingerprint: string;
  linkId: string;
  channelId: string;
  windowInstance: string;
  desktopInstance: string;
  displayLayoutId: string;
};

export type WindowsLocalApproval = Enrollment & {
  // Issued by the local helper after explicit confirmation. Single use.
  serial: number;
  confirmedOnConsole: boolean;
};

// Identity attached at ingress by the authenticated local broker, outside
// the command payload and independent of the current active session snapshot.
export type WindowsAdminInputSource = Pick<
  Enrollment,
  "sessionId" | "peerFingerprint" | "linkId" | "channelId"
>;

// These are observations of trusted local components in a simulation. None
// may be derived from renderer, remote peer, or command data in a real helper.
export type WindowsAdminInputEnvironment = {
  now: number;
  trust: {
    signature: "pinned-publisher" | "unverified";
    imageAndDependenciesProtected: boolean;
  };
  channel: { id: string; authenticated: boolean; owner: ConsolePrincipal };
  session: {
    id: string;
    peerFingerprint: string;
    linkId: string;
    paired: boolean;
    authenticated: boolean;
    activeHostControl: boolean;
  };
  console: {
    owner: ConsolePrincipal;
    desktop: "interactive-unlocked" | "locked" | "secure" | "unknown";
    desktopInstance: string;
    displayLayoutId: string;
  };
  target: {
    instance: string;
    owner: ConsolePrincipal;
    kind: "eligible-app" | "denied" | "unknown";
    foreground: boolean;
    // Bound to this command's effective point by the trusted target probe.
    pointerInTarget: boolean;
    systemModifiersClear: boolean;
  } | null;
};

export type WindowsAdminInputTargetProbe = (
  event: Readonly<AdminInputEvent>,
) => Pick<WindowsAdminInputEnvironment, "now" | "console" | "target"> | null;

type Grant = {
  id: number;
  enrollment: Enrollment;
  owner: ConsolePrincipal;
  expiresAt: number;
  lastSeenAt: number;
  lastSequence: number;
};
type InputDecision =
  | { route: "medium" }
  | { route: "reject"; releaseGrant?: number }
  | { route: "helper"; grant: number; event: AdminInputEvent };

function samePrincipal(a: ConsolePrincipal, b: ConsolePrincipal) {
  return (
    !!a.userSid &&
    !!a.logonId &&
    Number.isSafeInteger(a.consoleSession) &&
    a.consoleSession > 0 &&
    a.userSid === b.userSid &&
    a.logonId === b.logonId &&
    a.consoleSession === b.consoleSession
  );
}

function eligible(scope: Enrollment, env: WindowsAdminInputEnvironment) {
  const { channel, session, console, target, trust } = env;
  return (
    trust.signature === "pinned-publisher" &&
    trust.imageAndDependenciesProtected &&
    channel.authenticated &&
    !!scope.channelId &&
    scope.channelId === channel.id &&
    console.desktop === "interactive-unlocked" &&
    !!scope.desktopInstance &&
    scope.desktopInstance === console.desktopInstance &&
    samePrincipal(channel.owner, console.owner) &&
    session.paired &&
    session.authenticated &&
    session.activeHostControl &&
    !!scope.sessionId &&
    scope.sessionId === session.id &&
    !!scope.peerFingerprint &&
    scope.peerFingerprint === session.peerFingerprint &&
    !!scope.linkId &&
    scope.linkId === session.linkId &&
    !!scope.displayLayoutId &&
    scope.displayLayoutId === console.displayLayoutId &&
    target?.kind === "eligible-app" &&
    !!scope.windowInstance &&
    scope.windowInstance === target.instance &&
    target.foreground &&
    samePrincipal(target.owner, console.owner)
  );
}

// A decision model only. Its effects are consumed by tests, never by the
// Electron input worker. A future helper must enforce its own copy of the
// checks and own actual input cleanup.
export class WindowsAdminInputPolicy {
  static readonly grantLifetimeMs = 60_000;
  private grant: Grant | null = null;
  private releasing: Grant | null = null;
  private lastApproval = 0;

  begin(
    approval: WindowsLocalApproval,
    env: WindowsAdminInputEnvironment,
    releaseMedium: () => boolean,
  ) {
    if (
      approval.confirmedOnConsole !== true ||
      !Number.isSafeInteger(approval.serial) ||
      approval.serial <= this.lastApproval
    )
      return null;
    this.lastApproval = approval.serial;
    if (
      this.grant ||
      this.releasing ||
      !eligible(approval, env) ||
      !Number.isFinite(env.now) ||
      env.now < 0 ||
      !releaseMedium()
    )
      return null;
    this.grant = {
      id: approval.serial,
      enrollment: { ...approval },
      owner: { ...env.console.owner },
      expiresAt: env.now + WindowsAdminInputPolicy.grantLifetimeMs,
      lastSeenAt: env.now,
      lastSequence: -1,
    };
    return this.grant.id;
  }

  stop(): InputDecision {
    if (this.grant) {
      this.releasing = this.grant;
      this.grant = null;
    }
    return this.releasing
      ? { route: "reject", releaseGrant: this.releasing.id }
      : { route: "medium" };
  }

  // From an authenticated helper cleanup acknowledgement. A missing or
  // unsuccessful acknowledgement leaves the route blocked.
  completeRelease(
    grant: number,
    channel: WindowsAdminInputEnvironment["channel"],
    console: WindowsAdminInputEnvironment["console"],
    heldStateCleared: boolean,
  ) {
    if (
      !channel.authenticated ||
      !heldStateCleared ||
      this.releasing?.id !== grant ||
      this.releasing.enrollment.channelId !== channel.id ||
      !samePrincipal(this.releasing.owner, channel.owner) ||
      !samePrincipal(this.releasing.owner, console.owner) ||
      console.desktop !== "interactive-unlocked" ||
      this.releasing.enrollment.desktopInstance !== console.desktopInstance
    )
      return false;
    this.releasing = null;
    return true;
  }

  reconcile(env: WindowsAdminInputEnvironment): InputDecision | null {
    if (this.releasing) return this.stop();
    const grant = this.grant;
    if (!grant) return { route: "medium" };
    if (
      !eligible(grant.enrollment, env) ||
      !samePrincipal(grant.owner, env.console.owner) ||
      !Number.isFinite(env.now) ||
      env.now < grant.lastSeenAt ||
      env.now >= grant.expiresAt
    )
      return this.stop();
    grant.lastSeenAt = env.now;
    return null;
  }

  decide(
    command: unknown,
    source: WindowsAdminInputSource,
    env: WindowsAdminInputEnvironment,
    inspectTarget: WindowsAdminInputTargetProbe,
  ): InputDecision {
    const state = this.reconcile(env);
    if (state) return state;

    const grant = this.grant!;
    const scope = grant.enrollment;
    if (
      source.channelId !== scope.channelId ||
      source.sessionId !== scope.sessionId ||
      source.peerFingerprint !== scope.peerFingerprint ||
      source.linkId !== scope.linkId
    )
      return { route: "reject" };
    const parsed = adminCommandSchema.safeParse(command);
    if (!parsed.success) return { route: "reject" };
    const { event, grant: id, sessionId, sequence } = parsed.data;
    if (
      id !== grant.id ||
      sessionId !== scope.sessionId ||
      sequence <= grant.lastSequence
    )
      return { route: "reject" };
    grant.lastSequence = sequence;

    // Request a fresh observation for this exact parsed event. The previous
    // snapshot can only establish eligibility, never the event's hit target.
    Object.freeze(event);
    let observation: ReturnType<WindowsAdminInputTargetProbe>;
    try {
      observation = inspectTarget(event);
    } catch {
      return this.stop();
    }
    if (!observation) return this.stop();
    const { now, console, target } = observation;
    const changed = this.reconcile({ ...env, now, console, target });
    if (changed) return changed;
    if (
      event.type === "key"
        ? target?.systemModifiersClear !== true
        : target?.pointerInTarget !== true
    )
      return this.stop();
    return { route: "helper", grant: grant.id, event };
  }
}
