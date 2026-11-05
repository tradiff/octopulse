import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopAdapter } from '../src/desktop.js';
import type { DesktopMessage } from '../src/desktop.js';
import { Event, eventKey } from '../src/model.js';
import { desktopActivity, shortened } from '../src/presentation.js';
import { webFixture } from './web-fixture.js';
import { completeSources } from './fixture.js';

const event = (kind: Event['kind'], body = '', actor: Event['actor'] = { login: 'bea', bot: false }) => Event.parse({
  source: kind === 'comment' ? 'issue_comment' : kind === 'inline_comment' ? 'inline_comment'
    : ['review', 'approval', 'changes_requested'].includes(kind) ? 'review' : kind.startsWith('ci_') ? 'ci' : 'timeline',
  id: kind, kind, body, actor, targetUser: kind === 'review_requested' ? 'alex' : undefined, occurredAt: '2026-10-22T12:00:00Z',
});

test('desktop event headings and excerpts separate the event from the responding identity', () => {
  for (const [kind, heading] of Object.entries({
    comment: 'New comment', inline_comment: 'New inline comment', review: 'Review submitted', approval: 'Approved',
    changes_requested: 'Changes requested', review_requested: 'Review requested', close: 'PR closed', merge: 'PR merged',
    reopen: 'PR reopened', ready_for_review: 'Ready for review', converted_to_draft: 'Converted to draft',
    commit: 'New commits', ci_failure: 'CI failed', ci_success: 'CI passed',
  })) {
    const result = desktopActivity([event(kind as Event['kind'], '**Looks good.**')]);
    assert.equal(result.summary, kind === 'approval' ? '✅ Approved' : heading);
    assert.equal(result.updates[0]!.text, 'Looks good.');
    assert.equal(result.updates[0]!.actor?.login ?? null, kind.startsWith('ci_') ? null : 'bea');
    assert.equal(desktopActivity([event(kind as Event['kind'])]).updates[0]!.text, heading);
  }
  assert.equal(Array.from(desktopActivity([event('comment', '😀'.repeat(120))]).updates[0]!.text).length, 100);
  const bundle = desktopActivity([event('approval', 'Fine'), event('comment', 'word '.repeat(50))]);
  assert.equal(bundle.summary, '2 updates');
  assert.equal(bundle.updates[0]!.text, 'approved: Fine');
  assert.equal(bundle.updates[1]!.text, shortened('word '.repeat(50).trim(), 42));
  assert.equal(bundle.updates[1]!.separator, ': ');
});

test('rich desktop layout has an unconditional context separator, compact updates and saved-text fallbacks', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const saved = fixture.store.notifications().find(record => record.data.intent.prId === 'A')!.data.intent;
  const history = fixture.store.activities('A');
  const approval = history.find(activity => activity.event.kind === 'approval')!.event;
  assert.equal(saved.body, 'cam: ✅ approved: Approved');
  const comment = history.find(activity => activity.event.kind === 'comment')!.event;
  let sent!: DesktopMessage;
  const adapter = new DesktopAdapter(fixture.store, 'alex', {
    async capabilities() { return ['body-markup', 'actions']; },
    async notify(message) { sent = message; return 1; },
  });
  const signal = new AbortController().signal;
  for (const events of [[approval], [comment, approval]]) {
    assert.equal(await adapter.submit({ ...saved, events: events.map(eventKey) }, signal), 'sent');
    assert.equal(sent.summary, events.length === 1 ? '✅ Approved' : '2 updates');
    assert.ok(sent.body.startsWith('Make workflow retries reliable<br/>acme/widget #7 · alex<br/>&#160;<br/>'));
    assert.equal(sent.body.split('<br/>&#160;<br/>').length, 2);
    assert.doesNotMatch(sent.body, /\(open\)|💬|✅/);
    assert.match(sent.body, /<b>cam<\/b>/);
    assert.doesNotMatch(sent.body, /commented/);
    if (events.length > 1) assert.match(sent.body, /<b>bea<\/b>: Looks good\./);
    assert.equal(sent.icon, 'git-open');
  }
  assert.equal(await adapter.submit({ ...saved, events: ['review:expired'], body: 'Saved <text>\n\nNext' }, signal), 'sent');
  assert.equal(sent.summary, 'PR activity');
  assert.ok(sent.body.endsWith('Saved &lt;text&gt;<br/><br/>Next'));
  assert.equal(await adapter.submit({ ...saved, prId: 'missing', title: 'Saved title', body: 'Saved <text>' }, signal), 'sent');
  assert.equal(sent.summary, 'Saved title');
  assert.equal(sent.body, 'Saved &lt;text&gt;');
  assert.equal(await adapter.submit({ ...saved, kind: 'monitoring', title: 'Monitoring paused', body: 'Fix settings' }, signal), 'sent');
  assert.equal(sent.summary, 'Monitoring paused');
  assert.equal(sent.body, 'Fix settings');
  assert.equal(sent.icon, 'dialog-warning');
  assert.deepEqual(sent.actions, ['default', 'Open Settings']);
});

test('desktop keeps hyphenated identities intact without changing stored logins, excerpts or plain text', async t => {
  const fixture = await webFixture(); t.after(() => fixture.close());
  const snapshot = { ...fixture.store.pr('A')!.snapshot, author: 'byte-bot' };
  const activity = event('comment', 'byte-bot in the comment stays unchanged', { login: 'cache-goblin', bot: false });
  await fixture.monitor.observe({ snapshot, sources: completeSources, events: [activity] });
  const saved = fixture.store.notifications().find(record => record.data.intent.prId === 'A')!.data.intent;
  const intent = { ...saved, events: [eventKey(activity)] };
  let sent!: DesktopMessage;
  for (const capabilities of [['body-markup'], []]) {
    const desktop = new DesktopAdapter(fixture.store, 'alex', {
      async capabilities() { return capabilities; }, async notify(message) { sent = message; return 1; },
    });
    assert.equal(await desktop.submit(intent, new AbortController().signal), 'sent');
    if (capabilities.length) {
      assert.match(sent.body, /#7 · byte\u2060-\u2060bot<br\/>/);
      assert.match(sent.body, /<b>cache\u2060-\u2060goblin<\/b>: byte-bot in the comment stays unchanged/);
    } else assert.equal(sent.body, intent.body);
  }
  assert.equal(fixture.store.pr('A')!.snapshot.author, 'byte-bot');
  assert.equal(fixture.store.activities('A').find(item => eventKey(item.event) === eventKey(activity))!.event.actor!.login, 'cache-goblin');
});
