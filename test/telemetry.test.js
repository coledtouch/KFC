import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/telemetry.js', import.meta.url), 'utf8');
function load({ dnt, gpc, hidden = false, search = '', referrer = '', stored = new Map(), responses = [] } = {}) {
  const requests = [], listeners = new Map();
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const document = { visibilityState: hidden ? 'hidden' : 'visible', hidden, referrer, addEventListener: (event, callback) => listeners.set(event, callback) };
  const window = {};
  const context = vm.createContext({
    location: { pathname: '/', hostname: 'keepfixcut.com', search }, document, window,
    navigator: { doNotTrack: dnt, globalPrivacyControl: gpc },
    sessionStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    crypto: globalThis.crypto, URL, URLSearchParams, Blob, AbortSignal, Date: Clock, JSON, Number, Set, Object,
    setInterval: () => {}, fetch: async (url, options) => { requests.push({ url, body: options.body }); return new Response(null, { status: responses.shift() || 204 }); },
  });
  vm.runInContext(source, context);
  const flush = async () => { for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve)); };
  return { requests, window, stored, document, listeners, flush, advance: milliseconds => { now += milliseconds; }, body: async () => { await flush(); return JSON.parse(requests.at(-1).body); } };
}

test('browser telemetry sends only bounded metadata, strips referrer paths, and rejects unknown events', async () => {
  const client = load({ search: '?utm_source=reddit&utm_medium=social&utm_campaign=divorce_men&bio=private-profile', referrer: 'https://www.reddit.com/r/Divorce_Men/comments/private?token=secret' });
  const payload = await client.body();
  assert.deepEqual(Object.keys(payload).sort(), ['campaign', 'event', 'medium', 'path', 'referrer', 'sessionId', 'source']);
  assert.equal(payload.referrer, 'www.reddit.com');
  assert.equal(payload.source, 'reddit');
  assert.equal(payload.campaign, 'divorce_men');
  assert.equal(JSON.stringify(payload).includes('private'), false);
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  client.window.KFC_ANALYTICS.track('my-private-text');
  assert.equal(client.requests.length, 1);
});

test('privacy opt-outs send no browser analytics and create no session storage', async () => {
  for (const preference of [{ dnt: '1' }, { gpc: true }]) {
    const client = load(preference);
    client.window.KFC_ANALYTICS.track('scan_started');
    await client.flush();
    assert.equal(client.requests.length, 0);
    assert.equal(client.stored.size, 0);
  }
});

test('first visible view is counted and hidden tabs send no feature events', async () => {
  const client = load({ hidden: true });
  assert.equal(client.requests.length, 0);
  client.window.KFC_ANALYTICS.track('draft_saved');
  assert.equal(client.requests.length, 0);
  client.document.hidden = false; client.document.visibilityState = 'visible';
  client.listeners.get('visibilitychange')();
  assert.equal((await client.body()).event, 'page_view');
  client.document.hidden = true; client.document.visibilityState = 'hidden';
  client.listeners.get('visibilitychange')();
  assert.equal(client.requests.length, 1);
});

test('internal navigation preserves original session and campaign attribution', async () => {
  const initial = load({ search: '?utm_source=reddit&utm_campaign=launch' });
  const first = await initial.body();
  const next = load({ stored: initial.stored, referrer: 'https://keepfixcut.com/' });
  const second = await next.body();
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.source, 'reddit');
  assert.equal(second.campaign, 'launch');
});

test('resuming an idle tab starts a page view before sending its new heartbeat', async () => {
  const client = load();
  const first = await client.body();
  client.document.hidden = true; client.document.visibilityState = 'hidden';
  client.advance(31 * 60 * 1000);
  client.document.hidden = false; client.document.visibilityState = 'visible';
  client.listeners.get('visibilitychange')();
  await client.flush();
  const resumed = client.requests.slice(1).map(request => JSON.parse(request.body));
  assert.deepEqual(resumed.map(event => event.event), ['page_view', 'heartbeat']);
  assert.notEqual(resumed[0].sessionId, first.sessionId);
  assert.equal(resumed[0].sessionId, resumed[1].sessionId);
});

test('server-expired sessions recover and preserve the triggering feature event', async () => {
  const client = load({ responses: [204, 409, 204, 204] });
  const first = await client.body();
  client.window.KFC_ANALYTICS.track('photo_edited');
  await client.flush();
  const events = client.requests.map(request => JSON.parse(request.body));
  assert.deepEqual(events.map(event => event.event), ['page_view', 'photo_edited', 'page_view', 'photo_edited']);
  assert.notEqual(events[2].sessionId, first.sessionId);
  assert.equal(events[2].sessionId, events[3].sessionId);
});
