import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
test("真实后台双实例：保留配对、单端重启和端口占用后恢复在线", async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(process.cwd(), "work/network-restart-"));
  const applications = new Set<Awaited<ReturnType<typeof electron.launch>>>();
  const errors: string[] = [];
  const blockedSockets = new Set<net.Socket>();
  let blocker: net.Server | undefined;
  async function launch(name: string) {
    await mkdir(path.join(root, name), { recursive: true });
    const app = await electron.launch({
      executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
      args: [process.cwd(), "--background"],
      env: { ...process.env, NEARLINK_USER_DATA: path.join(root, name) },
      timeout: 30000,
    });
    applications.add(app);
    app.on("window", (page) =>
      page.on("pageerror", (e) => errors.push(e.message)),
    );
    await app.evaluate(({ dialog, clipboard }) => {
      clipboard.read = async () => [];
      dialog.showErrorBox = (title, detail) =>
        console.error("NEARLINK_UNCAUGHT", title, detail);
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    app.process().stderr?.on("data", (b) => {
      if (String(b).includes("NEARLINK_UNCAUGHT")) errors.push(String(b));
    });
    let home: Page | undefined;
    await expect
      .poll(() => {
        home = app.windows().find((p) => p.url().includes("window=home"));
        return !!home;
      })
      .toBe(true);
    await home!.getByRole("button", { name: "设置", exact: true }).waitFor();
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    );
    expect(visible).toBe(false);
    return {
      app,
      home: home!,
      state: await home!.evaluate(() => window.nearlink.invoke("state")),
    };
  }
  try {
    const a = await launch("a"),
      b = await launch("b");
    await a.home.evaluate(
      (address) => window.nearlink.invoke("pair", address),
      `${b.state.self.host}:${b.state.self.port}`,
    );
    const id = b.state.self.id,
      port = b.state.self.port;
    await expect
      .poll(() =>
        a.home.evaluate(
          (id) =>
            window.nearlink
              .invoke("device.info", id)
              .then(() => window.nearlink.invoke("state"))
              .then((s) => s.devices.find((d: any) => d.id === id)?.id),
          id,
        ),
      )
      .toBe(id);
    await b.app.close();
    applications.delete(b.app);
    await expect
      .poll(
        () =>
          a.home.evaluate(
            (id) =>
              window.nearlink
                .invoke("state")
                .then((s) => s.devices.find((d: any) => d.id === id)?.online),
            id,
          ),
        { timeout: 10000 },
      )
      .toBe(false);
    const restarted = await launch("b");
    expect(restarted.state.self.id).toBe(id);
    expect(restarted.state.self.port).toBe(port);
    await expect
      .poll(
        () =>
          a.home.evaluate(
            (id) =>
              window.nearlink
                .invoke("device.info", id)
                .then(() => window.nearlink.invoke("state"))
                .then((s) => s.devices.find((d: any) => d.id === id)?.port)
                .catch(() => 0),
            id,
          ),
        { timeout: 10000 },
      )
      .toBe(port);
    await restarted.app.close();
    applications.delete(restarted.app);
    blocker = net.createServer((socket) => {
      blockedSockets.add(socket);
      socket.once("close", () => blockedSockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      blocker!.listen(port, "127.0.0.1", resolve),
    );
    const moved = await launch("b");
    expect(moved.state.self.id).toBe(id);
    expect(moved.state.self.port).not.toBe(port);
    await expect
      .poll(
        () =>
          a.home.evaluate(
            (id) =>
              window.nearlink
                .invoke("device.info", id)
                .then(() => window.nearlink.invoke("state"))
                .then((s) => s.devices.find((d: any) => d.id === id)?.port)
                .catch(() => 0),
            id,
          ),
        { timeout: 15000 },
      )
      .toBe(moved.state.self.port);
    await expect(
      a.home.locator(`[data-device-id="${id}"] .status-dot`),
    ).toHaveClass(/online/);
    const state = await a.home.evaluate(() => window.nearlink.invoke("state"));
    expect(state.devices.find((d: any) => d.id === id).trusted).toBe(true);
    // Native close event, not a renderer-only visibility simulation.
    const closedToTray = await moved.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=home"),
      )!;
      win.close();
      return { destroyed: win.isDestroyed(), visible: win.isVisible() };
    });
    expect(closedToTray).toEqual({ destroyed: false, visible: false });
    await a.home.evaluate(
      (id) => window.nearlink.invoke("device.info", id),
      id,
    );
    const windowsGuard = await moved.app.evaluate(({ app }) => {
      const original = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      let prevented = false;
      try {
        app.emit("before-quit", {
          preventDefault() {
            prevented = true;
          },
        });
      } finally {
        Object.defineProperty(process, "platform", {
          value: original,
          configurable: true,
        });
      }
      return prevented;
    });
    expect(windowsGuard).toBe(true);
    await a.home.evaluate(
      (id) => window.nearlink.invoke("device.info", id),
      id,
    );
    await a.home.screenshot({ path: "outputs/network-restart-actual.png" });
    expect(errors).toEqual([]);
    await writeFile(
      "outputs/network-validation.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          status: "passed",
          backgroundWindows: true,
          identityPreserved: true,
          portReused: port,
          collisionRecoveredPort: moved.state.self.port,
          checks: [
            "initial mutual TLS pairing",
            "controller stays running while peer restarts",
            "stored endpoint reused",
            "busy port fallback updates active controller",
            "authenticated device.info RPC succeeds at new port",
            "rendered device row online",
            "native close keeps home window alive and authenticated RPC connected",
            "Windows before-quit guard (platform branch simulated on macOS) keeps background service connected",
          ],
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    if (blocker) {
      for (const socket of blockedSockets) socket.destroy();
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    }
    await Promise.all([...applications].map((app) => app.close()));
  }
});
