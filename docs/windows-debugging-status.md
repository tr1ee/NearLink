# Windows 真机调试记录

记录日期：2026-11-21。当前阶段：已完成普通权限基线、WeGame 前台输入失效及整应用提权零帧的双端复现；两项权限相关问题尚未修复，普通托盘及长期稳定性仍待验收。

## 两端构建与启动条件

| 项目 | Windows 被控端 | Mac 控制端 |
| --- | --- | --- |
| 版本与架构 | 0.1.13，x64 | 0.1.13，Apple Silicon arm64 |
| 源码基线 | `87d050f2f3029140e1d5b5cd21ca2835d3ff611a` | 操作者报告源码为同一提交，工作区干净 |
| 实际运行产物 | 本机从基线构建，随后加入本分支的显式局域网调试选项并重新构建 | 已安装应用；操作者确认部分主进程脚本与源码构建产物不一致，不能归属到该源码提交 |
| 启动 | `npm run build` 后 `npm start`，独立 `NEARLINK_USER_DATA`；修复后显式设置 `NEARLINK_DEV_LAN=1` | 已安装应用，无额外启动参数 |
| 权限与采集 | 主进程和输入 utility process 的 TokenIntegrityLevel 均实测为 Medium；未加 `--nearlink-dxgi`，默认 Chromium 采集 | 权限与实际采集行为待双端复现时核对 |

本机最初无运行中的 NearLink，也无已安装的 VS C++ Build Tools。已安装 VS 2022 Build Tools 17.14.45、x64 C++ 工具和 Windows SDK 10.0.26100，并使用 Node.js 22.20.0、锁文件依赖及 Electron 45.4.1 构建。输入、DXGI 原生模块和更新启动器均完成本机编译；原生模块可加载。未生成或发布安装包。

管理员输入文档中的“0.1.14 实测”属于历史记录，不能作为上述 0.1.13 构建的运行证据。

## 已复现并修复：独立开发身份无法接受局域网连接

复现步骤：

1. 在基线执行文档中的生产构建和原生构建。
2. 设置独立 `NEARLINK_USER_DATA`，通过 `npm start` 启动未打包实例。
3. 检查本机页面和实际 TCP 监听，分别连接回环地址及本机局域网地址。

结果：实例只监听 `127.0.0.1:51820`；回环连接成功，本机局域网地址的连接超时。`runtimeNetworkOptions` 把“未打包且使用独立身份”同时解释为“禁用发现且仅监听回环”。原联合调试文档因此不能直接用于跨设备连接。这是复现环境的独立阻塞项，不是高权限输入、托盘手势或整应用提权后零帧的根因结论。

修改：增加 `NEARLINK_DEV_LAN=1` 显式选择局域网监听和发现，默认仍保持回环测试隔离；两处 Runtime 初始化均使用此选项。文档补充 Windows CMD、PowerShell 和 Mac 启动方式，测试覆盖独立目录保留、默认隔离及正式应用行为。

真机验证：完全退出旧开发实例，以同一身份目录、普通权限和新选项重启。实际 TCP 监听变为 `0.0.0.0:51820`，回环及本机局域网地址均可连接；记录到输入 worker `ready`、专用端口 `port-attached` 和隐藏 host 页面 `ready`。这仅证明本机监听和启动链路就绪，尚不能证明跨设备认证、媒体协商或输入完成。

随后操作者确认已配对。Windows 记录到认证成功、会话 `connected`、Chromium 采集 1920 × 1080、NVIDIA H.264 编码，host 累计帧数持续增长；抽样采集／编码速率约 33–44 fps。普通记事本接收到要求的合成文本，窗口标题随之变化。Mac 实际显示情况、拖动松手、最小化／恢复及长期性能仍需操作反馈，不能把 host 帧数等同于控制端呈现帧数。

操作者随后确认普通记事本的画面、输入、拖动松手和最小化／恢复均无异常。这是本轮普通权限跨设备基线；不代表长期性能已验收。

## 已复现：双击 WeGame 后前台输入失效

1. 保持上述普通权限 NearLink 会话，从 Mac 双击隐藏图标面板中的 WeGame。
2. WeGame 界面出现后，Mac 无法操作。
3. 操作者反馈：关闭、最小化 WeGame 或让其不处于最上层后，同一远控会话恢复。

