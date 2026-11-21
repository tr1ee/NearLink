import { useEffect, useRef, useState } from "react";
import {
  Monitor,
  PanelsTopLeft,
  ChevronUp,
  Grid2X2,
  Settings,
  MoreVertical,
  FolderSync,
  PlaySquare,
  Info,
  MousePointer2,
  Plus,
  Link,
  ShieldCheck,
  ShieldAlert,
  Copy,
  Power,
  ArrowRight,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import { useSnapshot, api, message, platformName } from "./hooks";
import { Busy, ErrorNote, Modal, StatusDot } from "./components";
import type { Device } from "./shared/protocol";
import { UpdateSettings, UpdateNotice } from "./Updates";
export default function Home() {
  const { state, error: loadError } = useSnapshot();
  const [selected, setSelected] = useState("");
  const [all, setAll] = useState(false);
  const [settings, setSettings] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [image, setImage] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [info, setInfo] = useState<any>(null);
  const [menu, setMenu] = useState(false);
  const selection = useRef("");
  selection.current = selected;
  const devices = state?.devices ?? [];
  const device =
    selected === state?.self.id
      ? state.self
      : devices.find((d) => d.id === selected);
  const self = !!device && device.id === state?.self.id;
  const sessionActive =
    !!state?.session && state.session.state !== "disconnected";
  useEffect(() => {
    if (!selected && state) {
      const first =
        state.devices.find((d) => d.online && d.trusted) ??
        state.devices.find((d) => d.online);
      setSelected(first?.id ?? state.self.id);
    }
  }, [state, selected]);
  useEffect(() => {
    setImage("");
    setPreviewError("");
  }, [device?.id]);
  useEffect(() => {
    // getSources thumbnails open another desktop capture, including monitors
    // outside the active session. Keep the last preview while media is live.
    if (!device || self || !device.online || !device.trusted || sessionActive)
      return;
    const id = device.id;
    let active = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        const p = await api.invoke("preview", id);
        if (active && selection.current === id) {
          setImage(p.image);
          setPreviewError("");
        }
      } catch (e) {
        if (active) setPreviewError(message(e));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [device?.id, device?.online, device?.trusted, self, sessionActive]);
  async function action(label: string, fn: () => Promise<any>) {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function enter(viewOnly = false) {
    if (!device || self || !device.online) return;
    await action("正在连接", async () => {
      if (!device.trusted) await api.invoke("pair", device.id);
      await api.invoke("connect", device.id, viewOnly);
    });
  }
  async function addDevice() {
    await action("等待两端确认", async () => {
      const d = await api.invoke<Device>("pair", address);
      setSelected(d.id);
      setPairing(false);
      setAll(false);
      setAddress("");
    });
  }
  if (!state)
    return (
      <div className="startup">
        <Monitor size={38} />
        <Busy label="正在启动近控" />
        <ErrorNote text={loadError} />
      </div>
    );
  const permissionReady =
    state.permissions.screen === "granted" &&
    state.permissions.accessibility &&
    state.permissions.native;
  return (
    <div className="home-shell">
      <aside className="sidebar">
        <div className="sidebar-drag" />
        <div className="side-group">
          <div className="group-title">
            <PanelsTopLeft size={19} />
            <span>我的设备</span>
            <ChevronUp size={16} />
          </div>
          <button
            className={"device-nav " + (self && !all ? "selected" : "")}
            onClick={() => {
              setSelected(state.self.id);
              setAll(false);
            }}
          >
            <Monitor size={20} />
            <span>{state.self.name}</span>
            <small>本机</small>
          </button>
          {devices
            .filter((d) => d.trusted)
            .map((d) => (
              <button
                key={d.id}
                data-device-id={d.id}
                className={
                  "device-nav " + (selected === d.id && !all ? "selected" : "")
                }
                onClick={() => {
                  setSelected(d.id);
                  setAll(false);
                  setMenu(false);
                }}
              >
                <span className="device-icon">
                  <Monitor size={20} />
                  <StatusDot online={d.online} />
                </span>
                <span>{d.name}</span>
                {!d.trusted ? <small>未配对</small> : null}
              </button>
            ))}
        </div>
        <div className="side-separator" />
        <button
          className={"nav-all " + (all ? "selected" : "")}
          onClick={() => setAll(true)}
        >
          <Grid2X2 size={20} />
          全部设备
        </button>
        <button
          className="nav-all muted"
          onClick={() => {
            setPairing(true);
            setError("");
          }}
        >
          <Plus size={20} />
          添加设备
        </button>
        <footer className="sidebar-footer">
          <div>
            <StatusDot online={state.allowRemote} />
            <span>{state.allowRemote ? "允许远程连接" : "已暂停远程连接"}</span>
          </div>
          <small>关闭窗口后继续运行</small>
        </footer>
      </aside>
      <main className="home-main">
        <header className="home-header">
          <div className="device-heading">
            {!all && device ? (
              <>
                <span className="online-label">
                  <StatusDot online={device.online} />
                  {self ? "本机" : device.online ? "在线" : "离线"}
                </span>
                <h1>{device.name}</h1>
                {!self ? (
                  <button
                    className="icon-button"
                    aria-label="设备菜单"
                    onClick={() => setMenu(!menu)}
                  >
                    <MoreVertical size={21} />
                  </button>
                ) : null}
              </>
            ) : (
              <h1>全部设备</h1>
            )}
          </div>
          <UpdateNotice onOpen={() => setSettings(true)} />
          <button
            className="icon-button"
            aria-label="设置"
            onClick={() => {
              setSettings(true);
              setError("");
            }}
          >
            <Settings size={22} />
          </button>
          {menu && device ? (
            <div className="device-menu">
              <button
                onClick={() =>
                  void action("读取设备信息", async () => {
                    setInfo(await api.invoke("device.info", device.id));
                    setMenu(false);
                  })
                }
              >
                <Info size={16} />
                设备信息
              </button>
              <button
                className="danger"
                onClick={() =>
                  void action("撤销配对", async () => {
                    await api.invoke("revoke", device.id);
                    setMenu(false);
                  })
                }
              >
                <ShieldAlert size={16} />
                撤销配对
              </button>
            </div>
          ) : null}
        </header>
        <div className="home-content">
          <ErrorNote text={error} />
          {state.error ? <div className="notice">{state.error}</div> : null}
          {all ? (
            <>
              <div className="section-heading">
                <h2>局域网中的电脑</h2>
                <button onClick={() => setPairing(true)}>
                  <Link size={16} />
                  通过地址连接
                </button>
              </div>
              {devices.length ? (
                <div className="all-devices">
                  {devices.map((d) => (
                    <button
                      className="all-device"
                      key={d.id}
                      onClick={() => {
                        setSelected(d.id);
                        setAll(false);
                      }}
                    >
                      <Monitor size={28} />
                      <span>
                        <strong>{d.name}</strong>
                        <small>
                          {platformName(d.platform)} ·{" "}
                          {d.trusted ? "已配对" : "未配对"}
                        </small>
                      </span>
                      <StatusDot online={d.online} />
                      <ArrowRight size={17} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-discovery">
                  <Monitor size={46} />
                  <h2>等待另一台电脑</h2>
                  <p>在同一网络的另一台电脑打开 NearLink，设备会显示在这里。</p>
                  <button onClick={() => setPairing(true)}>
                    <Plus size={16} />
                    通过地址添加
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div
                className={
                  "preview-frame " +
                  (!self && device?.online ? "clickable" : "")
                }
              >
                <button
                  className="desktop-preview"
                  disabled={!!busy || self || !device?.online}
                  aria-label={
                    device?.trusted ? "点击进入远控" : "配对并进入远控"
                  }
                  onClick={() => void enter()}
                >
                  {image ? (
                    <img src={image} alt={`${device?.name} 的桌面预览`} />
                  ) : (
                    <div className="preview-placeholder">
                      <Monitor size={58} strokeWidth={1} />
                      <h2>
                        {self
                          ? "这台电脑已准备好"
                          : !device?.online
                            ? "设备当前离线"
                            : device?.trusted
                              ? "正在读取桌面预览"
                              : "配对后即可连接"}
                      </h2>
                      <p>
                        {self
                          ? "在另一台电脑打开 NearLink，配对后便可远程访问。"
                          : !device?.online
                            ? "请确认电脑已开机并已打开 NearLink。"
                            : device?.trusted
                              ? previewError || "通过加密连接获取对端桌面"
                              : `首次连接需要在两台电脑上核对指纹并确认。`}
                      </p>
                    </div>
                  )}
                  {!self && device?.online ? (
                    <span
                      className={"enter-overlay " + (!image ? "always" : "")}
                    >
                      <MousePointer2 size={22} />
                      {busy ||
                        (!device.trusted ? "配对并进入远控" : "点击进入远控")}
                    </span>
                  ) : null}
                </button>
                <div className="preview-actions">
                  <button
                    disabled={
                      self || !device?.trusted || !device?.online || !!busy
                    }
                    onClick={() =>
                      void action("打开文件传输", () =>
                        api.invoke("files.open", device!.id),
                      )
                    }
                  >
                    <FolderSync size={21} />
                    文件传输
                  </button>
                  <span />
                  <button
                    disabled={self || !device?.online || !!busy}
                    onClick={() => void enter(true)}
                  >
                    <PlaySquare size={21} />
                    仅观看
                  </button>
                  <span />
                  <button
                    onClick={() =>
                      self
                        ? setSettings(true)
                        : void action("读取设备信息", async () =>
                            setInfo(
                              await api.invoke("device.info", device!.id),
                            ),
                          )
                    }
                    disabled={!device?.online || !!busy}
                  >
                    <Info size={21} />
                    设备信息
                  </button>
                </div>
              </div>
              <div className="device-footnote">
                {self ? (
                  <>
                    <ShieldCheck size={15} />
                    {permissionReady
                      ? "远控权限已就绪"
                      : "首次使用请完成远控权限配置"}
                    <button
                      className="text-button"
                      onClick={() => setSettings(true)}
                    >
                      {permissionReady ? "查看设置" : "配置权限"}
                    </button>
                  </>
                ) : (
                  <>
                    {device?.trusted ? "已配对" : "等待配对"}
                    <span>·</span>
                    {platformName(device?.platform ?? "")}
                    <span>·</span>局域网直连
                  </>
                )}
              </div>
              {self ? (
                <div className="local-address">
                  <span>本机连接地址</span>
                  <code>
                    {state.self.host}:{state.self.port}
                  </code>
                  <button
                    className="icon-button"
                    aria-label="复制本机地址"
                    onClick={() => void api.invoke("copy.address")}
                  >
                    <Copy size={16} />
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </main>
      {pairing ? (
        <Modal
          title="连接另一台电脑"
          onClose={() => {
            if (!busy) setPairing(false);
          }}
        >
          <p className="modal-description">
            在另一台电脑的设置中查看连接地址。首次连接会在两端显示配对确认。
          </p>
          <label className="field-label" htmlFor="address">
            对端地址
          </label>
          <input
            id="address"
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="例如 192.168.1.10:51820"
            onKeyDown={(e) => {
              if (e.key === "Enter") void addDevice();
            }}
          />
          <ErrorNote text={error} />
          <footer className="modal-actions">
            <button disabled={!!busy} onClick={() => setPairing(false)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!address.trim() || !!busy}
              onClick={() => void addDevice()}
            >
              {busy || "连接并配对"}
            </button>
          </footer>
        </Modal>
      ) : null}
      {settings ? (
        <Modal title="设置" wide onClose={() => setSettings(false)}>
          <UpdateSettings />
          <div className="settings-section">
            <h3>本机</h3>
            <div className="setting-row">
              <span>
                {state.self.name}
                <small>
                  {platformName(state.platform)} · {state.self.host}:
                  {state.self.port}
                </small>
              </span>
              <button onClick={() => void api.invoke("copy.address")}>
                <Copy size={15} />
                复制地址
              </button>
            </div>
            <div className="setting-row">
              <span>
                允许远程连接
                <small>已配对设备可免确认连接，随时可在此暂停。</small>
              </span>
              <button
                role="switch"
                aria-checked={state.allowRemote}
                aria-label="允许远程连接"
                className={"toggle " + (state.allowRemote ? "on" : "")}
                onClick={() =>
                  void action("", () =>
                    api.invoke("allowRemote", !state.allowRemote),
                  )
                }
              >
                <span />
              </button>
            </div>
          </div>
          <div className="settings-section">
            <h3>远控权限</h3>
            <div className="setting-row">
              <span>
                屏幕录制
                <small>
                  {state.permissions.screen === "granted"
                    ? "已允许"
                    : "需要在被控端系统设置中允许"}
                </small>
              </span>
              {state.platform === "darwin" ? (
                <button
                  onClick={() => void api.invoke("permissions", "screen")}
                >
                  打开系统设置
                </button>
              ) : (
                <ShieldCheck size={19} />
              )}
            </div>
            <div className="setting-row">
              <span>
                键盘与鼠标控制
                <small>
                  {state.permissions.accessibility
                    ? "已就绪"
                    : "需要辅助功能权限"}
                </small>
              </span>
              {state.platform === "darwin" ? (
                <button
                  onClick={() =>
                    void api.invoke("permissions", "accessibility")
                  }
                >
                  授权辅助功能
                </button>
              ) : (
                <ShieldCheck size={19} />
              )}
            </div>
            <div className="setting-row">
              <span>
                原生模块
                <small>
                  {state.permissions.native
                    ? "已加载"
                    : "未加载，请重新构建原生模块"}
                </small>
              </span>
              {state.permissions.native ? (
                <ShieldCheck size={19} />
              ) : (
                <ShieldAlert size={19} />
              )}
            </div>
            <p className="fine-print">
              电脑声音将在首次远控时请求系统授权。修改权限后，可能需要完全退出并重新打开软件。
            </p>
          </div>
          <div className="settings-section">
            <h3>本机设备指纹</h3>
            <code className="fingerprint">
              {state.self.fingerprint
                .toUpperCase()
                .match(/.{1,4}/g)
                ?.join(" ")}
            </code>
            <p className="fine-print">
              仅在两端指纹一致且你信任该设备时确认配对。
            </p>
          </div>
          <ErrorNote text={error} />
          <footer className="modal-actions spread">
            <button className="danger" onClick={() => void api.invoke("quit")}>
              <Power size={16} />
              完全退出
            </button>
            <div className="settings-export">
              <button
                onClick={() =>
                  void action("", () => api.invoke("diagnostics.export"))
                }
              >
                导出设备信息
              </button>
              <button onClick={() => setSettings(false)}>完成</button>
            </div>
          </footer>
        </Modal>
      ) : null}
      {info ? (
        <Modal title="设备信息" onClose={() => setInfo(null)}>
          <dl className="info-list">
            <dt>名称</dt>
            <dd>{info.name}</dd>
            <dt>系统</dt>
            <dd>{platformName(info.platform)}</dd>
            <dt>显示器</dt>
            <dd>
              {info.displays?.map((d: any) => (
                <div key={d.id}>
                  {d.name} · {Math.round(d.width * d.scale)} ×{" "}
                  {Math.round(d.height * d.scale)} · {Math.round(d.refreshRate)}
                  Hz
                </div>
              ))}
            </dd>
            <dt>连接</dt>
            <dd>局域网加密直连</dd>
          </dl>
        </Modal>
      ) : null}
    </div>
  );
}
