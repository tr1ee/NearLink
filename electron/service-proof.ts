import { sign, X509Certificate } from "node:crypto";
import type { Identity } from "./identity";
import type { SessionInfo } from "../src/shared/protocol";

// A controller signs only the challenge of its actual active host session.
// The service independently verifies the certificate fingerprint installed by
// the administrator; the Medium broker cannot invent an approved peer identity.
export function desktopServiceProof(
  identity: Identity,
  host: string,
  session: SessionInfo | null,
  challenge: unknown,
) {
  if (typeof challenge !== "string" || challenge.length > 511)
    throw Error("无效服务认证请求");
  const match =
    /^NearLink desktop service v1\n([a-f0-9]{64})\n([a-f0-9-]{36}):([a-f0-9]{64}):([a-f0-9-]{36})\n([1-9][0-9]{0,9})\n([a-f0-9]{64})\n(control|view)\n$/.exec(
      challenge,
    );
  if (
    !match ||
    match[1] !== host ||
    match[3] !== identity.fingerprint ||
    !session ||
    session.role !== "controller" ||
    session.peerId !== host ||
    session.id !== match[2] ||
    session.state === "reconnecting" ||
    session.state === "disconnected" ||
    (match[7] === "control" && session.viewOnly)
  )
    throw Error("服务认证与当前远控会话不符");
  return {
    certificate: new X509Certificate(identity.cert).raw.toString("hex"),
    proof: sign("sha256", Buffer.from(challenge), {
      key: identity.key,
      dsaEncoding: "ieee-p1363",
    }).toString("hex"),
  };
}
