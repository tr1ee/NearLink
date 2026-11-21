# Windows 管理员窗口输入原型

本文记录原有策略原型，首段“0.1.14”未能与交接源码和运行包对应，不能作为当前构建版本。2026-11-21 Windows 临时原生组件的实现、操作者实际输入反馈、指针显示问题与生产边界另见 [真机验收记录](windows-elevated-input-debug.md)。原型构建保护继续启用。

Windows 0.1.14 的实测中，NearLink 输入 worker 为 Medium，测试的高权限应用及其子进程为 High。高权限应用保持打开时，把焦点切回普通权限的记事本，同一远控会话立即恢复输入。另一次整应用提权对照通过了认证，连接停在 connecting 且没有视频帧，原因尚待确认。

## 当前输入链路

受控端 Runtime 根据活动会话、锁屏状态和配对设备的认证连接配置 `WindowsInputService`。隐藏的 host 渲染器通过专用 MessagePort 把输入送给独立的 Medium utility process，由 `InputState` 检查会话和输入租约后调用 Windows 原生模块。配对与信令、视频采集、文件和剪贴板使用现有路径。

本地原型把发布信任策略、手势授权策略与现有 `InputState` 接到隔离测试夹具。夹具中的 helper 决策是数据，只有模拟的普通权限输入路径会执行回调。生产输入仍由现有 Medium worker 处理，生产入口的构建图不包含夹具、发布信任模型或管理员授权策略。

## 候选 helper 的信任边界

- 由 Windows 当前控制台用户在本机选择一个符合条件的窗口。只有本机入口可提出正常 UAC 请求，是否同意由 Windows 决定。UAC 许可与选定对端、会话及窗口的本机批准分别验证。批准界面投产前需要证明远控输入无法确认该界面。UAC 取消、另一账号提升、当前控制台不明确或无法确认本机批准时拒绝交接。 [Windows UAC](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works)
- helper 只接受经过双向身份验证的本机专用通道。核对进程身份、Windows 用户 SID、登录会话和当前控制台会话。主进程使用可信入口提供活动 host 会话、配对设备的 TLS 身份和连接代次。授权绑定本次本机确认、该通道、该会话、该连接代次、所选窗口实例和显示布局。远控负载里的标识仅用于比对。
- 每条输入都校验来源、授权编号和严格递增的序号。仅解析白名单中的鼠标移动、按钮、滚轮和基础按键。模型按已解析的动作要求一次新的本机目标观察，观察失败、目标失效或授权到期立即撤权。窗口身份必须区分重建或句柄复用，且与本机控制台用户、登录会话和原输入桌面一致。Windows 会话和桌面查询须结合使用，拒绝未连接的控制台、锁屏、UAC、安全桌面和无法分类的目标。Windows `SendInput` 写入输入流，调用无指定目标窗口的参数。仅在调用前再查一次前台窗口，仍无法证明切换瞬间不会误投。真实 helper 需要实际证明输入边界后才可启用。 [物理控制台会话](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-wtsgetactiveconsolesessionid) · [输入桌面查询](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop) · [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- 入站通道仅携带受限的输入协议及必要的授权生命周期消息。helper 无网络监听、持久化、任意执行、文件、命令或剪贴板能力。配对、信令和采集维持现有进程和权限。

## 撤权和回落

首次切换前确认 Medium 已释放转发的按键和按钮。helper 只跟踪自己已执行的按下状态。本地关闭、锁屏、会话断开或替换、失焦、目标变更、验信失败或授权到期时先禁用新输入，再在 Windows 允许的桌面上清理这些状态。模型用 60 秒固定有效期验证到期行为，远程输入无法续期。独立本机监视需要覆盖主进程退出或通道中断。清理未确认时，拒绝重新授权，也暂停回落，避免同一手势由两个进程各自执行一半。可靠确认清理后，后续新事件才回到原 Medium 路径。

## 发布信任和构建验收

现有 NearLink 更新器用 Ed25519 验证更新清单，再按清单中的 SHA‑256 校验安装包。Windows 诊断版安装器、其解包后的主程序及当前更新启动器的 PE 证书表均为空。此处的静态观察只覆盖嵌入签名。当前 Mac 环境无 Windows Authenticode 验证工具，未验证 Windows 信任链或安装目录权限。

1. **签名门槛。** Windows 本机在提出 UAC 请求前以 `WinVerifyTrust` 验证实际 helper 的 Authenticode 签名，要求可信链和可判定的吊销状态，并比对受保护发布策略中的发行者公钥指纹。构建验收另用 Windows SDK 的 SignTool 按 Authenticode 策略检查产物及时间戳。空发布者策略、未知状态、错误签名、未知发行者和验证后镜像不符均拒绝。 [WinVerifyTrust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust) · [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
2. **安装门槛。** 从已打开的文件确认最终路径和镜像身份，与签名校验和实际加载的对象对应。受保护根目录、相关父目录、文件及依赖须对普通用户不可替换，核对有效访问权限、重解析和动态依赖搜索路径。路径、访问权限、镜像一致性或可写依赖有一项无法确认，就不发起 UAC；安装校验结果也不能从远控消息或更新清单取值。 [最终路径查询](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew) · [Windows 文件访问控制](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
3. **当前本地验收。** 运行类型检查、输入回归和隔离夹具。构建遇到管理员策略、信任模型或夹具模块时中止。验证正常构建仍使用普通输入实现，并验证直接引用这些模块会触发拒绝。夹具只记录信任拒绝、授权、撤权及回落原因码，不记录键值、窗口标识、路径或对端身份。
4. **后续 Windows 真机验收。** 在签名、安装、本机通道身份及目标切换边界都可验证后，测试 UAC 取消和本机批准、High 应用输入、普通应用回落、锁屏及安全桌面拒绝，以及断线、崩溃、超时、失焦和移动目标期间的松键。核对主进程、采集及 Medium worker 在验收中保持普通权限。当前托盘误拖拽与整应用提权后零帧的原因仍需各自验证。
