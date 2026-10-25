import { z } from 'zod';
import { Choice } from './model.js';
import type { Classifier } from './model.js';
import type { Config } from './config.js';
import { requestJson } from './http.js';
import type { Fetch } from './http.js';

export class SystemOne implements Classifier {
  constructor(private readonly config: NonNullable<Config['system_one']>, private readonly fetch: Fetch = globalThis.fetch) {}

  async classify(body: string, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await requestJson(this.fetch, this.config.base_url, {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, state: body, questions: { notification: {
          type: 'choice', instructions: 'Should this bot message notify the pull request author?',
          criteria: {
            notify: 'Negative, blocking or action-oriented messages; requested changes or follow-up; failures, broken, rejected or blocked states; human intervention; failing Sonar quality gate.',
            suppress: 'Praise, approvals, LGTM, all checks passing, successful Sonar or CI results, informational Jira ticket links or creation.',
          },
        } } }),
      }, signal, 10_000);
      if (response.status !== 200) throw new Error('Provider HTTP failure');
      const envelope = z.object({ answers: z.object({ notification: z.object({ type: z.literal('choice') }).passthrough() }) }).safeParse(response.body);
      if (!envelope.success) return null;
      const answer = Choice.safeParse({ ...envelope.data.answers.notification, type: 'Choice' });
      return answer.success ? answer.data : null;
    } catch { throw new Error('System One request failed'); }
  }
}