独立只读 token 查询确认 NearLink 主进程和输入 worker 为 Medium；WeGame 主进程、`wegame_env.exe`、`rail.exe` 及负责实际界面的 `browser.exe` 为 High。这是完整性等级，不应与 CPU 调度优先级混称。

对应隐藏图标面板的两次手势均记录为 `press-deferred → click-submit`，每次批次 `requested=3, queued=3`，结束 `leftHeld=false`；延后采样的目标及前台捕获均为 `none-observed`。同期 host 视频帧持续增长，按钮收发及执行计数成对，未记录按钮 native 拒绝。当前样本不支持“丢失鼠标抬起／状态机误转拖动／输入 worker 卡死”的解释。现有按钮计数不覆盖所有鼠标移动的拒绝，系统入队成功也不能证明 WeGame 已处理事件。

结合前台变化后同一会话恢复及实际等级差异，本轮现象高度吻合 UIPI 输入限制；不是已确认的 CPU 优先级问题。[微软 SendInput 文档](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput)规定只能向同级或更低完整性等级应用注入，且返回值及 GetLastError 不会单独指出 UIPI 拒绝。此结论限于本次 WeGame 复现，普通托盘与其他误拖拽仍需分别验收。

## 已定位并修正：输入回归测试退出超时

原 `tests/input-worker.spec.ts` 在断言完成后的 `app.close()` 等待 Windows 实例退出。生产生命周期会将没有退出意图的普通退出转为托盘后台运行，导致测试达到 45 秒超时。用独立回环身份执行对照，仅在本地测试副本的清理步骤加入 `app.exit(0)`，相同断言即在约 1.6 秒通过；再将该清理修改应用到正式测试，1/1 通过。只改变测试清理，未改变生产退出行为。

该测试使用生产 preload、专用 MessagePort、真实 utility process 和 InputState，但 native 适配器为合成记录器。它证明主线程停止调度时仍能独立处理松键、拒绝旧会话和转发诊断，不证明真实 Windows 非客户区消息循环或 SendInput 的目标响应。

## 已复现并缩小停点：整应用提权后零帧

普通实例完全退出后，以同一构建和身份目录启动整应用提权对照。再次启动加入阶段诊断的构建时，由提升后的本机观察脚本核对实际 Electron 镜像、启动参数 `.`、同一用户数据目录和 `NEARLINK_DEV_LAN=1`，主进程 TokenIntegrityLevel 实测为 High；输入 worker 也实测为 High。没有启用管理员 helper 原型或改变渲染器 sandbox。

操作者两次反馈 Mac 无画面并持续“正在连接”。Windows 侧认证成功、host 页面及输入 worker 就绪；会话保持 `connecting`，宽高、采集帧、编码帧和累计帧均为 0，主线程心跳正常，未见渲染器退出记录。

为区分信令和采集，新增固定标签的 `diagnostics.media-stage`：只接受当前会话的 host/remote 渲染器和白名单标签，不记录会话标识、SDP、候选地址、设备信息或内容。网络接收／发送 offer 与 answer 只记录种类。诊断失败不阻断媒体操作。

实测阶段顺序为：

```text
主进程收到 offer → engine-start → offer-received
→ offer-description-ready → source-requested → source-ready
→ capture-requested → capture-audio-fallback → signal-failed
```

未到达 `capture-ready` 或 `answer-ready`。两次 Chromium WGC 错误均为 `CreateForMonitor` 返回 `-2147024891`，即 `0x80070005 / E_ACCESSDENIED`。因此已将本轮零帧停点定位到 NearLink/Electron 的 WGC 采集初始化；视频去掉系统音频重试仍失败，不能仅归因于系统音频，也不能归因于输入 worker 或原生 DXGI worker（本轮未启用 `--nearlink-dxgi`）。当前信令处理在非超时错误时只报告本机错误，未生成 answer，控制端因而持续等待。

