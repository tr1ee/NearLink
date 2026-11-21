import type { WindowsAdminInputEnvironment } from "./windows-admin-input-policy";

// Observations for an isolated model. A future native verifier must derive
// these from the same file it verifies and resolves, before requesting UAC.
export type WindowsAdminInputTrustEvidence = {
  authenticode: {
    status: "valid" | "invalid" | "unavailable";
    publisherKeySha256: string;
    imageIdentity: string;
  };
  install: {
    imageIdentity: string;
    underApprovedRoot: boolean;
    imageAndParentsProtected: boolean;
    dependenciesProtected: boolean;
    pathResolutionVerified: boolean;
  };
};

type TrustFailure =
  | "publisher-policy-missing"
  | "authenticode-unverified"
  | "publisher-mismatch"
  | "verified-image-mismatch"
  | "installation-unprotected";

export type WindowsAdminInputTrust =
  | { allowed: true; evidence: WindowsAdminInputEnvironment["trust"] }
  | { allowed: false; reason: TrustFailure };

export function checkWindowsAdminInputTrust(
  evidence: WindowsAdminInputTrustEvidence | null,
  approvedPublisherKeys: ReadonlySet<string>,
): WindowsAdminInputTrust {
  if (!approvedPublisherKeys.size)
    return { allowed: false, reason: "publisher-policy-missing" };
  if (evidence?.authenticode.status !== "valid")
    return { allowed: false, reason: "authenticode-unverified" };
  const { authenticode, install } = evidence;
  if (
    !/^[a-f0-9]{64}$/.test(authenticode.publisherKeySha256) ||
    !approvedPublisherKeys.has(authenticode.publisherKeySha256)
  )
    return { allowed: false, reason: "publisher-mismatch" };
  if (
    !authenticode.imageIdentity ||
    authenticode.imageIdentity !== install.imageIdentity
  )
    return { allowed: false, reason: "verified-image-mismatch" };
  if (
    install.underApprovedRoot !== true ||
    install.imageAndParentsProtected !== true ||
    install.dependenciesProtected !== true ||
    install.pathResolutionVerified !== true
  )
    return { allowed: false, reason: "installation-unprotected" };
  return {
    allowed: true,
    evidence: {
      signature: "pinned-publisher",
      imageAndDependenciesProtected: true,
    },
  };
}
