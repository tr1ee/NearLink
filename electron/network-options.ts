export function runtimeNetworkOptions(
  directory: string,
  packaged: boolean,
  isolatedProfile: boolean,
) {
  const isolated = !packaged && isolatedProfile;
  return {
    stateDirectory: directory,
    discovery: !isolated,
    listenHost: isolated ? "127.0.0.1" : "0.0.0.0",
  };
}