进一步用 `tests/windows-wgc-probe.cc` 独立创建主显示器的 WGC capture item：Medium（RID 8192）与 High（RID 12288）均返回 `S_OK`。探针没有启动捕获会话、取帧或保存画面。因此不能声称 High 普遍不支持 WGC，也不能把探针成功等同于 Electron 捕获成功；仍需调查 Electron/WGC 调用线程、COM/令牌及显示会话上下文的差异。[CreateForMonitor API](https://learn.microsoft.com/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createformonitor)

在 x64 Native Tools 命令行可编译探针：

```bat
if not exist work mkdir work
cl /nologo /std:c++17 /EHsc tests/windows-wgc-probe.cc /Fowork/windows-wgc-probe.obj /Fework/windows-wgc-probe.exe /link windowsapp.lib user32.lib advapi32.lib
work\windows-wgc-probe.exe
```

若比较 High，请仅在本机正常 UAC 提升后的命令行运行同一探针，记录其 RID 和 HRESULT；不需要改变系统隐私或安全设置。提权对照结束后已恢复普通权限开发实例，主进程及输入 worker 均重新实测为 Medium。新诊断记录依次到达 `source-ready → capture-ready → answer-ready → connection-connected`，累计帧持续增长，操作者确认画面和普通记事本输入恢复。

## 三项问题分别待验收

| 问题 | 本轮证据与边界 | 下一步 |
| --- | --- | --- |
| 高权限窗口无法控制 | 本轮 WeGame 实际界面为 High，输入 worker 为 Medium；操作者确认 WeGame 在前台时无法操作，退到后台后同一会话恢复 | 当前证据高度吻合完整性等级边界，生产管理员输入方案仍未实现或验收 |
| 托盘双击异常／误拖拽 | 本轮隐藏面板双击完整入队并松键，未观察到持续捕获；卡住出现在 High WeGame 成为前台之后 | 不将此样本归为漏松键或误拖拽；普通托盘和其他目标继续独立验收 |
| 整应用提权后连接零帧 | 两次复现；offer／远端描述／源枚举完成，WGC CreateForMonitor 访问拒绝，去音频重试仍失败，未生成 answer | Electron/WGC 调用上下文中的拒绝原因未解决；独立 High 原生 API 探针成功，不能直接把整应用提权当作修复 |

生产输入未接入管理员授权策略、信任模型或隔离夹具，构建保护保持启用。`SendInput` 成功入队和模拟测试均不等于目标窗口已响应。

## 本机验证结果

| 检查 | 结果 |
| --- | --- |
| `npm ci`、Electron 安装 | 完成，Electron 45.4.1 |
| `npm run native` | Windows 输入及 DXGI 模块编译通过 |
| `npm run native:update-launcher` | 编译及 x64 GUI PE 检查通过 |
| `npm run build` | 基线及变更后均通过 |
| 基线 `npm test`（沙箱外，普通权限） | 106/109 通过 |
| 局域网变更后 `npm test`（沙箱外，普通权限） | 107/110 通过；新增用例通过，仍为同三项失败 |
| 全部变更后 `npm test`（沙箱外，普通权限） | 108/111 通过；两项新增用例通过，仍为同三项失败 |
| 网络及媒体恢复、诊断白名单相关测试（沙箱外） | 18/18 通过 |
| `tests/windows-mouse.test.cc`（MSVC，断言启用） | 合成状态机断言通过，未调用真实 SendInput；一条测试全局变量遮蔽警告 |
| `tests/input-worker.spec.ts` | 原清理 45 秒超时；只修正测试退出后 1/1 通过，真实 utility process 配合合成 native 适配器 |
| 合成 WebRTC 测试的本地 Windows 适配副本 | 原生分辨率、媒体协商、输入反馈及按钮恢复等断言执行后，在性能诊断按钮的 viewport 检查超时；整个用例未通过，未计作完整 E2E 验收 |
| WGC capture-item 探针 | Medium 与 High 均 `S_OK`，只覆盖 item 创建，不覆盖 Electron 或取帧 |
| Mac 配合、实际视频和输入 | 已配对并认证，普通记事本画面／输入／拖动／最小化与恢复由操作者确认正常；WeGame 前台权限限制已复现，余项待验收 |

三个单元测试失败：目录清单用例和更新缓存清理用例在普通权限创建符号链接时报 `EPERM`；安装辅助进程超时用例在终止后立即删除临时目录时报 `EBUSY`。本轮未为通过测试而改变系统权限或跳过用例。沙箱内还有回环连接 `EACCES`，网络测试已在沙箱外重跑通过。以上失败不能归为三个远控问题的证据。

仅提交源码、测试和脱敏结论。设备地址、身份、指纹、配对数据、原始日志、诊断导出、截图及本地辅助脚本不随此记录提交。
