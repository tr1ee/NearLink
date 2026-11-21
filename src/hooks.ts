import { useEffect, useState } from "react";
import type { Snapshot } from "./shared/protocol";
export const api = window.nearlink;
export function useSnapshot() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const off = api.on("state", setState);
    api
      .invoke<Snapshot>("state")
      .then(setState)
      .catch((e) => setError(e.message));
    return off;
  }, []);
  return { state, error };
}
export function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
export function platformName(p: string) {
  return p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p;
}
export function bytes(size: number) {
  if (!Number.isFinite(size)) return "—";
  if (size < 1024) return size + " B";
  const power = Math.min(3, Math.floor(Math.log(size) / Math.log(1024)));
  return (
    (size / 1024 ** power).toFixed(power === 1 ? 0 : 1) +
    " " +
    ["B", "KB", "MB", "GB"][power]
  );
}
