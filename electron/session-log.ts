import { appendFile, mkdir, stat, rename, readFile } from "node:fs/promises";
import path from "node:path";
export class SessionLog {
  private work = Promise.resolve();
  private queued = 0;
  constructor(
    public filename: string,
    private limit = 1024 * 1024,
  ) {}
  record(entry: unknown) {
    if (this.queued >= 256) return;
    this.queued++;
    this.work = this.work
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.filename), { recursive: true });
        const size = await stat(this.filename)
          .then((s) => s.size)
          .catch(() => 0);
        if (size >= this.limit)
          await rename(this.filename, this.filename + ".previous").catch(
            () => {},
          );
        await appendFile(this.filename, JSON.stringify(entry) + "\n", {
          mode: 0o600,
        });
      })
      .catch(() => {})
      .finally(() => {
        this.queued--;
      });
  }
  flush() {
    return this.work;
  }
  async recent() {
    await this.flush();
    return readFile(this.filename, "utf8")
      .then((s) =>
        s
          .trim()
          .split("\n")
          .slice(-100)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      )
      .catch(() => []);
  }
}
