# Windows 与 Mac 联合调试

仓库：<https://github.com/tr1ee/NearLink>，开发源码位于 `main`。两端开始复现前记录 `git rev-parse HEAD` 和 `package.json` 的版本，优先使用同一提交。源码上传不会发布安装包或改变软件内更新的 Latest。

## Windows 11 x64

安装 Git、Node.js 22.12+、Visual Studio 2022 Build Tools 的「使用 C++ 的桌面开发」工作负载及 Windows SDK。以下命令在 **x64 Native Tools Command Prompt for VS 2022** 中执行，`cl` 应可用。

```bat
git clone https://github.com/tr1ee/NearLink.git
cd NearLink
npm ci
node node_modules/electron/install.js
npm run native
npm run native:update-launcher
npm run build
npm test
set "NEARLINK_USER_DATA=%LOCALAPPDATA%\NearLink-Dev"
npm start
```

原生输入模块与 DXGI 模块由 `npm run native` 编译到 `native/prebuilds/win32-x64/`；更新启动器由 `npm run native:update-launcher` 编译。仓库不携带这些二进制文件。运行时需要保持普通用户权限，以保留管理员窗口输入故障的复现条件。

开发实例使用独立的用户数据目录，需要重新核对指纹配对，不会复用已安装版本的身份。启动前从托盘完全退出已安装版本，避免连接到旧实例。更改源码后重新执行 `npm run build` 并重启开发实例。

需要生成本机安装包时运行 `npm run package:win`，结果位于 `outputs/installers/`。联合调试不需要发布私钥，也不需要运行 `release:manifest` 或 `release:publish`。

## macOS 14.2+

安装 Node.js 22.12+ 与 Xcode Command Line Tools。在仓库目录运行：

```sh
npm ci
node node_modules/electron/install.js
npm run native
npm run build
npm test
NEARLINK_USER_DATA="$PWD/work/dev-user-data" npm start
```

开发实例仍需系统允许屏幕录制及辅助功能。与 Windows 开发实例重新配对后测试。使用已安装版本作对照时，分别记录版本与启动参数。

## 当前排查入口

- 控制端鼠标与松键：`src/Session.tsx`、`src/media/input.ts`、`src/media/engine.ts`、`src/media/keyboard.ts`。
- Windows 输入工作进程：`electron/windows-input.ts`、`electron/input-worker.ts`、`electron/input-state.ts`、`native/windows.cc`、`native/windows-mouse.h`。
- 采集与性能：`electron/windows-capture.ts`、`electron/capture-worker.ts`、`native/dxgi-capture.cc`、`src/media/dxgi.ts`、`src/media/feedback.ts`。
- 管理员窗口的输入原型与未完成验收见 [Windows 管理员窗口输入原型](windows-admin-input.md)。相关策略与夹具尚未启用到生产输入链路，不能将原型测试通过当作真机修复完成。

复现时区分普通窗口、普通托盘窗口与高权限窗口。分别观察视频是否继续、鼠标移动/按下/松开是否到达，以及输入 worker 是否就绪。整应用提权后连接零帧需要独立排查。

单元及回环网络测试使用 `npm test`，生产构建使用 `npm run build`。`npm run test:e2e` 需要可用桌面与相关系统权限；本机通过不能替代跨设备 Windows 实测。

## 协作与隐私

开始修改前先 `git pull --ff-only`，为修复建立单独分支，例如 `git switch -c codex/windows-input-debug`。提交修复时附复现步骤、两端提交/版本、相关测试结果，并通过 PR 合并，避免两端直接覆盖同一文件。

仅提交源码、脱敏复现步骤和合成测试夹具。不要提交 `.release/`、环境变量文件、身份或配对数据、私钥、原始日志、诊断导出、屏幕截图/录屏、个人文件或真实设备地址。诊断资料如需共享，应先逐项删去设备名、用户名、路径、IP、指纹、会话标识及任何内容数据。提交前使用 `git diff --cached` 检查实际内容；`.gitignore` 不会过滤已跟踪文件中的敏感信息。

`resources/update-public.pem` 是客户端验证更新所需的公开验证密钥，应保留；签名私钥只在本机保存。Git 提交身份应使用 GitHub 提供的 noreply 邮箱。
