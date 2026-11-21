import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
async function launch(name: string) {
  const data = await mkdtemp(path.join(process.cwd(), "work", name));
  const app = await electron.launch({
    executablePath:process.env.NEARLINK_ELECTRON_EXECUTABLE,
    args: [process.cwd()],
    env: { ...process.env, NEARLINK_USER_DATA: data },
    timeout: 30000,
  });
  const errors: string[] = [];
  app.process().stderr?.on("data", (b) => {
    const text = String(b);
    if (text.includes("NEARLINK_UNCAUGHT")) errors.push(text);
    if (text.includes("only supports even")) errors.push(text);
    if (/ERROR|Error|audio|capture/i.test(text))
      console.log("[electron]", text.slice(0, 1500));
  });
  app.on("window", (p) => {
    p.on("pageerror", (e) => {
      errors.push(e.message);
      console.log("[renderer error]", e.message);
    });
  });
  await app.evaluate(({ dialog, clipboard }) => {
    // This test covers windows/network/files/video. Preserve the operator's
    // clipboard; real cross-computer clipboard validation is a separate step.
    clipboard.read = async () => [];
    dialog.showErrorBox = (title, content) =>
      console.error("NEARLINK_UNCAUGHT", title, content);
    dialog.showMessageBox = async (..._args: any[]) => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  let page: Page | undefined;
  await expect
    .poll(
      () => {
        page = app.windows().find((p) => p.url().includes("window=home"));
        return !!page;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect(
    page!.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  return { app, page: page!, errors, data };
}
test("真实Electron首页、设置、后台恢复与双端TLS文件传输", async () => {
  test.setTimeout(120000);
  const a = await launch("e2e-a-");
  let b: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await expect(a.page).toHaveTitle("近控 NearLink");
    await expect(a.page.getByText("连接选项", { exact: true })).toHaveCount(0);
    await a.page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      a.page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
    const { version } = JSON.parse(await readFile("package.json", "utf8"));
    await expect(a.page.getByText(`当前版本 ${version}`, { exact: true })).toBeVisible();
    const update = await a.page.evaluate(() =>
      window.nearlink.invoke("updates.state"),
    );
    expect(update.feedUrl).toBe(
      "https://github.com/tr1ee/NearLink/releases/latest/download/nearlink-update.json",
    );
    await a.page.getByRole("button", { name: "完成", exact: true }).click();
    const windowId = await a.app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("window=home"),
        )!.id,
    );
    await a.app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(),
      windowId,
    );
    await expect
      .poll(() =>
        a.app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(),
          windowId,
        ),
      )
      .toBe(false);
    await a.app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.show(),
      windowId,
    );
    await expect(
      a.page.getByRole("button", { name: "设置", exact: true }),
    ).toBeVisible();
    console.log("phase: home lifecycle passed");
    b = await launch("e2e-b-");
    const stateB = await b.page.evaluate(() => window.nearlink.invoke("state"));
    const stateA = await a.page.evaluate(() => window.nearlink.invoke("state"));
    console.log("source permissions",stateB.permissions);
    console.log("phase: second instance ready");
    const unauthorized = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = https.get(
          {
            host: stateB.self.host,
            port: stateB.self.port,
            path: "/file?path=unauthorized",
            rejectUnauthorized: false,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
      },
    );
    expect(unauthorized).toBe(403);
    const paired = await a.page.evaluate(
      (address) => window.nearlink.invoke("pair", address),
      `${stateB.self.host}:${stateB.self.port}`,
    );
    expect(paired.trusted).toBe(true);
    console.log("phase: pairing passed");
    await expect
      .poll(() =>
        b!.page.evaluate(
          (id) =>
            window.nearlink
              .invoke("state")
              .then((s) => s.devices.find((d: any) => d.id === id)?.trusted),
          stateA.self.id,
        ),
      )
      .toBe(true);
    await a.page.evaluate(
      (id) => window.nearlink.invoke("files.open", id),
      stateB.self.id,
    );
    let files: Page | undefined;
    await expect
      .poll(() => {
        files = a.app.windows().find((p) => p.url().includes("window=files"));
        return !!files;
      })
      .toBe(true);
    await expect(
      files!.getByRole("button", { name: "上传 →", exact: true }),
    ).toBeVisible();
    const sourceDir = path.join(a.data, "transfer-source");
    await mkdir(sourceDir);
    const source = path.join(sourceDir, "source.txt"),
      destination = path.join(b.data, "received");
    await writeFile(source, "NearLink TLS transfer\n中文内容\n");
    await mkdir(destination);
    await files!.evaluate(
      ({ source, destination }) =>
        window.nearlink.invoke("files.transfer", "upload", source, destination),
      { source, destination },
    );
    await expect
      .poll(
        () =>
          a.page.evaluate(() =>
            window.nearlink
              .invoke("state")
              .then((s) => s.transfers.at(-1)?.state),
          ),
        { timeout: 30000 },
      )
      .toBe("completed");
    expect(await readFile(path.join(destination, "source.txt"), "utf8")).toBe(
      "NearLink TLS transfer\n中文内容\n",
    );
    await files!.evaluate(
      ({ source, destination }) =>
        window.nearlink.invoke("files.transfer", "upload", source, destination),
      { source, destination },
    );
    await expect
      .poll(
        () =>
          a.page.evaluate(() =>
            window.nearlink
              .invoke("state")
              .then(
                (s) =>
                  s.transfers.filter((t: any) => t.state === "completed")
                    .length,
              ),
          ),
        { timeout: 30000 },
      )
      .toBe(2);
    expect(
      await readFile(path.join(destination, "source (1).txt"), "utf8"),
    ).toContain("中文内容");
    const downloadDir = path.join(a.data, "downloaded");
    await mkdir(downloadDir);
    await files!.evaluate(
      ({ source, destination }) =>
        window.nearlink.invoke(
          "files.transfer",
          "download",
          source,
          destination,
        ),
      {
        source: path.join(destination, "source.txt"),
        destination: downloadDir,
      },
    );
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          window.nearlink
            .invoke("state")
            .then(
              (s) =>
                s.transfers.filter((t: any) => t.state === "completed").length,
            ),
        ),
      )
      .toBe(3);
    expect(
      await readFile(path.join(downloadDir, "source.txt"), "utf8"),
    ).toContain("中文内容");
    await mkdir(path.join(sourceDir, "empty"));
    await files!.evaluate(
      ({ source, destination }) =>
        window.nearlink.invoke("files.transfer", "upload", source, destination),
      { source: sourceDir, destination },
    );
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          window.nearlink
            .invoke("state")
            .then(
              (s) =>
                s.transfers.filter((t: any) => t.state === "completed").length,
            ),
        ),
      )
      .toBe(4);
    expect(
      (
        await stat(path.join(destination, "transfer-source", "empty"))
      ).isDirectory(),
    ).toBe(true);
    await a.page.locator(`[data-device-id="${stateB.self.id}"]`).click();
    await files!.getByRole("textbox").nth(0).fill(sourceDir);
    await files!.getByRole("textbox").nth(0).press("Enter");
    await files!.getByRole("textbox").nth(1).fill(destination);
    await files!.getByRole("textbox").nth(1).press("Enter");
    await expect(
      files!.getByRole("row").filter({ hasText: "source.txt" }).first(),
    ).toBeVisible();
    await files!
      .getByRole("button", { name: "选择本机文件夹", exact: true })
      .click();
    const chooser = files!.getByRole("dialog", {
      name: "选择本机文件夹",
      exact: true,
    });
    await expect(
      chooser.getByRole("button", { name: "个人文件夹", exact: true }),
    ).toBeVisible();
    await chooser.getByRole("button", { name: "empty", exact: true }).click();
    await chooser
      .getByRole("button", { name: "选择当前文件夹", exact: true })
      .click();
    await expect(files!.getByRole("textbox").nth(0)).toHaveValue(
      path.join(sourceDir, "empty"),
    );
    await files!.getByRole("button", { name: /本机.*上一级/ }).click();
    await files!
      .getByRole("button", { name: "选择对端文件夹", exact: true })
      .click();
    const remoteChooser = files!.getByRole("dialog", {
      name: "选择对端文件夹",
      exact: true,
    });
    await remoteChooser
      .getByRole("button", { name: "transfer-source", exact: true })
      .click();
    await files!.screenshot({ path: "outputs/folder-picker.png" });
    await remoteChooser
      .getByRole("button", { name: "选择当前文件夹", exact: true })
      .click();
    await expect(files!.getByRole("textbox").nth(1)).toHaveValue(
      path.join(destination, "transfer-source"),
    );
    await files!.getByRole("button", { name: /对端.*上一级/ }).click();
    await files!
      .getByRole("checkbox", { name: "选择source.txt", exact: true })
      .first()
      .check();
    await expect(
      files!.getByRole("button", { name: "上传 →", exact: true }),
    ).toBeEnabled();
    await expect(a.page.locator(".desktop-preview img")).toBeVisible({
      timeout: 15000,
    });
    await a.page.screenshot({ path: "outputs/home-actual.png" });
    await files!.screenshot({ path: "outputs/files-actual.png" });
    console.log("phase: files passed, starting media");
    await a.page.evaluate(
      (id) => window.nearlink.invoke("connect", id, false),
      stateB.self.id,
    );
    console.log("phase: media window created");
    let remote: Page | undefined;
    await expect
      .poll(() => {
        remote = a.app.windows().find((p) => p.url().includes("window=remote"));
        return !!remote;
      })
      .toBe(true);
    await expect
      .poll(
        () =>
          a.page.evaluate(() =>
            window.nearlink.invoke("state").then((s) => s.session?.state),
          ),
        { timeout: 30000 },
      )
      .toBe("connected");
    await expect
      .poll(
        () =>
          remote!
            .locator("video")
            .evaluate((v: HTMLVideoElement) => v.videoWidth),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    const mediaSize = await remote!
      .locator("video")
      .evaluate((v: HTMLVideoElement) => ({
        width: v.videoWidth,
        height: v.videoHeight,
      }));
    console.log("phase: real video received", mediaSize);
    await expect
      .poll(
        () =>
          a.app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows().find((w) =>
              w.webContents.getURL().includes("window=remote"),
            )!;
            return w.isFullScreen() || w.isSimpleFullScreen();
          }),
        { timeout: 15000 },
      )
      .toBe(true);
    console.log("phase: fullscreen passed");
    await remote!.evaluate(() =>
      window.nearlink.invoke("window.fullscreen", false),
    );
    await expect
      .poll(() =>
        a.app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes("window=remote"),
          )!;
          return w.isFullScreen() || w.isSimpleFullScreen();
        }),
      )
      .toBe(false);
    const windowed = await a.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=remote"),
      )!;
      w.setBounds({ x: 130, y: 90, width: 1020, height: 700 });
      return {
        bounds: w.getBounds(),
        movable: w.isMovable(),
        resizable: w.isResizable(),
        frame: w.hasShadow(),
      };
    });
    expect(windowed.movable).toBe(true);
    expect(windowed.resizable).toBe(true);
    expect(windowed.bounds.width).toBe(1020);
    expect(windowed.bounds.height).toBe(700);
    const stableSession = await a.page.evaluate(() =>
      window.nearlink.invoke("state").then((s) => s.session.id),
    );
    await a.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("window=remote"))!
        .close(),
    );
    await expect
      .poll(() =>
        a.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().includes("window=remote"))!
            .isVisible(),
        ),
      )
      .toBe(false);
    await a.page.evaluate(
      (id) => window.nearlink.invoke("connect", id, false),
      stateB.self.id,
    );
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          window.nearlink.invoke("state").then((s) => s.session.id),
        ),
      )
      .toBe(stableSession);
    await expect
      .poll(() =>
        a.app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes("window=remote"),
          )!;
          return w.isFullScreen() || w.isSimpleFullScreen();
        }),
      )
      .toBe(true);
    // Both instances share one physical display in this test. Remove the
    // controller overlay so the source test scene can actually be captured.
    await a.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=remote"),
      )!;
      w.setSimpleFullScreen(false);
      w.hide();
    });
    const viewport = await remote!.evaluate(() =>
      window.nearlink.invoke("benchmark.open"),
    );
    console.log("benchmark viewport", viewport);
    console.log("phase: benchmark opened");
    const bench = b.app
      .windows()
      .find((p) => p.url().includes("window=benchmark"))!;
    await bench.screenshot({ path: "work/benchmark-source.png" });

    await expect
      .poll(
        () =>
          remote!
            .locator("video")
            .evaluate((video: HTMLVideoElement, viewport: any) => {
              const c = document.createElement("canvas");
              c.width = 16;
              c.height = 1;
              const ctx = c.getContext("2d")!;
              for (let i = 0; i < 16; i++)
                ctx.drawImage(
                  video,
                  Math.round(
                    video.videoWidth *
                      (viewport.x +
                        (0.01 + (i + 0.5) * 0.008) * viewport.width),
                  ),
                  Math.round(
                    video.videoHeight * (viewport.y + 0.02 * viewport.height),
                  ),
                  1,
                  1,
                  i,
                  0,
                  1,
                  1,
                );
              const rgba = ctx.getImageData(0, 0, 16, 1).data;
              let code = 0;
              for (let i = 0; i < 16; i++)
                code =
                  (code << 1) |
                  (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2] > 380
                    ? 1
                    : 0);
              return code;
            }, viewport),
        { timeout: 15000 },
      )
      .toBe(0x4e4c);
    const rect = await remote!.locator("video").boundingBox();
    await remote!.mouse.click(
      rect!.x + rect!.width / 2,
      rect!.y + rect!.height / 2,
    );
    await expect
      .poll(
        () =>
          bench.evaluate(() => {
            const c = document.querySelector("canvas")!,
              ctx = c.getContext("2d")!;
            let id = 0;
            for (let i = 16; i < 32; i++) {
              const p = ctx.getImageData(
                Math.round(c.width * (0.01 + (i + 0.5) * 0.008)),
                Math.round(c.height * 0.02),
                1,
                1,
              ).data;
              id = (id << 1) | (p[0] + p[1] + p[2] > 380 ? 1 : 0);
            }
            return id;
          }),
        { timeout: 5000 },
      )
      .toBe(1);
    await remote!.evaluate(() => window.dispatchEvent(new Event("focus")));
    await remote!.mouse.move(
      rect!.x + rect!.width / 2,
      rect!.y + rect!.height / 2,
    );
    await expect(remote!.locator("video")).toHaveCSS("cursor", "none");
    await remote!.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(remote!.locator("video")).not.toHaveCSS("cursor", "none");
    const editor = await bench.locator("textarea").boundingBox();
    const canvas = await bench.locator("canvas").boundingBox();
    const nx =
      viewport.x +
      ((editor!.x + editor!.width / 2 - canvas!.x) / canvas!.width) *
        viewport.width;
    const ny =
      viewport.y +
      ((editor!.y + editor!.height / 2 - canvas!.y) / canvas!.height) *
        viewport.height;
    const fit = await remote!
      .locator("video")
      .evaluate((v: HTMLVideoElement) => {
        const r = v.getBoundingClientRect(),
          scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return {
          x: r.x + (r.width - v.videoWidth * scale) / 2,
          y: r.y + (r.height - v.videoHeight * scale) / 2,
          width: v.videoWidth * scale,
          height: v.videoHeight * scale,
        };
      });
    await remote!.mouse.click(fit.x + nx * fit.width, fit.y + ny * fit.height);
    await expect(
      remote!.getByRole("textbox", { name: "远程键盘输入" }),
    ).toBeFocused();
    await expect
      .poll(() =>
        bench.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
      )
      .toBe("被控端键盘测试");
    await remote!.keyboard.type("NearLink 123", { delay: 30 });
    await expect(bench.locator("textarea")).toHaveValue("NearLink 123");
    await remote!.keyboard.insertText("中文");
    await expect(bench.locator("textarea")).toHaveValue("NearLink 123中文");
    await remote!.keyboard.press("Backspace");
    await expect(bench.locator("textarea")).toHaveValue("NearLink 123中");
    await remote!.keyboard.press("Meta+a");
    await expect.poll(()=>bench.locator("textarea").evaluate((e:HTMLTextAreaElement)=>e.selectionStart===0&&e.selectionEnd===e.value.length)).toBe(true);
    await remote!.keyboard.type("Keyboard OK",{delay:30});
    await expect(bench.locator("textarea")).toHaveValue("Keyboard OK");
    await remote!.evaluate(() =>
      document
        .querySelector<HTMLButtonElement>('button[title="分辨率与帧率"]')!
        .click(),
    );
    await remote!
      .getByRole("button", { name: "原生清晰", exact: true })
      .click();
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          window.nearlink.invoke("state").then((s) => s.session.quality.auto),
        ),
      )
      .toBe(false);
    await remote!.getByLabel("画面显示").selectOption("pixel");
    await expect
      .poll(() =>
        remote!
          .locator("video")
          .evaluate(
            (v: HTMLVideoElement) =>
              Math.abs(
                v.getBoundingClientRect().width -
                  v.videoWidth / devicePixelRatio,
              ) < 1,
          ),
      )
      .toBe(true);
    await remote!.screenshot({ path: "outputs/quality-actual.png" });
    await remote!.getByLabel("画面显示").selectOption("fit");
    await remote!
      .getByRole("button", { name: "关闭面板", exact: true })
      .click();
    const audioTrackCount = await remote!
      .locator("video")
      .evaluate(
        (v: HTMLVideoElement) =>
          (v.srcObject as MediaStream).getAudioTracks().length,
      );
    // The audio player uses a separate stream, so video presentation never waits on audio.
    expect(audioTrackCount).toBe(0);
    const sourceState = await b.page.evaluate(() =>
      window.nearlink.invoke("state"),
    );
    expect(sourceState.session.reason ?? "").not.toContain("worklet");
    await b.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("window=benchmark"))!
        .close(),
    );
    await a.page.evaluate(
      (id) => window.nearlink.invoke("connect", id, false),
      stateB.self.id,
    );
    await a.app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(),
      windowId,
    );
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          window.nearlink.invoke("state").then((s) => s.session?.state),
        ),
      )
      .toBe("connected");
    await remote!.screenshot({ path: "outputs/remote-actual.png" });
    await remote!.evaluate(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="性能诊断"]')!
        .click(),
    );
    await expect(
      remote!.getByRole("heading", { name: "性能诊断" }),
    ).toBeVisible();
    await remote!.screenshot({ path: "outputs/diagnostics-actual.png" });
    console.log("phase: media lifecycle passed");
    console.log("phase: disconnect requested");
    await a.page.evaluate(() => window.nearlink.invoke("session.disconnect"));
    console.log("phase: disconnect returned");
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          window.nearlink.invoke("state").then((s) => s.session),
        ),
      )
      .toBe(null);
    const permissions = await a.page.evaluate(() =>
      window.nearlink.invoke("state").then((s) => s.permissions),
    );
    await writeFile(
      "outputs/local-validation.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          browser: "Browser plugin unavailable; Playwright Electron",
          electron: await a.app.evaluate(
            ({ app }) => process.versions.electron,
          ),
          permissions,
          pairing:
            "two local Electron instances, TLS device identity checked, dialogs auto-accepted in test process",
          fileTransfer:
            "passed: TLS upload/download, UTF-8 content, collision rename, folder and empty-directory copy",
          unauthorizedHttps: "403, no client identity supplied",
          remoteVideo: {
            status:
              "real local loopback received and fullscreen lifecycle verified",
            ...mediaSize,
          },
          dynamicMarker: "source canvas marker received in actual remote video",
          nativeInput:
            "passed: click, English text, Chinese committed text, Backspace, Command+A through actual native input into source textarea",
          fixes: {
            folderPicker:
              "local and remote GUI picker navigated and confirmed; checkbox selection verified",
            windowed:
              "movable/resizable, changed to 1020x700 without changing session",
            cursor: "hidden over connected desktop; restored on blur",
          },
          audio:
            "remote audio track negotiated; listening and cross-machine sync not verified",
          fourK60: "not measured",
          eightHour: "not run",
          clipboard:
            "not exercised; reads disabled in test processes to preserve the operator clipboard",
          errors: [...a.errors, ...b.errors],
        },
        null,
        2,
      ),
    );
  } finally {
    if (b) await b.app.close();
    await a.app.close();
  }
  const report = JSON.parse(
    await readFile("outputs/local-validation.json", "utf8"),
  );
  report.errors = [...a.errors, ...(b?.errors ?? [])];
  report.e2eStatus = report.errors.length ? "failed" : "passed";
  await writeFile(
    "outputs/local-validation.json",
    JSON.stringify(report, null, 2),
  );
  expect(a.errors).toEqual([]);
  expect(b?.errors ?? []).toEqual([]);
});
