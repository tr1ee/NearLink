export function runtimeNetworkOptions(
  directory: string,
  packaged: boolean,
  isolatedProfile: boolean,
  allowDevLan = false,
) {
  // A separate identity stays local unless cross-device debugging is explicit.
  const isolated = !packaged && isolatedProfile && !allowDevLan;
  return {
    stateDirectory: directory,
    discovery: !isolated,
    listenHost: isolated ? "127.0.0.1" : "0.0.0.0",
  };
}
