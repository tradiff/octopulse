import { z } from 'zod';
import { Config } from './config.js';
import type { Store } from './store.js';

const Definition = Config.extend({
  github: z.strictObject({ token: z.string().trim().default('') }).prefault({}),
  system_one: Config.shape.system_one.unwrap().extend({ api_key: z.string().trim().default('') }).optional(),
});
const Secret = z.string().trim().min(1).refine(value => !value.includes('*'), 'Enter a complete key, not a masked preview');
const Update = Definition.extend({
  github: z.strictObject({ token: Secret.nullable().optional() }),
  system_one: z.strictObject({ base_url: z.string(), model: z.string(), api_key: Secret.nullable().optional() }).nullable().optional(),
});

function maskedSecret(value: string): string {
  return value ? '*'.repeat(20) + (value.length > 3 ? value.slice(-3) : '') : '';
}

function editable(config: Config) {
  const duration = (value: number) => {
    for (const [unit, size] of [['days', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
      if (value % size === 0) return `${value / size} ${unit}`;
    }
    return `${value}ms`;
  };
  return {
    ...config,
    github: { ...config.github },
    system_one: config.system_one ? { ...config.system_one, base_url: config.system_one.base_url.replace(/\/v1\/systemone$/, '') } : undefined,
    timings: { tracked_poll_interval: duration(config.timings.tracked_poll_interval),
      discovery_poll_interval: duration(config.timings.discovery_poll_interval), grace_period: duration(config.timings.grace_period) },
    logging: { ...config.logging, retention: duration(config.logging.retention) },
    history: { raw_payload_retention: duration(config.history.raw_payload_retention) },
  };
}

export class Settings {
  private saved: Config;
  private readonly environmentToken: string;

  constructor(private readonly store: Store, initial: Config | undefined, environment: NodeJS.ProcessEnv) {
    this.environmentToken = environment.GITHUB_TOKEN?.trim() ?? '';
    const existing = store.metadata('settings');
    if (existing !== undefined) this.saved = Definition.parse(JSON.parse(existing));
    else {
      this.saved = initial ?? Definition.parse({});
      if (this.saved.github.token === this.environmentToken) this.saved = { ...this.saved, github: { ...this.saved.github, token: '' } };
      this.persist(this.saved);
    }
  }

  private persist(config: Config): void {
    const input = editable(config);
    this.store.setMetadata('settings', JSON.stringify(input));
  }

  effective(): Config {
    return { ...this.saved, github: { ...this.saved.github, token: this.saved.github.token || this.environmentToken },
      system_one: this.saved.system_one?.api_key ? this.saved.system_one : undefined };
  }

  view() {
    const input = editable(this.saved);
    const token = this.effective().github.token;
    return {
      ...input,
      github: { environment_detected: Boolean(this.environmentToken),
        token_preview: maskedSecret(token),
        token_source: this.saved.github.token ? 'database' : this.environmentToken ? 'environment' : 'none' },
      system_one: input.system_one ? { base_url: input.system_one.base_url, model: input.system_one.model,
        api_key_preview: maskedSecret(input.system_one.api_key) } : null,
    };
  }

  update(body: unknown): void {
    const update = Update.safeParse(body);
    if (!update.success) throw new Error('Invalid settings. Check fields, durations, and unknown keys.');
    const input = update.data;
    const token = input.github.token === undefined ? this.saved.github.token : input.github.token ?? '';
    const merged = { ...body as object, github: { ...input.github, token: token === this.environmentToken ? '' : token },
      system_one: input.system_one ? { ...input.system_one,
        api_key: input.system_one.api_key === null ? '' : input.system_one.api_key ?? this.saved.system_one?.api_key ?? '' } : undefined };
    const next = Definition.safeParse(merged);
    if (!next.success) throw new Error('Invalid settings. Check durations, provider URL, and required credentials.');
    this.persist(next.data);
    this.saved = next.data;
  }
}

export type SettingsView = ReturnType<Settings['view']>;
