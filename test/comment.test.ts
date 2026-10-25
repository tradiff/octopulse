import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFragment } from 'parse5';
import { commentHtml } from '../src/comment.js';
import { readable } from '../src/presentation.js';
import { pullRequests } from '../src/views.js';
import { webFixture } from './web-fixture.js';
import { reviewComment } from './comment-fixture.js';

test('comments retain paragraphs, Markdown, nested disclosures and read-only tasks', () => {
  const html = commentHtml(reviewComment, 'acme/widget');
  assert.match(html, /<h2>Review summary<\/h2>/);
  assert.match(html, /<strong>2 findings<\/strong>/);
  assert.match(html, /<code>retryRequest\(\)<\/code>/);
  assert.match(html, /<details>\s*<summary><strong>Potential/);
  assert.equal((html.match(/<details>/g) ?? []).length, 3);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /type="checkbox" disabled aria-label="Not completed"/);
  assert.match(html, /<pre><code>const deadline/);
  assert.match(html, /<table>/);
  assert.match(html, /<s>Old suggestion<\/s>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /original timeout budget\.<br>\nThis line/);
  assert.equal(parseFragment(html).childNodes.length > 0, true);
});

test('comment HTML uses a positive allowlist and rejects executable content and attributes', () => {
  const html = commentHtml(`<script>alert(1)</script><style>body{display:none}</style>
<svg><a href="javascript:alert(1)">bad</a></svg><iframe srcdoc="bad"></iframe>
<details open name="pr" ontoggle="alert(1)"><summary style="color:red" id="track">Safe</summary>
<a href="java&#x73;cript:alert(1)" onclick="alert(1)">bad link</a>
<img src="https://example.com/image.png" onerror="alert(1)" alt='A "quote"'>
<img src="data:image/svg+xml,bad" alt="Unsafe image">
<input type="checkbox" checked><form action="/api/delete">Hidden</form>
</details>`, 'acme/widget');
  assert.doesNotMatch(html, /script|style|svg|iframe|srcdoc|ontoggle|onclick|onerror|id=|name=|<form|<input|data:/);
  assert.match(html, /<details open>/);
  assert.match(html, /<a>bad link<\/a>/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.match(html, /alt="A &quot;quote&quot;"/);
  assert.match(html, /Unsafe image/);
});

test('links resolve against GitHub, not the local action API', () => {
  const html = commentHtml('[issue](/acme/widget/issues/42) [relative](docs/test.md) [unsafe](javascript:alert(1))', 'acme/widget');
  assert.match(html, /href="https:\/\/github.com\/acme\/widget\/issues\/42"/);
  assert.match(html, /href="https:\/\/github.com\/acme\/widget\/docs\/test.md"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.equal(commentHtml('', 'acme/widget'), '');
  assert.equal(commentHtml('<img src="http://example.com/a" alt="insecure">', 'acme/widget'), 'insecure');
});

test('long code and text remain complete and escaped; malformed markup cannot add active elements', () => {
  const code = '<unsafe>' + 'longToken'.repeat(1000);
  const html = commentHtml(`~~~\n${code}\n~~~\n\n<details open><summary>Long review</summary>\n\n${'Paragraph. '.repeat(1000)}\n\n</details>`, 'acme/widget');
  assert.ok(html.includes('&lt;unsafe&gt;' + 'longToken'.repeat(1000)));
  assert.match(html, /<details open><summary>Long review<\/summary>/);
  for (const body of [
    '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
    '<svg><foreignObject><p onclick="alert(1)">bad</p></foreignObject></svg>',
    '<a href="jav&#x09;ascript:alert(1)">bad</a><img src="//example.com/x" onerror="bad">',
    '<div data-x="<img src=x onerror=bad>"><a href="data:text/html,bad">text</a></div>',
  ]) {
    const result = commentHtml(body, 'acme/widget');
    assert.doesNotMatch(result, /onerror|onclick|javascript:|data:|<svg|<math|<style/);
    assert.equal(commentHtml(result, 'acme/widget'), result, 'Reparsing sanitized markup remains safe');
  }
});

test('web projection adds rich comments without changing stored bodies or notification excerpts', async t => {
  const fixture = await webFixture(true); t.after(() => fixture.close());
  const pr = pullRequests(fixture.store, fixture.monitor, new URLSearchParams()).items.find(item => item.id === 'A')!;
  const comment = pr.timeline.find(item => item.event.id === 'hello')!;
  assert.match(comment.bodyHtml, /<details>/);
  assert.equal(comment.event.body, readable(reviewComment));
  assert.equal(fixture.store.activities('A').find(item => item.event.id === 'hello')!.event.body, reviewComment);
  assert.doesNotMatch(fixture.store.notifications()[0]!.data.intent.body, /<details>|<strong>/);
});
