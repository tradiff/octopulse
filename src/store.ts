import Database from 'better-sqlite3';
import { z } from 'zod';
import { Activity, Actor, Attempt, Instant, Notification, PullRequest, Snapshot, Staged, canonical, eventKey } from './model.js';
import { filters } from './filters.js';

const Row = z.object({ data: z.string() });
const IdRow = Row.extend({ id: z.number().int() });
const automaticDelivery = `json_extract(data, '$.automatic') = 1 AND json_extract(data, '$.status') != 'sent'
  AND json_extract(data, '$.runningAt') IS NULL`;
const deliveryAt = `min(coalesce(julianday(json_extract(data, '$.nextAttemptAt')), julianday(json_extract(data, '$.preparedAt'), '+1 day')),
  julianday(json_extract(data, '$.preparedAt'), '+1 day'))`;
const activityTime = "julianday(json_extract(data, '$.event.occurredAt'))";
const activityKey = "(source || ':' || source_id) COLLATE BINARY";
export const ActivityCursor = z.strictObject({ at: Instant, key: z.string().min(1) });

function prWhere(filter: ReturnType<typeof filters>): { sql: string; values: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (filter.repository) { clauses.push("json_extract(p.data, '$.snapshot.repository') = ?"); values.push(filter.repository); }
  for (const [path, selected] of [['tracked', filter.tracking.map(value => value === 'tracked' ? 1 : 0)], ['snapshot.state', filter.lifecycle]] as const) {
    if (selected.length) { clauses.push(`json_extract(p.data, '$.${path}') IN (${selected.map(() => '?').join(',')})`); values.push(...selected); }
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1', values };
}

function pageBounds(total: number, query: URLSearchParams) {
  const pages = Math.max(1, Math.ceil(total / 50));
  const requested = Number(query.get('page') ?? 1);
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
  return { page, pages, total, from: total ? (page - 1) * 50 + 1 : 0, to: Math.min(page * 50, total) };
}

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    try {
      const version = z.number().int().parse(this.db.pragma('user_version', { simple: true }));
      if (version > 1) throw new Error('Profile schema is newer than this application');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.transaction(() => {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS pull_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activities (
        pr_id TEXT NOT NULL REFERENCES pull_requests(id),
        source TEXT NOT NULL, source_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (pr_id, source, source_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id TEXT NOT NULL REFERENCES pull_requests(id), data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observations_pr_id ON observations(pr_id);
      CREATE INDEX IF NOT EXISTS observations_pending ON observations(pr_id, json_extract(data, '$.generation'), id)
        WHERE json_extract(data, '$.processed') = 0;
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id TEXT NOT NULL REFERENCES pull_requests(id), data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notification_id INTEGER NOT NULL REFERENCES notifications(id), data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notifications_delivery_due ON notifications(${deliveryAt}, id) WHERE ${automaticDelivery};
      CREATE INDEX IF NOT EXISTS notifications_running ON notifications(id) WHERE json_extract(data, '$.runningAt') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS notifications_history ON notifications(julianday(json_extract(data, '$.createdAt')) DESC, id DESC);
      CREATE INDEX IF NOT EXISTS activities_visible_time ON activities(pr_id, ${activityTime} DESC, ${activityKey} DESC)
        WHERE json_extract(data, '$.visible') = 1;
      CREATE INDEX IF NOT EXISTS activities_people ON activities(pr_id, lower(json_extract(data, '$.event.actor.login')),
        json_extract(data, '$.event.actor'), json_extract(data, '$.event.actor.bot'), json_extract(data, '$.event.kind'))
        WHERE json_extract(data, '$.event.actor') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS attempts_notification ON attempts(notification_id);
      CREATE TABLE IF NOT EXISTS failed_inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pr_id TEXT NOT NULL REFERENCES pull_requests(id),
        source TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pr_id TEXT NOT NULL REFERENCES pull_requests(id),
        source TEXT NOT NULL, occurred_at TEXT, payload TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 1;
        `);
        if (version === 0) {
          const missing = z.array(z.string()).parse(this.db.prepare(`SELECT id FROM pull_requests
            WHERE json_type(data, '$.snapshot.requestedReviewers') IS NULL OR json_type(data, '$.snapshot.requestedTeams') IS NULL`).pluck().all());
          this.setMetadata('reviewRefreshPending', JSON.stringify(missing));
        }
      })();
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }
  transaction<T>(run: () => T): T { return this.db.transaction(run)(); }

  metadata(key: string): string | undefined {
    return z.string().optional().parse(this.db.prepare('SELECT value FROM metadata WHERE key = ?').pluck().get(key));
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare('INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  bindIdentity(login: string, now: string): string {
    return this.transaction(() => {
      const saved = this.metadata('login');
      if (saved && saved !== canonical(login)) throw new Error('Profile belongs to another login; select a fresh profile');
      this.setMetadata('login', canonical(login));
      const baseline = this.metadata('reviewBaseline') ?? Instant.parse(now);
      this.setMetadata('reviewBaseline', baseline);
      return baseline;
    });
  }

  rawInput(prId: string, source: string, payload: unknown, occurredAt: string | null): number {
    return Number(this.db.prepare('INSERT INTO raw_inputs(pr_id, source, occurred_at, payload) VALUES (?, ?, ?, ?)')
      .run(prId, source, occurredAt, JSON.stringify(payload)).lastInsertRowid);
  }

  completeRaw(prId: string, ids: number[]): void {
    const update = this.db.prepare('UPDATE raw_inputs SET processed = 1 WHERE id = ? AND pr_id = ?');
    for (const id of ids) update.run(id, prId);
  }

  rawInputs(prId: string): { id: number; source: string; occurredAt: string | null; payload: unknown; processed: boolean }[] {
    return this.db.prepare('SELECT * FROM raw_inputs WHERE pr_id = ? ORDER BY id').all(prId).map(row => {
      const value = z.object({ id: z.number(), source: z.string(), occurred_at: z.string().nullable(), payload: z.string(), processed: z.number() }).parse(row);
      return { id: value.id, source: value.source, occurredAt: value.occurred_at, payload: JSON.parse(value.payload), processed: value.processed === 1 };
    });
  }

  reclaim(): void { this.db.pragma('wal_checkpoint(TRUNCATE)'); this.db.exec('VACUUM'); }

  pr(id: string): PullRequest | undefined {
    const row = this.db.prepare('SELECT data FROM pull_requests WHERE id = ?').get(id);
    return row ? PullRequest.parse(JSON.parse(Row.parse(row).data)) : undefined;
  }

  prs(): PullRequest[] {
    return this.db.prepare('SELECT data FROM pull_requests ORDER BY id').all()
      .map(row => PullRequest.parse(JSON.parse(Row.parse(row).data)));
  }

  savePr(pr: PullRequest): void {
    this.db.prepare('INSERT INTO pull_requests VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(pr.snapshot.id, JSON.stringify(pr));
  }

  activities(prId: string): Activity[] {
    return this.db.prepare('SELECT data FROM activities WHERE pr_id = ? ORDER BY rowid').all(prId)
      .map(row => Activity.parse(JSON.parse(Row.parse(row).data)));
  }

  repositories(): string[] {
    return z.array(z.string()).parse(this.db.prepare("SELECT DISTINCT json_extract(data, '$.snapshot.repository') FROM pull_requests ORDER BY 1").pluck().all());
  }

  pullRequestPage(query: URLSearchParams, user: string, teams: string[]) {
    const filter = filters(query);
    const where = prWhere(filter);
    const queue = `CASE WHEN lower(json_extract(p.data, '$.snapshot.author')) = ? THEN 'my-prs'
      WHEN json_extract(p.data, '$.snapshot.state') = 'open' AND (
        EXISTS (SELECT 1 FROM json_each(p.data, '$.snapshot.requestedReviewers') WHERE lower(value) = ?)
        OR EXISTS (SELECT 1 FROM json_each(p.data, '$.snapshot.requestedTeams') WHERE value IN (SELECT value FROM json_each(?)))
      ) THEN 'needs-my-review' ELSE 'review-requests' END`;
    const cte = `WITH filtered AS (SELECT p.rowid creation_order, p.id, p.data, ${queue} queue FROM pull_requests p WHERE ${where.sql})`;
    const values = [canonical(user), canonical(user), JSON.stringify(teams), ...where.values];
    const rows = z.array(z.object({ queue: z.string(), count: z.number().int() })).parse(this.db.prepare(`${cte} SELECT queue, count(*) count FROM filtered GROUP BY queue`).all(...values));
    const counts = { 'my-prs': 0, 'needs-my-review': 0, 'review-requested': 0 };
    for (const row of rows) counts[row.queue === 'review-requests' ? 'review-requested' : row.queue as keyof typeof counts] = row.count;
    const tab = query.get('tab');
    const selected = tab === 'needs-my-review' || tab === 'review-requested' ? tab : 'my-prs';
    const bounds = pageBounds(counts[selected], query);
    const items = this.db.prepare(`${cte} SELECT data FROM filtered p WHERE queue = ? ORDER BY
      coalesce((SELECT ${activityTime} FROM activities WHERE pr_id = p.id AND json_extract(data, '$.visible') = 1
        ORDER BY ${activityTime} DESC, ${activityKey} DESC LIMIT 1),
        julianday(json_extract(p.data, '$.recordedAt')), julianday(json_extract(p.data, '$.snapshot.updatedAt')), julianday('1970-01-01')) DESC,
      creation_order DESC LIMIT 50 OFFSET ?`).all(...values, selected === 'review-requested' ? 'review-requests' : selected, (bounds.page - 1) * 50)
      .map(row => PullRequest.parse(JSON.parse(Row.parse(row).data)));
    return { ...bounds, counts, items };
  }

  activitySummary(prId: string) {
    const summary = z.object({ count: z.number().int(), latestAt: z.string().nullable() }).parse(this.db.prepare(`SELECT count(*) count,
      (SELECT json_extract(data, '$.event.occurredAt') FROM activities WHERE pr_id = ? AND json_extract(data, '$.visible') = 1
        ORDER BY ${activityTime} DESC, ${activityKey} DESC LIMIT 1) latestAt
      FROM activities WHERE pr_id = ? AND json_extract(data, '$.visible') = 1`).get(prId, prId));
    // SQLite selects bare actor columns from the row supplying the single max(rowid) aggregate.
    const people = this.db.prepare(`SELECT json_extract(data, '$.event.actor') actor, max(rowid) latest,
      sum(json_extract(data, '$.event.actor.bot')) > 0 bot,
      sum(json_extract(data, '$.event.kind') IN ('comment', 'inline_comment', 'review')) > 0 commenter
      FROM activities WHERE pr_id = ? AND json_extract(data, '$.event.actor') IS NOT NULL
      GROUP BY lower(json_extract(data, '$.event.actor.login'))`).all(prId).map(row => {
        const value = z.object({ actor: z.string(), bot: z.number().nullable(), commenter: z.number() }).parse(row);
        return { actor: Actor.parse(JSON.parse(value.actor)), bot: value.bot === 1, commenter: value.commenter === 1 };
      });
    return { ...summary, people };
  }

  activityPage(prId: string, cursor: z.infer<typeof ActivityCursor> | null) {
    const total = z.number().int().parse(this.db.prepare("SELECT count(*) FROM activities WHERE pr_id = ? AND json_extract(data, '$.visible') = 1").pluck().get(prId));
    const before = cursor ? ` AND (${activityTime}, ${activityKey}) < (julianday(?), ? COLLATE BINARY)` : '';
    const items = this.db.prepare(`SELECT data FROM activities WHERE pr_id = ? AND json_extract(data, '$.visible') = 1
      ${before} ORDER BY ${activityTime} DESC, ${activityKey} DESC LIMIT 51`).all(prId, ...(cursor ? [cursor.at, cursor.key] : []))
      .map(row => Activity.parse(JSON.parse(Row.parse(row).data)));
    const more = items.length > 50;
    if (more) items.pop();
    const last = items.at(-1);
    return { total, items, nextCursor: more && last ? JSON.stringify({ at: last.event.occurredAt, key: eventKey(last.event) }) : null };
  }

  notificationPage(query: URLSearchParams) {
    const filter = filters(query, true);
    const where = prWhere(filter);
    if (filter.actors.length) {
      where.sql += ` AND EXISTS (SELECT 1 FROM json_each(n.data, '$.intent.events') e JOIN activities a
        ON a.pr_id = n.pr_id AND a.source = substr(e.value, 1, instr(e.value, ':') - 1) AND a.source_id = substr(e.value, instr(e.value, ':') + 1)
        WHERE json_extract(a.data, '$.actorType') IN (${filter.actors.map(() => '?').join(',')}))`;
      where.values.push(...filter.actors);
    }
    const from = `FROM notifications n JOIN pull_requests p ON p.id = n.pr_id WHERE ${where.sql}`;
    const total = z.number().int().parse(this.db.prepare(`SELECT count(*) ${from}`).pluck().get(...where.values));
    const bounds = pageBounds(total, query);
    const items = this.db.prepare(`SELECT n.id, n.data, json_extract(p.data, '$.snapshot') snapshot, json_extract(p.data, '$.tracked') tracked,
      (SELECT json_group_array(json_extract(a.data, '$.decision') ORDER BY CAST(e.key AS INTEGER))
        FROM json_each(n.data, '$.intent.events') e JOIN activities a ON a.pr_id = n.pr_id
          AND a.source = substr(e.value, 1, instr(e.value, ':') - 1) AND a.source_id = substr(e.value, instr(e.value, ':') + 1)) decisions
      ${from} ORDER BY julianday(json_extract(n.data, '$.createdAt')) DESC, n.id DESC LIMIT 50 OFFSET ?`)
      .all(...where.values, (bounds.page - 1) * 50).map(row => {
        const value = IdRow.extend({ snapshot: z.string(), tracked: z.number(), decisions: z.string() }).parse(row);
        return { id: value.id, data: Notification.parse(JSON.parse(value.data)), snapshot: Snapshot.parse(JSON.parse(value.snapshot)),
          tracked: value.tracked === 1, decisions: z.array(z.string()).parse(JSON.parse(value.decisions)) };
      });
    return { ...bounds, items };
  }

  saveActivity(prId: string, activity: Activity): void {
    this.db.prepare('INSERT INTO activities VALUES (?, ?, ?, ?)')
      .run(prId, activity.event.source, activity.event.id, JSON.stringify(activity));
  }

  updateActivity(prId: string, activity: Activity): void {
    this.db.prepare('UPDATE activities SET data = ? WHERE pr_id = ? AND source = ? AND source_id = ?')
      .run(JSON.stringify(activity), prId, activity.event.source, activity.event.id);
  }

  failedInput(prId: string, source: string, payload: unknown, observedAt: string): void {
    this.db.prepare('INSERT INTO failed_inputs(pr_id, source, observed_at, payload) VALUES (?, ?, ?, ?)')
      .run(prId, source, observedAt, JSON.stringify(payload) ?? 'null');
  }

  failedInputCount(prId: string): number {
    return z.number().int().parse(this.db.prepare('SELECT count(*) FROM failed_inputs WHERE pr_id = ?').pluck().get(prId));
  }

  failedInputs(prId: string): { source: string; observedAt: string; payload: unknown }[] {
    return this.db.prepare('SELECT source, observed_at, payload FROM failed_inputs WHERE pr_id = ? ORDER BY id').all(prId)
      .map(row => {
        const value = z.object({ source: z.string(), observed_at: z.string(), payload: z.string() }).parse(row);
        return { source: value.source, observedAt: value.observed_at, payload: JSON.parse(value.payload) };
      });
  }

  prune(now: string, retentionMs: number): void {
    if (!Number.isFinite(retentionMs) || retentionMs <= 0 || !Number.isFinite(Date.parse(now))) throw new Error('Invalid retention boundary');
    const cutoff = Date.parse(now) - retentionMs;
    this.transaction(() => {
      this.db.prepare('DELETE FROM raw_inputs WHERE processed = 1 AND julianday(occurred_at) < julianday(?)')
        .run(new Date(cutoff).toISOString());
      for (const pr of this.prs()) {
        if (Object.keys(pr.fetchState.pages).length) this.savePr({ ...pr, fetchState: { ...pr.fetchState, pages: {} } });
        for (const { id, data } of this.staged(pr.snapshot.id)) {
          if (!data.processed) continue;
          const observation = data.observation;
          const hadCache = observation.fetchState !== undefined;
          delete observation.fetchState;
          const originalCount = observation.events.length + observation.reviews.length + (observation.workflows?.length ?? 0);
          observation.events = observation.events.filter(event => Date.parse(event.occurredAt) >= cutoff);
          observation.reviews = observation.reviews.filter(review => !review.submittedAt || Date.parse(review.submittedAt) >= cutoff);
          if (observation.workflows) observation.workflows = observation.workflows.filter(run => Date.parse(run.updatedAt) >= cutoff);
          const remainingCount = observation.events.length + observation.reviews.length + (observation.workflows?.length ?? 0);
          if (!remainingCount && (originalCount > 0 || Date.parse(data.observedAt) < cutoff)) this.db.prepare('DELETE FROM observations WHERE id = ?').run(id);
          else if (remainingCount !== originalCount || hadCache) this.saveStaged(id, data);
        }
      }
    });
  }

  stage(prId: string, batch: Staged): void {
    this.db.prepare('INSERT INTO observations(pr_id, data) VALUES (?, ?)').run(prId, JSON.stringify(batch));
  }

  staged(prId: string, pendingGeneration?: number): { id: number; data: Staged }[] {
    const rows = pendingGeneration === undefined
      ? this.db.prepare('SELECT id, data FROM observations WHERE pr_id = ? ORDER BY id').all(prId)
      : this.db.prepare(`SELECT id, data FROM observations WHERE pr_id = ?
          AND json_extract(data, '$.processed') = 0 AND json_extract(data, '$.generation') = ? ORDER BY id`).all(prId, pendingGeneration);
    return rows
      .map(row => { const parsed = IdRow.parse(row); return { id: parsed.id, data: Staged.parse(JSON.parse(parsed.data)) }; });
  }

  saveStaged(id: number, data: Staged): void {
    this.db.prepare('UPDATE observations SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
  }

  notifications(): { id: number; data: Notification }[] {
    return this.db.prepare('SELECT id, data FROM notifications ORDER BY id').all()
      .map(row => { const parsed = IdRow.parse(row); return { id: parsed.id, data: Notification.parse(JSON.parse(parsed.data)) }; });
  }

  notificationIds(): number[] {
    return z.array(z.number().int()).parse(this.db.prepare('SELECT id FROM notifications ORDER BY id').pluck().all());
  }

  dueNotificationIds(now: string, limit: number): number[] {
    return z.array(z.number().int()).parse(this.db.prepare(`SELECT id FROM notifications
      WHERE ${automaticDelivery} AND ${deliveryAt} <= julianday(?) ORDER BY ${deliveryAt}, id LIMIT ?`).pluck().all(now, limit));
  }

  runningNotifications(): { id: number; data: Notification }[] {
    return this.db.prepare(`SELECT id, data FROM notifications WHERE json_extract(data, '$.runningAt') IS NOT NULL ORDER BY id`).all()
      .map(row => { const parsed = IdRow.parse(row); return { id: parsed.id, data: Notification.parse(JSON.parse(parsed.data)) }; });
  }

  notification(id: number): Notification {
    const row = this.db.prepare('SELECT data FROM notifications WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown notification');
    return Notification.parse(JSON.parse(Row.parse(row).data));
  }

  insertNotification(data: Notification): number {
    return Number(this.db.prepare('INSERT INTO notifications(pr_id, data) VALUES (?, ?)')
      .run(data.intent.prId, JSON.stringify(data)).lastInsertRowid);
  }

  saveNotification(id: number, data: Notification): void {
    this.db.prepare('UPDATE notifications SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
  }

  insertAttempt(notificationId: number, attempt: Attempt): number {
    return Number(this.db.prepare('INSERT INTO attempts(notification_id, data) VALUES (?, ?)')
      .run(notificationId, JSON.stringify(attempt)).lastInsertRowid);
  }

  saveAttempt(id: number, attempt: Attempt): void {
    this.db.prepare('UPDATE attempts SET data = ? WHERE id = ?').run(JSON.stringify(attempt), id);
  }

  attempts(notificationId: number): { id: number; data: Attempt }[] {
    return this.db.prepare('SELECT id, data FROM attempts WHERE notification_id = ? ORDER BY id').all(notificationId)
      .map(row => { const parsed = IdRow.parse(row); return { id: parsed.id, data: Attempt.parse(JSON.parse(parsed.data)) }; });
  }
}
