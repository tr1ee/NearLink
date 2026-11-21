import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCw,
  Upload,
  Download,
  Folder,
  File,
  Monitor,
  X,
  RotateCcw,
  FolderOpen,
  HardDrive,
  Check,
} from "lucide-react";
import type { FileLocation, Listing, TransferTask } from "./shared/protocol";
import { api, useSnapshot, bytes, message } from "./hooks";
import { Busy, ErrorNote, StatusDot, Modal } from "./components";
function Pane({
  title,
  listing,
  selected,
  onSelect,
  onNavigate,
  loading,
  onChoose,
}: {
  title: string;
  listing: Listing | null;
  selected: string[];
  onSelect: (path: string, multi: boolean) => void;
  onNavigate: (path: string) => void;
  loading: boolean;
  onChoose: () => void;
}) {
  return (
    <section className="file-pane">
      <h2>
        <Monitor size={18} />
        {title}
      </h2>
      <div className="file-address">
        <button
          className="choose-folder"
          onClick={onChoose}
          aria-label={
            title.startsWith("本机") ? "选择本机文件夹" : "选择对端文件夹"
          }
        >
          <FolderOpen size={17} />
          选择文件夹
        </button>
        <button
          className="icon-button"
          aria-label={`${title}上一级`}
          disabled={!listing || listing.path === listing.parent}
          onClick={() => onNavigate(listing!.parent)}
        >
          <ArrowUp size={19} />
        </button>
        <button
          className="icon-button"
          aria-label={`${title}刷新`}
          onClick={() => onNavigate(listing?.path ?? "")}
        >
          <RefreshCw size={18} />
        </button>
        <input
          aria-label={`${title}路径`}
          key={listing?.path ?? "loading"}
          defaultValue={listing?.path ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") onNavigate(e.currentTarget.value);
          }}
        />
      </div>
      <div className="file-table" role="grid" aria-label={title}>
        <div className="file-table-head">
          <span>名称</span>
          <span>大小</span>
          <span>修改时间</span>
        </div>
        {loading ? (
          <Busy />
        ) : (
          listing?.entries.map((entry) => (
            <div
              role="row"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" && entry.directory)
                  onNavigate(entry.path);
                else if (e.key === " ") {
                  e.preventDefault();
                  onSelect(entry.path, true);
                }
              }}
              aria-selected={selected.includes(entry.path)}
              className={
                "file-row " + (selected.includes(entry.path) ? "selected" : "")
              }
              key={entry.path}
              onClick={(e) => onSelect(entry.path, e.metaKey || e.ctrlKey)}
              onDoubleClick={() => {
                if (entry.directory) onNavigate(entry.path);
              }}
            >
              <span title={entry.name}>
                <input
                  type="checkbox"
                  aria-label={`选择${entry.name}`}
                  checked={selected.includes(entry.path)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onChange={() => onSelect(entry.path, true)}
                />
                {entry.directory ? (
                  <Folder className="folder-icon" size={20} />
                ) : (
                  <File size={19} />
                )}
                <span>{entry.name}</span>
              </span>
              <span>{entry.directory ? "—" : bytes(entry.size)}</span>
              <span>
                {new Date(entry.modified).toLocaleDateString("zh-CN")}
              </span>
            </div>
          ))
        )}
        {!loading && !listing?.entries.length ? (
          <div className="empty-folder">此文件夹为空</div>
        ) : null}
      </div>
    </section>
  );
}
function FolderPicker({
  side,
  initial,
  onClose,
  onChoose,
}: {
  side: "local" | "remote";
  initial: Listing | null;
  onClose: () => void;
  onChoose: (path: string) => void;
}) {
  const [directory, setDirectory] = useState<Listing | null>(initial);
  const [locations, setLocations] = useState<FileLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const title = side === "local" ? "选择本机文件夹" : "选择对端文件夹";
  async function browse(path: string) {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const listing = await api.invoke<Listing>("files.list", side, path);
      if (id === request.current) setDirectory(listing);
    } catch (e) {
      if (id === request.current) setError(message(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    api
      .invoke<FileLocation[]>("files.locations", side)
      .then((v) => {
        if (active) setLocations(v);
      })
      .catch(() => {});
    if (!initial) void browse("");
    return () => {
      active = false;
      request.current++;
    };
  }, [side]);
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="folder-picker-body">
        <aside className="folder-places" aria-label="常用位置">
          {locations.map((location) => (
            <button
              key={location.path + location.name}
              onClick={() => void browse(location.path)}
              title={location.path}
            >
              {location.kind === "disk" ? (
                <HardDrive size={17} />
              ) : (
                <Folder size={17} />
              )}
              <span>{location.name}</span>
            </button>
          ))}
        </aside>
        <section className="folder-browser">
          <div className="folder-browser-path">
            <button
              className="icon-button"
              aria-label="文件夹选择器上一级"
              disabled={
                loading || !directory || directory.path === directory.parent
              }
              onClick={() => void browse(directory!.parent)}
            >
              <ArrowUp size={18} />
            </button>
            <span title={directory?.path}>{directory?.path ?? "正在读取"}</span>
          </div>
          <ErrorNote text={error} />
          <div className="folder-browser-list" aria-label="可选文件夹">
            {loading ? (
              <Busy />
            ) : (
              directory?.entries
                .filter((e) => e.directory)
                .map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => void browse(entry.path)}
                  >
                    <Folder size={20} />
                    {entry.name}
                    <ArrowRight size={16} />
                  </button>
                ))
            )}
            {!loading &&
            directory &&
            !directory.entries.some((e) => e.directory) ? (
              <p className="empty-folder">
                此文件夹中没有子文件夹，可直接选择当前文件夹。
              </p>
            ) : null}
          </div>
        </section>
      </div>
      <footer className="folder-picker-footer">
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          disabled={loading || !directory}
          onClick={() => onChoose(directory!.path)}
        >
          <Check size={16} />
          选择当前文件夹
        </button>
      </footer>
    </Modal>
  );
}
export default function Files() {
  const { state } = useSnapshot();
  const [local, setLocal] = useState<Listing | null>(null);
  const [remote, setRemote] = useState<Listing | null>(null);
  const [selectedLocal, setSelectedLocal] = useState<string[]>([]);
  const [selectedRemote, setSelectedRemote] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<"local" | "remote" | null>(null);
  const requests = useRef({ local: 0, remote: 0 });
  const [loading, setLoading] = useState({ local: false, remote: false });
  const peer = state?.devices.find((d) => d.id === api.peerId);
  const tasks = (state?.transfers ?? [])
    .filter((t) => t.peerId === api.peerId)
    .toReversed();
  async function load(side: "local" | "remote", directory = "") {
    const request = ++requests.current[side];
    setLoading((s) => ({ ...s, [side]: true }));
    setError("");
    try {
      const result = await api.invoke<Listing>("files.list", side, directory);
      if (request !== requests.current[side]) return;
      if (side === "local") {
        setLocal(result);
        setSelectedLocal([]);
      } else {
        setRemote(result);
        setSelectedRemote([]);
      }
    } catch (e) {
      if (request === requests.current[side]) setError(message(e));
    } finally {
      if (request === requests.current[side])
        setLoading((s) => ({ ...s, [side]: false }));
    }
  }
  useEffect(() => {
    void load("local");
    void load("remote");
  }, []);
  const completed = tasks.filter((t) => t.state === "completed").length;
  useEffect(() => {
    if (completed) {
      void load("local", local?.path);
      void load("remote", remote?.path);
    }
  }, [completed]);
  function select(side: "local" | "remote", filename: string, multi: boolean) {
    const setter = side === "local" ? setSelectedLocal : setSelectedRemote;
    setter((old) =>
      multi
        ? old.includes(filename)
          ? old.filter((p) => p !== filename)
          : [...old, filename]
        : [filename],
    );
  }
  async function transfer(direction: "upload" | "download") {
    setError("");
    try {
      for (const source of direction === "upload"
        ? selectedLocal
        : selectedRemote)
        await api.invoke(
          "files.transfer",
          direction,
          source,
          direction === "upload" ? remote!.path : local!.path,
        );
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <div className="files-shell">
      <header className="files-toolbar">
        <span className="file-peer">
          <StatusDot online={peer?.online ?? false} />
          {peer?.name ?? "正在连接"}
        </span>
        <div>
          <button
            disabled={!selectedLocal.length || !remote}
            onClick={() => void transfer("upload")}
          >
            <Upload size={17} />
            上传 →
          </button>
          <button
            disabled={!selectedRemote.length || !local}
            onClick={() => void transfer("download")}
          >
            <Download size={17} />← 下载
          </button>
        </div>
        <button
          className="icon-button"
          aria-label="刷新文件列表"
          onClick={() => {
            void load("local", local?.path);
            void load("remote", remote?.path);
          }}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      <ErrorNote text={error} />
      <div className="file-panes">
        <Pane
          title={`本机 · ${state?.self.name ?? "本机"}`}
          listing={local}
          selected={selectedLocal}
          onSelect={(p, m) => select("local", p, m)}
          onNavigate={(p) => void load("local", p)}
          loading={loading.local}
          onChoose={() => setPicker("local")}
        />
        <Pane
          title={`对端 · ${peer?.name ?? "对端"}`}
          listing={remote}
          selected={selectedRemote}
          onSelect={(p, m) => select("remote", p, m)}
          onNavigate={(p) => void load("remote", p)}
          loading={loading.remote}
          onChoose={() => setPicker("remote")}
        />
      </div>
      {picker ? (
        <FolderPicker
          side={picker}
          initial={picker === "local" ? local : remote}
          onClose={() => setPicker(null)}
          onChoose={(path) => {
            void load(picker, path);
            setPicker(null);
          }}
        />
      ) : null}
      <div className="transfer-section">
        <h3>传输任务</h3>
        {tasks.length ? (
          <div className="transfer-list">
            {tasks.slice(0, 100).map((t) => (
              <Task key={t.id} task={t} />
            ))}
          </div>
        ) : (
          <div className="transfer-empty">
            选中文件或文件夹后，点击上传或下载。
          </div>
        )}
      </div>
      <footer className="files-footer">
        同名文件自动改名 · 传输完成后校验文件完整性 · 关闭窗口后继续传输
      </footer>
    </div>
  );
}
function Task({ task: t }: { task: TransferTask }) {
  const percent = t.size ? Math.min(100, (t.done / t.size) * 100) : 0;
  const label = {
    queued: "等待传输",
    running: "传输中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[t.state];
  return (
    <div className="transfer-row">
      <File size={21} />
      <span className="transfer-name">
        <strong title={t.name}>{t.name}</strong>
        <small title={t.error}>
          {t.error ?? (t.direction === "upload" ? "上传到对端" : "下载到本机")}
        </small>
      </span>
      <div className="transfer-progress">
        <progress value={t.state === "completed" ? 100 : percent} max={100} />
        <small>
          {bytes(t.done)} / {bytes(t.size)}
        </small>
      </div>
      <span className={"task-state " + t.state}>{label}</span>
      {t.state === "running" || t.state === "queued" ? (
        <button
          className="icon-button"
          aria-label={`取消${t.name}`}
          onClick={() => void api.invoke("files.cancel", t.id)}
        >
          <X size={17} />
        </button>
      ) : t.state === "failed" || t.state === "cancelled" ? (
        <button
          className="icon-button"
          aria-label={`重试${t.name}`}
          onClick={() => void api.invoke("files.retry", t.id)}
        >
          <RotateCcw size={17} />
        </button>
      ) : t.direction === "download" ? (
        <button
          className="icon-button"
          aria-label="打开文件位置"
          onClick={() => void api.invoke("files.reveal", t.id)}
        >
          <FolderOpen size={17} />
        </button>
      ) : (
        <span className="icon-spacer" />
      )}
    </div>
  );
}
