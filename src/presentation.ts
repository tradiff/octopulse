import MarkdownIt from 'markdown-it';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { canonical, eventKey } from './model.js';
import type { Activity, Event, Intent, Snapshot } from './model.js';

const markdown = new MarkdownIt({ html: true });

export function readable(body: string): string {
  body = body.replace(/&#(x[\da-f]+|\d+);/gi, (entity: string, digits: string) => {
    const code = digits[0]?.toLowerCase() === 'x' ? Number.parseInt(digits.slice(1), 16) : Number(digits);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? `&amp;${entity.slice(1)}` : entity;
  });
  const fragment = parseFragment(markdown.render(body));
  function text(node: DefaultTreeAdapterMap['node']): string {
    if ('tagName' in node && ['pre', 'script', 'style'].includes(node.tagName)) return '';
    if ('value' in node) return node.value;
    if ('tagName' in node && node.tagName === 'img') return node.attrs.find(attr => attr.name === 'alt')?.value ?? '';
    if ('childNodes' in node) {
      const result = node.childNodes.map(text).join('');
      return 'tagName' in node && ['p', 'li', 'div', 'br', 'tr', 'td', 'th', 'blockquote', 'summary', 'h1', 'h2', 'h3'].includes(node.tagName)
        ? ` ${result} ` : result;
    }
    return '';
  }
  return text(fragment).replace(/\[[ xX]\]\s*/g, '').replace(/\s+/g, ' ').trim();
}

const wording: Record<Event['kind'], string> = {
  comment: '💬', inline_comment: '💬', review: '💬 submitted review',
  approval: '✅ approval', changes_requested: '❗ requested changes', review_requested: '👀 review requested',
  close: 'closed', merge: 'merged', reopen: 'reopened', ready_for_review: 'ready for review',
  converted_to_draft: 'converted to draft', commit: 'pushed commits', ci_failure: 'CI failed', ci_success: 'CI passed',
};

export function intent(snapshot: Snapshot, events: Event[], kind: Intent['kind'], user: string, history: Activity[]): Intent {
  const own = canonical(snapshot.author) === canonical(user);
  const participated = new Set(history.filter(activity => activity.actorType === 'self' && activity.event.kind === 'inline_comment')
    .map(activity => activity.event.threadRoot ?? activity.event.id));
  const comments: Event['kind'][] = ['comment', 'inline_comment', 'review'];
  const sticky = events.some(event => ['review_requested', 'ready_for_review'].includes(event.kind)
    || (own && [...comments, 'approval', 'changes_requested'].includes(event.kind))
    || (event.kind === 'inline_comment' && participated.has(event.threadRoot ?? event.id)));
  return {
    prId: snapshot.id,
    kind,
    events: events.map(eventKey),
    title: `${snapshot.repository} #${snapshot.number} ${snapshot.title}`,
    body: events.map(event => {
      const full = Array.from(readable(event.body));
      const excerpt = full.length > 100 ? `${full.slice(0, 97).join('')}...` : full.join('');
      const actor = event.actor && !event.kind.startsWith('ci_') ? `${event.actor.login}: ` : '';
      return `${actor}${wording[event.kind]}${excerpt ? `: ${excerpt}` : ''}`;
    }).join('\n\n'),
    destination: `https://github.com/${snapshot.repository}/pull/${snapshot.number}`,
    expiryMs: sticky ? 0 : 10000,
    sound: own && events.some(event => event.kind === 'approval') ? 'approval'
      : own && events.some(event => comments.includes(event.kind)) ? 'comment' : null,
  };
}
