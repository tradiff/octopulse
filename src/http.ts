import { abortable } from './cancellation.js';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function requestJson(
  fetch: Fetch, url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    combined.throwIfAborted();
    response = await abortable(fetch(url, { ...init, redirect: 'manual', signal: combined }), combined);
    if (response.status === 304 || response.status >= 300) {
      void response.body?.cancel().catch(() => {});
      return { status: response.status, headers: response.headers, body: null };
    }
    const max = 16 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) throw new Error('Response exceeds size limit');
    reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) while (true) {
      const part = await abortable(reader.read(), combined);
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw new Error('Response exceeds size limit');
      parts.push(part.value);
    }
    const text = Buffer.concat(parts).toString('utf8');
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
