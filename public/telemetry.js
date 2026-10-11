// Bounded app activity only. Never read profile fields, filenames, or upload content.
(() => {
  'use strict';
  if (!['/', '/privacy', '/privacy.html'].includes(location.pathname)) return;
  const allowed = new Set(['page_view', 'heartbeat', 'photo_added', 'voice_added', 'scan_started', 'draft_imported', 'draft_saved', 'profile_exported', 'photo_edited', 'report_downloaded']);
  const key = 'kfc:analytics-session:v1';
  const idleMs = 30 * 60 * 1000;
  const blocked = () => navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  let session = null, lastSent = 0, pageViewSent = false, announcedId = '', pending = 0;
  let delivery = Promise.resolve();
  const path = location.pathname === '/privacy.html' ? '/privacy' : location.pathname;
  const slug = value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value) ? value.toLowerCase() : '';
  const params = new URLSearchParams(location.search);
  const attribution = {
    source: slug(params.get('utm_source')),
    medium: slug(params.get('utm_medium')),
    campaign: slug(params.get('utm_campaign')),
    referrer: '',
  };
  try {
    const ref = new URL(document.referrer);
    if (['http:', 'https:'].includes(ref.protocol) && !['keepfixcut.com', 'www.keepfixcut.com', location.hostname].includes(ref.hostname)) attribution.referrer = ref.hostname;
  } catch {}

  function currentSession() {
    const now = Date.now();
    if (!session) {
      try { session = JSON.parse(sessionStorage.getItem(key)); } catch {}
    }
    if (!session || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.id) || !Number.isFinite(session.lastActivity) || now - session.lastActivity > idleMs || session.lastActivity > now) {
      session = { id: crypto.randomUUID(), lastActivity: now, attribution };
    }
    session.lastActivity = now;
    // Preserve the session's original source when navigating within the app.
    if (!session.attribution) session.attribution = attribution;
    try { sessionStorage.setItem(key, JSON.stringify(session)); } catch {}
    return session;
  }

  async function post(event, visit) {
    const saved = visit.attribution;
    const body = JSON.stringify({ event, sessionId: visit.id, path, referrer: typeof saved.referrer === 'string' ? saved.referrer.slice(0,253) : '', source: slug(saved.source), medium: slug(saved.medium), campaign: slug(saved.campaign) });
    return fetch('/api/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'omit', signal: AbortSignal.timeout(10000) });
  }
  async function deliver(event, visit) {
    if (blocked()) return;
    if (event !== 'page_view' && announcedId !== visit.id) {
      const initial = await post('page_view', visit);
      if (!initial.ok) return;
      announcedId = visit.id;
    }
    const response = await post(event, visit);
    if (response.ok) announcedId = visit.id;
    else if (response.status === 409) {
      // Recover a server-expired session without requiring a page reload.
      visit.id = crypto.randomUUID(); visit.lastActivity = Date.now();
      if (session === visit) { try { sessionStorage.setItem(key, JSON.stringify(visit)); } catch {} }
      const initial = await post('page_view', visit);
      if (!initial.ok) return;
      announcedId = visit.id;
      if (event !== 'page_view' && event !== 'heartbeat') await post(event, visit);
    }
  }
  function track(event) {
    if (blocked() || !allowed.has(event) || document.visibilityState !== 'visible') return;
    try {
      const now = Date.now();
      if (event === 'heartbeat' && now - lastSent < 25000) return;
      const visit = currentSession();
      if (pending >= 20) return;
      if (event === 'page_view') pageViewSent = true;
      lastSent = now;
      pending++;
      // Preserve ordering so a new page view arrives before its feature events.
      delivery = delivery.then(() => deliver(event, visit)).catch(() => {}).finally(() => { pending--; });
    } catch {}
  }
  window.KFC_ANALYTICS = Object.freeze({ track });
  track('page_view');
  setInterval(() => track('heartbeat'), 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) track(pageViewSent ? 'heartbeat' : 'page_view'); });
})();
