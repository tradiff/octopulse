import MarkdownIt from 'markdown-it';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });
const allowed = new Set(['p', 'br', 'hr', 'strong', 'b', 'em', 'i', 's', 'del', 'a', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'span', 'kbd', 'sub', 'sup', 'img']);
const discarded = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'form', 'textarea', 'select', 'button']);
const escape = markdown.utils.escapeHtml;

/** Render untrusted GitHub Markdown through a positive tag/attribute allowlist. */
export function commentHtml(body: string, repository: string): string {
  function url(value: string | undefined, image = false): string | undefined {
    if (!value) return;
    try {
      const target = new URL(value, `https://github.com/${repository}/`);
      if (target.protocol === 'https:' || (!image && target.protocol === 'http:')) return target.href;
    } catch {}
    return;
  }
  function render(node: DefaultTreeAdapterMap['node']): string {
    if ('value' in node) return escape(node.value);
    if (!('tagName' in node)) return 'childNodes' in node ? node.childNodes.map(render).join('') : '';
    const tag = node.tagName;
    if (discarded.has(tag) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return '';
    const attr = (name: string) => node.attrs.find(item => item.name === name)?.value;
    let attributes = '';
    let prefix = '';
    if (tag === 'li') {
      const first = node.childNodes[0];
      const text = first && 'tagName' in first && first.tagName === 'p' ? first.childNodes[0] : first;
      const task = text && 'value' in text ? /^\[([ xX])\]\s+/.exec(text.value) : null;
      if (task && text && 'value' in text) {
        text.value = text.value.slice(task[0].length);
        attributes = ' class="task-list-item"';
        prefix = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="${task[1] !== ' ' ? 'Completed' : 'Not completed'}"> `;
      }
    }
    const children = prefix + node.childNodes.map(render).join('');
    if (!allowed.has(tag)) return children;
    if (tag === 'a') {
      const href = url(attr('href'));
      if (href) attributes = ` href="${escape(href)}" rel="noreferrer noopener"`;
    }
    if (tag === 'img') {
      const src = url(attr('src'), true);
      return src ? `<img src="${escape(src)}" alt="${escape(attr('alt') ?? '')}" loading="lazy" referrerpolicy="no-referrer">` : escape(attr('alt') ?? '');
    }
    if (['a', 'code'].includes(tag) && attr('title')) attributes += ` title="${escape(attr('title')!)}"`;
    if (tag === 'details' && attr('open') !== undefined) attributes = ' open';
    if (tag === 'ol' && /^\d{1,9}$/.test(attr('start') ?? '')) attributes = ` start="${attr('start')}"`;
    if (tag === 'br' || tag === 'hr') return `<${tag}>`;
    return `<${tag}${attributes}>${children}</${tag}>`;
  }
  return render(parseFragment(markdown.render(body)));
}
