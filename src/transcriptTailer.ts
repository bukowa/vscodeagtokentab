import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

export class TranscriptTailer extends EventEmitter {
  public readonly filePath: string;
  private offset = 0;
  private partial = '';
  private isReading = false;
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private isDisposed = false;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  public async start(): Promise<void> {
    if (this.isDisposed) return;
    await this.readNewBytes();

    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.readNewBytes().catch(() => {});
      });
      this.watcher.unref?.();
    } catch {}

    // Polling fallback to ensure real-time updates even if fs.watch misses on Windows
    this.pollInterval = setInterval(() => {
      this.readNewBytes().catch(() => {});
    }, 1000);
    this.pollInterval.unref?.();
  }

  public async readNewBytes(): Promise<void> {
    if (this.isReading || this.isDisposed) return;
    this.isReading = true;

    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size < this.offset) {
        // File was truncated or restarted
        this.offset = 0;
        this.partial = '';
        this.emit('reset');
      }

      if (stat.size === this.offset) {
        return;
      }

      const bytesToRead = stat.size - this.offset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = await fs.promises.open(this.filePath, 'r');
      try {
        await fd.read(buffer, 0, bytesToRead, this.offset);
      } finally {
        await fd.close();
      }

      const text = this.partial + buffer.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) {
        this.partial = text;
        return;
      }

      const complete = text.slice(0, lastNl);
      this.partial = text.slice(lastNl + 1);

      const lines = complete.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            const entry = JSON.parse(trimmed);
            this.emit('entry', entry);
          } catch {}
        }
      }

      this.offset = stat.size - Buffer.byteLength(this.partial, 'utf8');
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.isReading = false;
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.removeAllListeners();
  }
}
