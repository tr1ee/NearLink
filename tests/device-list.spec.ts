import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

test("我的设备只显示配对身份，附近同名设备仍可在全部设备中选择", async () => {
  const profile = await mkdtemp(path.join(process.cwd(), "work/device-list-"));
  const app = await electron.launch({
    executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
    args: [process.cwd(), "--background"],
    env: { ...process.env, NEARLINK_USER_DATA: profile },
  });
  try {
    let home = app.windows().find((p) => p.url().includes("window=home"));
    await expect
      .poll(() => {
        home = app.windows().find((p) => p.url().includes("window=home"));
        return !!home;
      })
      .toBe(true);
    await home!.getByRole("button", { name: "设置", exact: true }).waitFor();
    const state = await home!.evaluate(() => window.nearlink.invoke("state"));
    state.devices = Array.from({ length: 12 }, (_, i) => ({
      ...state.self,
      id: String(i + 1).padStart(64, "0"),
      name: "同名 Mac",
      trusted: i === 0,
    }));
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("window=home"))!
        .webContents.send("nearlink:state", snapshot);
    }, state);
    await expect(home!.locator(".sidebar .device-nav")).toHaveCount(2);
    await expect(
      home!.locator(".sidebar").getByText("未配对", { exact: true }),
    ).toHaveCount(0);
    await home!.getByRole("button", { name: "全部设备", exact: true }).click();
    await expect(home!.locator(".all-device")).toHaveCount(12);
    await expect(
      home!.locator(".all-device").filter({ hasText: "已配对" }),
    ).toHaveCount(1);
    await expect(
      home!.locator(".all-device").filter({ hasText: "未配对" }),
    ).toHaveCount(11);
    await writeFile(
      "outputs/device-list-validation.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          status: "passed",
          scope:
            "Actual Home component in hidden Electron; snapshot fixture contains 12 distinct certificates with the same name",
          sidebarDevices: 2,
          pairedPeers: 1,
          nearbyUnpaired: 11,
          trustMergedByName: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
});
