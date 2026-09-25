import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/** `<dataDir>/raw/YYYY-MM-DD/HH.ndjson` for the UTC hour containing `ms`. */
export function hourFile(dataDir: string, ms: number): string {
  const iso = new Date(ms).toISOString();
  return join(dataDir, "raw", iso.slice(0, 10), `${iso.slice(11, 13)}.ndjson`);
}

/** Compress `file` to `file.gz` atomically, then delete `file`. Safe to re-run after a crash at any point. */
export async function gzipFile(file: string): Promise<void> {
  const tmp = `${file}.gz.tmp`;
  await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(tmp));
  renameSync(tmp, `${file}.gz`);
  rmSync(file);
}

/**
 * Append-only NDJSON, rotated per UTC hour. The current hour stays plain text (appendable after a
 * restart); closed hours are gzipped in the background.
 */
export class HourlyNdjsonWriter {
  private stream: WriteStream | null = null;
  private path: string | null = null;
  private readonly compressing = new Set<Promise<void>>();
  lines = 0;
  bytes = 0;

  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly onError: (err: Error) => void;

  constructor(dataDir: string, now: () => number, onError: (err: Error) => void) {
    this.dataDir = dataDir;
    this.now = now;
    this.onError = onError;
  }

  /** Compress leftover plain files from earlier hours (previous run crashed or stopped mid-hour). */
  recoverLeftovers(): void {
    const root = join(this.dataDir, "raw");
    const current = hourFile(this.dataDir, this.now());
    let days: string[] = [];
    try {
      days = readdirSync(root);
    } catch {
      return;
    }
    for (const day of days) {
      for (const f of readdirSync(join(root, day))) {
        const p = join(root, day, f);
        if (f.endsWith(".gz.tmp")) rmSync(p);
        else if (f.endsWith(".ndjson") && p !== current) this.compress(p);
      }
    }
  }

  write(line: string): void {
    const path = hourFile(this.dataDir, this.now());
    if (path !== this.path) this.rotate(path);
    this.stream!.write(line + "\n");
    this.lines++;
    this.bytes += line.length + 1;
  }

  get currentPath(): string | null {
    return this.path;
  }

  async close(): Promise<void> {
    await this.endStream();
    await Promise.all(this.compressing);
  }

  private rotate(path: string): void {
    const prev = this.path;
    const prevStream = this.stream;
    mkdirSync(join(path, ".."), { recursive: true });
    this.path = path;
    this.stream = createWriteStream(path, { flags: "a" });
    this.stream.on("error", (e) => this.onError(e));
    if (prev && prevStream) {
      // track immediately so close() waits for the flush + gzip of the hour we just left
      this.compress(prev, new Promise<void>((res) => prevStream.end(res)));
    }
  }

  private compress(file: string, flushed: Promise<void> = Promise.resolve()): void {
    const p = flushed.then(() => gzipFile(file)).catch((e: Error) => this.onError(e));
    this.compressing.add(p);
    void p.finally(() => this.compressing.delete(p));
  }

  private endStream(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    this.path = null;
    return new Promise((res) => (s ? s.end(res) : res()));
  }
}
