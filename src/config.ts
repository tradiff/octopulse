import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';

const units: Record<string, number> = {};
for (const [names, factor] of [
  ['ms millisecond milliseconds', 1], ['s sec secs second seconds', 1000],
  ['m min mins minute minutes', 60_000], ['h hr hrs hour hours', 3_600_000], ['d day days', 86_400_000],
] as const) for (const name of names.split(' ')) units[name] = factor;

export function duration(input: string): number {
  const match = /^\s*((?:\d+(?:\.\d+)?|\.\d+))\s*([a-z]+)\s*$/i.exec(input);
  const value = match ? Math.round(Number(match[1]) * (units[match[2]!.toLowerCase()] ?? NaN)) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000 - Date.now()) {
    throw new Error('Duration must round to positive, representable milliseconds');
  }
  return value;
}

const Duration = z.string().transform((value, context) => {
  try { return duration(value); } catch { context.addIssue({ code: 'custom', message: 'Invalid duration' }); return z.NEVER; }
});
const nonblank = z.string().trim().min(1);
const ProviderUrl = nonblank.refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && !value.includes('?') && !value.includes('#');
  } catch { return false; }
}, 'Invalid provider root').transform(value => value.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/systemone');
export const Config = z.strictObject({
  github: z.strictObject({ token: nonblank, login: nonblank.optional() }),
  system_one: z.strictObject({ base_url: ProviderUrl, api_key: nonblank, model: nonblank.default('jev-latest') }).optional(),
  timings: z.strictObject({
    tracked_poll_interval: Duration.prefault('1m'), discovery_poll_interval: Duration.prefault('5m'), grace_period: Duration.prefault('7 days'),
  }).prefault({}),
  logging: z.strictObject({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info'), retention: Duration.prefault('14 days') }).prefault({}),
  history: z.strictObject({ raw_payload_retention: Duration.prefault('30 days') }).prefault({}),
});
export type Config = z.infer<typeof Config>;

export function parseConfig(text: string): Config {
  let input: unknown;
  try { input = parse(text); } catch { throw new Error('Malformed TOML configuration'); }
  if (input && typeof input === 'object' && 'openai' in input) throw new Error('Replace obsolete openai configuration with system_one and its own credential');
  const result = Config.safeParse(input);
  if (!result.success) throw new Error('Invalid configuration: check required values, types, durations, URLs and unknown keys');
  return result.data;
}

export function loadConfig(path: string): Config {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error('Cannot read configuration file'); }
  return parseConfig(text);
}

export function pullRequestUrl(input: string): { repository: string; number: number } {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Expected an HTTPS GitHub pull request URL'); }
  const match = /^\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
    || !match || !Number.isSafeInteger(Number(match[2]))) throw new Error('Expected an HTTPS GitHub pull request URL');
  return { repository: match[1]!, number: Number(match[2]) };
}
