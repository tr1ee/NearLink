import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { UpdateState } from "./shared/updates";
import { api, bytes, message } from "./hooks";
import { ErrorNote } from "./components";
function useUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const off = api.on("updates", setState);
    void api
      .invoke<UpdateState>("updates.state")
      .then(setState)
      .catch(() => {});
    return off;
  }, []);
  return state;
}
export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const state = useUpdates();
  return state && ["available", "ready"].includes(state.phase) ? (
    <button className="update-notice" onClick={onOpen}>
      <Download size={15} />
      {state.phase === "ready" ? "更新已就绪" : "发现新版本"}{" "}
      {state.nextVersion}
    </button>
  ) : null;
}
export function UpdateSettings() {
  const state = useUpdates();
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  async function action(method: string, ...args: any[]) {
    setError("");
    try {
      await api.invoke(method, ...args);
    } catch (e) {
      setError(message(e));
    }
  }
  if (!state) return null;
  const busy = ["checking", "downloading", "installing"].includes(state.phase);
  return (
    <div className="settings-section updates-settings">
      <h3>
        软件更新 <small>当前版本 {state.currentVersion}</small>
      </h3>
      <p className="fine-print">
        通过 GitHub Releases
        获取更新，下载后在本机自动安装。安装前会确认是否结束远控和文件任务。
      </p>
      <div className="setting-row">
        <span>
          自动检查更新<small>启动后和后台定期检查，不自动中断当前连接。</small>
        </span>
        <button
          className={"toggle " + (state.autoCheck ? "on" : "")}
          role="switch"
          aria-label="自动检查更新"
          aria-checked={state.autoCheck}
          disabled={busy}
          onClick={() =>
            void action("updates.configure", state.feedUrl, !state.autoCheck)
          }
        >
          <span />
        </button>
      </div>
      <div className="update-status" role="status">
        {state.message || "可检查是否有新版本"}
      </div>
      {state.notes ? <p className="update-notes">{state.notes}</p> : null}
      {state.phase === "downloading" ? (
        <>
          <progress value={state.downloaded} max={state.total || 1} />
          <small>
            {bytes(state.downloaded)} / {bytes(state.total)}
          </small>
        </>
      ) : null}
      <div className="update-actions">
        <button
          disabled={busy || !state.feedUrl}
          onClick={() => void action("updates.check")}
        >
          <RefreshCw size={15} />
          检查更新
        </button>
        {state.phase === "available" ||
        (state.phase === "error" && state.nextVersion) ? (
          <button
            className="primary"
            onClick={() => void action("updates.download")}
          >
            <Download size={15} />
            下载更新
          </button>
        ) : null}
        {state.phase === "ready" ? (
          <button
            className="primary"
            onClick={() => void action("updates.install")}
          >
            安装并重新打开
          </button>
        ) : null}
        {state.phase === "downloading" || state.phase === "checking" ? (
          <button onClick={() => void action("updates.cancel")}>取消</button>
        ) : null}
        <button
          className="quiet"
          disabled={busy}
          onClick={() => setAdvanced(!advanced)}
        >
          更新源设置
        </button>
      </div>
      {advanced ? (
        <div className="update-source">
          <label htmlFor="update-feed">更新清单地址（HTTPS）</label>
          <input
            id="update-feed"
            value={url ?? state.feedUrl}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            disabled={busy}
            onClick={() =>
              void action(
                "updates.configure",
                url ?? state.feedUrl,
                state.autoCheck,
              )
            }
          >
            保存更新源
          </button>
          <p className="fine-print">
            仅接受由 NearLink 发布密钥签名的版本。修改地址不会改变发布者信任。
          </p>
        </div>
      ) : null}
      <ErrorNote text={error} />
    </div>
  );
}
