const { execFileSync } = require("node:child_process");
module.exports = async (context) => {
  if (context.electronPlatformName === "darwin")
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", "-", context.appOutDir + "/NearLink.app"],
      { stdio: "inherit" },
    );
};
