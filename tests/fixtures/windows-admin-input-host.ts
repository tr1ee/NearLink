import type { InputState } from "../../electron/input-state";
import {
  WindowsAdminInputPolicy,
  type WindowsAdminInputEnvironment,
  type WindowsAdminInputSource,
  type WindowsAdminInputTargetProbe,
  type WindowsLocalApproval,
} from "../../electron/windows-admin-input-policy";
import {
  checkWindowsAdminInputTrust,
  type WindowsAdminInputTrust,
  type WindowsAdminInputTrustEvidence,
} from "../../electron/windows-admin-input-trust";

export type HostObservation = Omit<WindowsAdminInputEnvironment, "trust"> & {
  trustEvidence: WindowsAdminInputTrustEvidence | null;
  inputDesktopVerified: boolean;
};

type HostDiagnostic =
  | Extract<WindowsAdminInputTrust, { allowed: false }>["reason"]
  | "local-approval-refused"
  | "grant-active"
  | "release-required"
  | "medium-restored";

const unverifiedTrust: WindowsAdminInputEnvironment["trust"] = {
  signature: "unverified",
  imageAndDependenciesProtected: false,
};

// Ordinary-permission integration fixture. Helper decisions are returned as
// data for assertions; only the existing InputState can receive actual calls.
export class WindowsAdminInputHostFixture {
  private readonly policy = new WindowsAdminInputPolicy();
  private pendingReleaseReported = false;

  constructor(
    private readonly medium: Pick<InputState, "applyResult" | "release">,
    private readonly approvedPublisherKeys: ReadonlySet<string>,
    private readonly report: (diagnostic: HostDiagnostic) => void,
  ) {}

  private environment(
    observation: HostObservation,
    trust = checkWindowsAdminInputTrust(
      observation.trustEvidence,
      this.approvedPublisherKeys,
    ),
  ): WindowsAdminInputEnvironment {
    return {
      ...observation,
      console: observation.inputDesktopVerified
        ? observation.console
        : {
            ...observation.console,
            desktop: "unknown",
          },
      trust: trust.allowed ? trust.evidence : unverifiedTrust,
    };
  }

  private recordRelease(
    decision: ReturnType<WindowsAdminInputPolicy["decide"]> | null,
  ) {
    if (
      decision?.route === "reject" &&
      decision.releaseGrant !== undefined &&
      !this.pendingReleaseReported
    ) {
      this.pendingReleaseReported = true;
      this.report("release-required");
    }
    return decision;
  }

  approveLocally(approval: WindowsLocalApproval, observation: HostObservation) {
    const trust = checkWindowsAdminInputTrust(
      observation.trustEvidence,
      this.approvedPublisherKeys,
    );
    const env = this.environment(observation, trust);
    this.recordRelease(this.policy.reconcile(env));
    const grant = this.policy.begin(approval, env, () => this.medium.release());
    this.report(
      !trust.allowed
        ? trust.reason
        : grant === null
          ? "local-approval-refused"
          : "grant-active",
    );
    return grant;
  }

  observe(observation: HostObservation) {
    return this.recordRelease(
      this.policy.reconcile(this.environment(observation)),
    );
  }

  ordinaryInput(
    sessionId: string,
    event: unknown,
    observation: HostObservation,
  ) {
    if (this.observe(observation)?.route !== "medium") return "unauthorized";
    return this.medium.applyResult(sessionId, event);
  }

  candidateInput(
    command: unknown,
    source: WindowsAdminInputSource,
    observation: HostObservation,
    inspectTarget: WindowsAdminInputTargetProbe = () =>
      this.environment(observation),
  ) {
    const decision = this.recordRelease(
      this.policy.decide(
        command,
        source,
        this.environment(observation),
        inspectTarget,
      ),
    );
    return decision?.route === "medium"
      ? { route: "reject" as const }
      : decision;
  }

  stopLocally() {
    return this.recordRelease(this.policy.stop());
  }

  acknowledgeCleanup(
    grant: number,
    observation: HostObservation,
    heldStateCleared: boolean,
  ) {
    const { channel, console } = this.environment(observation);
    if (!this.policy.completeRelease(grant, channel, console, heldStateCleared))
      return false;
    this.pendingReleaseReported = false;
    this.report("medium-restored");
    return true;
  }
}
