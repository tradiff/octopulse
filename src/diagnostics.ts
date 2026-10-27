import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Instant } from './model.js';
import type { Clock } from './model.js';

const levels = ['debug', 'info', 'warn', 'error'] as const;
export type Level = typeof levels[number];
const Entry = z.object({ at: Instant, level: z.enum(levels), message: z.string(), context: z.unknown().optional() });

export class Diagnostics {
  private day: string | undefined;
  constructor(private readonly directory: string, private readonly clock: Clock, private minimum: Level,
    private retentionMs: number, private readonly secrets: string[], private readonly output: (line: string) => void = console.error,
  ) {
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); this.prune(); }
    catch { this.output('Octopulse diagnostic initialization failed'); }
  }

  configure(minimum: Level, retentionMs: number, secrets: string[]): void {
    this.minimum = minimum; this.retentionMs = retentionMs;
    for (const secret of secrets) if (secret && !this.secrets.includes(secret)) this.secrets.push(secret);
    try { this.prune(); } catch { this.output('Octopulse diagnostic pruning failed'); }
  }

  private redact(text: string): string {
    for (const secret of [...this.secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
    return text;
  }

  write(level: Level, message: string, context?: unknown): void {
    if (levels.indexOf(level) < levels.indexOf(this.minimum)) return;
    const at = this.clock.now();
    let line: string;
    try {
      line = JSON.stringify({ at, level, message, ...(context === undefined ? {} : { context }) }, (_key, value: unknown) => {
        if (value instanceof Error) return this.redact(value.message);
        if (typeof value === 'string') return this.redact(value);
        if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), item]));
        return value;
      });
    } catch { line = JSON.stringify({ at, level, message: this.redact(message), context: 'Context could not be serialized' }); }
    this.output(line);
    try {
      const day = new Date(at).toISOString().slice(0, 10);
      if (day !== this.day) { this.prune(); this.day = day; }
      const path = join(this.directory, `${day}.jsonl`);
      appendFileSync(path, `${line}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
    } catch { this.output('Octopulse diagnostic write failed'); }
  }

  read(level?: Level): z.infer<typeof Entry>[] {
    const records: z.infer<typeof Entry>[] = [];
    try {
      for (const file of readdirSync(this.directory).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().reverse()) {
        let lines: string[];
        try { lines = readFileSync(join(this.directory, file), 'utf8').split('\n').reverse(); } catch { continue; }
        for (const line of lines) {
          try {
            const value = Entry.parse(JSON.parse(line));
            if (!level || value.level === level) records.push(value);
          } catch { /* A corrupt log line does not hide other records. */ }
        }
      }
    } catch { return []; }
    return records.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 200);
  }

  changeToken(): string | undefined {
    try {
      return JSON.stringify(readdirSync(this.directory).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().map(file => {
        const stat = statSync(join(this.directory, file), { bigint: true });
        return [file, String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
      }));
    } catch { return undefined; }
  }

  prune(): void {
    const cutoff = Date.parse(this.clock.now()) - this.retentionMs;
    for (const file of readdirSync(this.directory)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && Date.parse(`${file.slice(0, 10)}T00:00:00Z`) < cutoff) unlinkSync(join(this.directory, file));
    }
  }
}
