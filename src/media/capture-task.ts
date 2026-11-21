/** getUserMedia cannot be aborted by the browser API. Bound the wait and stop
 * any tracks that arrive after cancellation, instead of blocking reconnect. */
export function captureTask<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  dispose: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const clear = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    };
    const abort = () => fail(new DOMException("采集已取消", "AbortError"));
    const timer = setTimeout(
      () =>
        fail(
          new DOMException("屏幕采集超时，正在恢复媒体连接。", "TimeoutError"),
        ),
      timeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        if (settled) {
          dispose(value);
          return;
        }
        settled = true;
        clear();
        resolve(value);
      },
      (error) => fail(error),
    );
  });
}
