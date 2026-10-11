// Privacy-limited operational analytics. No uploads or identifying request data
// are accepted by the storage contract. D1 writes never delay a profile scan.
export const RETENTION_DAYS = 30;
export const ACTIVE_WINDOW_SECONDS = 90;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const EVENTS = new Set(["page_view", "heartbeat", "photo_added", "voice_added", "scan_started", "draft_imported", "draft_saved", "profile_exported", "photo_edited", "report_downloaded"]);
const CLIENT_PATHS = new Set(["/", "/privacy"]);
const HTTP_PATHS = new Set(["/", "/privacy", "/api/config", "/api/scan"]);
const ERROR_CODES = new Set(["voice_transcription_failed", "provider_timeout", "provider_unavailable", "provider_error", "provider_refusal", "incomplete_report", "invalid_request", "rate_limited", "service_unavailable", "scan_failed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export class AnalyticsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function privateJson(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow, noarchive", ...headers } });
}
export function requireOrigin(request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) throw new AnalyticsError(403, "This action must come from this site.");
}
export async function readSmallJson(request, maxBytes = 4096) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) throw new AnalyticsError(415, "Send JSON.");
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new AnalyticsError(413, "The request is too large.");
  if (!request.body) throw new AnalyticsError(400, "The request is empty.");
  const reader = request.body.getReader();
  let timer, size = 0;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new AnalyticsError(408, "The request took too long.")); }, 5000); });
  try {
    return await Promise.race([timeout, (async () => {
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new AnalyticsError(413, "The request is too large."); }
        chunks.push(value);
      }
      const joined = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      let value;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)); } catch { throw new AnalyticsError(400, "The JSON couldn't be read."); }
      if (!isRecord(value)) throw new AnalyticsError(400, "Send a JSON object.");
      return value;
    })()]);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
export const isRecord = value => !!value && typeof value === "object" && !Array.isArray(value);
export async function sha256(value) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
}
function boundedInteger(value, max, fallback = null) { return Number.isInteger(value) && value >= 0 && value <= max ? value : fallback; }
function safeStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 500; }
function safeModel(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value) ? value : "unknown"; }
function safeError(value, status) { return ERROR_CODES.has(value) ? value : status >= 400 ? `http_${status}` : null; }
function schedule(ctx, promise) {
  const safe = promise.catch(() => { console.error("analytics_write_failed"); });
  if (ctx?.waitUntil) ctx.waitUntil(safe);
  return safe;
}
function metadata(db, timestamp) { return db.prepare("INSERT OR IGNORE INTO analytics_meta(key,value) VALUES('tracking_start',?)").bind(String(timestamp)); }

export function normalizeUsage(usage) {
  if (!isRecord(usage)) return null;
  const input = boundedInteger(usage.input_tokens, 100000000);
  const output = boundedInteger(usage.output_tokens, 100000000);
  if (input === null || output === null) return null;
  const read = usage.cache_read_input_tokens === undefined ? 0 : boundedInteger(usage.cache_read_input_tokens, 100000000);
  const creation = usage.cache_creation_input_tokens === undefined ? 0 : boundedInteger(usage.cache_creation_input_tokens, 100000000);
  if (read === null || creation === null) return null;
  let write5m = creation === 0 ? 0 : null, write1h = creation === 0 ? 0 : null;
  if (isRecord(usage.cache_creation)) {
    write5m = boundedInteger(usage.cache_creation.ephemeral_5m_input_tokens, 100000000);
    write1h = boundedInteger(usage.cache_creation.ephemeral_1h_input_tokens, 100000000);
    if (write5m === null || write1h === null || write5m + write1h !== creation) { write5m = null; write1h = null; }
  }
  return { input, output, read, creation, write5m, write1h };
}
export function estimateCost(env, model, usage, providerAttempted) {
  if (!providerAttempted) return 0;
  if (!usage || model !== env.ANALYTICS_PRICE_MODEL) return null;
  const rate = name => { const raw = env[name]; return typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw) && Number(raw) <= 10000 ? Number(raw) : null; };
  const items = [[usage.input, rate("ANALYTICS_INPUT_USD_PER_MTOK")], [usage.output, rate("ANALYTICS_OUTPUT_USD_PER_MTOK")], [usage.read, rate("ANALYTICS_CACHE_READ_USD_PER_MTOK")], [usage.write5m, rate("ANALYTICS_CACHE_WRITE_5M_USD_PER_MTOK")], [usage.write1h, rate("ANALYTICS_CACHE_WRITE_1H_USD_PER_MTOK")]];
  if (items.some(([tokens, price]) => tokens === null || tokens > 0 && price === null)) return null;
  return items.reduce((sum, [tokens, price]) => sum + tokens * (price ?? 0) / 1000000, 0);
}

/** Internal contract: status/providerStatus,durationMs,model,mode,app,imageCount,
 * voiceSeconds,usage,providerAttempted,errorCode. Never pass a request or body. */
export function recordScan(env, ctx, event) {
  if (!env.ANALYTICS_DB || !isRecord(event)) return;
  const db = env.ANALYTICS_DB, now = Date.now(), status = safeStatus(event.status);
  const usage = normalizeUsage(event.usage), model = safeModel(event.model), attempted = event.providerAttempted === true;
  const cost = estimateCost(env, model, usage, attempted);
  const values = [now, status, event.providerStatus == null ? null : safeStatus(event.providerStatus), boundedInteger(event.durationMs, 600000, 0), model,
    ["text", "photo", "voice", "mixed"].includes(event.mode) ? event.mode : "text", ["Hinge", "Tinder", "Bumble", "Other"].includes(event.app) ? event.app : "unknown",
    boundedInteger(event.imageCount, 6, 0), typeof event.voiceSeconds === "number" && Number.isFinite(event.voiceSeconds) && event.voiceSeconds >= 0 && event.voiceSeconds <= 60 ? event.voiceSeconds : 0,
    attempted ? 1 : 0, safeError(event.errorCode, status), usage?.input ?? null, usage?.output ?? null, usage?.read ?? null, usage?.creation ?? null, usage?.write5m ?? null, usage?.write1h ?? null, cost];
  return schedule(ctx, Promise.resolve().then(() => db.batch([metadata(db, now), db.prepare("INSERT INTO analytics_scans(timestamp,status,provider_status,duration_ms,model,mode,app,image_count,voice_seconds,provider_attempted,error_code,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cache_write_5m_tokens,cache_write_1h_tokens,estimated_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...values)])));
}
/** Internal contract: allowlisted path, status, optional durationMs/errorCode/method.
 * Records page requests separately from consenting client page-view events. */
export function recordHttp(env, ctx, event) {
  if (!env.ANALYTICS_DB || !isRecord(event) || !HTTP_PATHS.has(event.path) || event.method && !["GET", "HEAD", "POST"].includes(event.method)) return;
  const db = env.ANALYTICS_DB, now = Date.now(), status = safeStatus(event.status);
  return schedule(ctx, Promise.resolve().then(() => db.batch([metadata(db, now), db.prepare("INSERT INTO analytics_events(timestamp,event,path,status,duration_ms,error_code) VALUES(?,'http_request',?,?,?,?)").bind(now, event.path, status, boundedInteger(event.durationMs, 600000), safeError(event.errorCode, status))])));
}
function safeReferrer(value) {
  if (value === "" || value === undefined || value === null) return "Direct";
  if (typeof value !== "string" || value.length > 253 || !/^[a-z0-9.-]+$/i.test(value)) throw new AnalyticsError(400, "Send a referrer hostname only.");
  const host = value.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /^\d+(?:\.\d+){3}$/.test(host) || host.endsWith(".local") || host === "localhost" || host.split(".").some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new AnalyticsError(400, "Send a public referrer hostname only.");
  return host;
}
function slug(value) { if (value === undefined || value === null || value === "") return ""; if (typeof value !== "string" || !/^[a-z0-9_-]{1,64}$/.test(value)) throw new AnalyticsError(400, "Campaign values must be short safe labels."); return value; }
function deviceCategory(ua) { if (!ua) return "Unknown"; if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return "Tablet"; return /Mobi|iPhone|Android/i.test(ua) ? "Mobile" : "Desktop"; }
export function normalizeTelemetry(body, request) {
  if (!isRecord(body) || Object.keys(body).some(key => !["event", "sessionId", "path", "referrer", "source", "medium", "campaign"].includes(key)) || !EVENTS.has(body.event) || !UUID.test(body.sessionId || "") || !CLIENT_PATHS.has(body.path)) throw new AnalyticsError(400, "The analytics event isn't valid.");
  const country = typeof request.cf?.country === "string" && /^[A-Z]{2}$/.test(request.cf.country) ? request.cf.country : "Unknown";
  return { event: body.event, sessionId: body.sessionId.toLowerCase(), path: body.path, country, device: deviceCategory(request.headers.get("User-Agent")), referrer: safeReferrer(body.referrer), source: slug(body.source), medium: slug(body.medium), campaign: slug(body.campaign) };
}
export async function handleTelemetry(request, env, _ctx) {
  if (request.method !== "POST") return privateJson({ error: "Use POST." }, 405, { Allow: "POST" });
  if (request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  try {
    requireOrigin(request);
    if (!env.ANALYTICS_DB || !env.TELEMETRY_LIMITER) throw new AnalyticsError(503, "Analytics is unavailable.");
    const limited = await env.TELEMETRY_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!limited.success) return privateJson({ error: "Too many events." }, 429, { "Retry-After": "60" });
    const event = normalizeTelemetry(await readSmallJson(request, 2048), request), hash = await sha256(event.sessionId), now = Date.now(), db = env.ANALYTICS_DB;
    const existing = await db.prepare("SELECT expires_at FROM analytics_sessions WHERE session_hash=?").bind(hash).first();
    if (existing && existing.expires_at <= now) throw new AnalyticsError(409, "Start a new analytics session.");
    if (!existing && event.event !== "page_view") throw new AnalyticsError(409, "Start with a page view.");
    await db.batch([metadata(db, now), db.prepare("INSERT INTO analytics_sessions(session_hash,first_seen,last_seen,expires_at,country,device,referrer,source,medium,campaign) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_hash) DO UPDATE SET last_seen=excluded.last_seen,expires_at=excluded.expires_at").bind(hash, now, now, now + SESSION_IDLE_MS, event.country, event.device, event.referrer, event.source, event.medium, event.campaign), db.prepare("INSERT INTO analytics_events(timestamp,session_hash,event,path) VALUES(?,?,?,?)").bind(now, hash, event.event, event.path)]);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AnalyticsError) return privateJson({ error: error.message }, error.status);
    console.error("analytics_request_failed");
    return privateJson({ error: "Analytics is unavailable." }, 503);
  }
}

export async function pruneAnalytics(env) {
  if (!env.ANALYTICS_DB) return;
  const db = env.ANALYTICS_DB, cutoff = Date.now() - RETENTION_DAYS * 86400000;
  try { await db.batch([db.prepare("DELETE FROM analytics_events WHERE timestamp < ?").bind(cutoff), db.prepare("DELETE FROM analytics_scans WHERE timestamp < ?").bind(cutoff), db.prepare("DELETE FROM analytics_sessions WHERE last_seen < ?").bind(cutoff), db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(Date.now())]); }
  catch { console.error("analytics_prune_failed"); }
}
const iso = value => value == null ? null : new Date(Number(value)).toISOString();
const number = value => Number(value || 0);
async function rows(db, sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results || []; }
const roundedCost = value => value == null ? null : Math.round(Number(value) * 100000000) / 100000000;

/** Aggregate-only read. Caller must authenticate first. Never returns session IDs. */
export async function analyticsStats(env, days, auth) {
  const db = env.ANALYTICS_DB, end = Date.now(), start = end - days * 86400000;
  const bucketFormat = days === 1 ? "%Y-%m-%dT%H:00:00Z" : "%Y-%m-%d";
  const bucketMs = days === 1 ? 3600000 : 86400000;
  const [counts, eventCounts, sessions, coverage, scans, sourceRows, countryRows, deviceRows, campaigns, sessionTrend, eventTrend, scanTrend, errors, recent] = await Promise.all([
    db.prepare("SELECT COUNT(*) scans,COALESCE(SUM(status>=200 AND status<300),0) successful,COALESCE(SUM(status>=400),0) failed,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,COALESCE(SUM(cache_creation_tokens),0) cache_creation_tokens,COALESCE(SUM(estimated_usd),0) known_cost,COALESCE(SUM(estimated_usd IS NULL),0) unpriced,COALESCE(SUM(input_tokens IS NULL AND provider_attempted=1),0) unknown_usage FROM analytics_scans WHERE timestamp>=?").bind(start).first(),
    rows(db, "SELECT event,COUNT(*) count,COUNT(DISTINCT session_hash) session_count FROM analytics_events WHERE timestamp>=? GROUP BY event", start),
    db.prepare("SELECT COUNT(*) count,COALESCE(SUM(last_seen>=?),0) active FROM analytics_sessions WHERE last_seen>=?").bind(end - ACTIVE_WINDOW_SECONDS * 1000, start).first(),
    db.prepare("SELECT (SELECT value FROM analytics_meta WHERE key='tracking_start') tracking_start,MIN(t) first_event,MAX(t) last_event FROM (SELECT timestamp t FROM analytics_events UNION ALL SELECT timestamp FROM analytics_scans)").first(),
    rows(db, "SELECT duration_ms FROM analytics_scans WHERE timestamp>=? ORDER BY duration_ms", start),
    rows(db, "SELECT referrer label,COUNT(*) count FROM analytics_sessions WHERE last_seen>=? GROUP BY referrer ORDER BY count DESC LIMIT 20", start),
    rows(db, "SELECT country label,COUNT(*) count FROM analytics_sessions WHERE last_seen>=? GROUP BY country ORDER BY count DESC LIMIT 20", start),
    rows(db, "SELECT device label,COUNT(*) count FROM analytics_sessions WHERE last_seen>=? GROUP BY device ORDER BY count DESC", start),
    rows(db, "SELECT source,medium,campaign,COUNT(*) count FROM analytics_sessions WHERE last_seen>=? AND (source!='' OR medium!='' OR campaign!='') GROUP BY source,medium,campaign ORDER BY count DESC LIMIT 20", start),
    rows(db, "SELECT strftime(?,timestamp/1000,'unixepoch') date,COUNT(DISTINCT session_hash) sessions FROM analytics_events WHERE timestamp>=? AND session_hash IS NOT NULL GROUP BY date", bucketFormat, start),
    rows(db, "SELECT strftime(?,timestamp/1000,'unixepoch') date,COUNT(*) pageviews FROM analytics_events WHERE timestamp>=? AND event='page_view' GROUP BY date", bucketFormat, start),
    rows(db, "SELECT strftime(?,timestamp/1000,'unixepoch') date,COUNT(*) scans,SUM(status>=200 AND status<300) successfulScans,SUM(status>=400) failedScans,SUM(estimated_usd) estimatedUSD,SUM(estimated_usd IS NULL) unpriced FROM analytics_scans WHERE timestamp>=? GROUP BY date", bucketFormat, start),
    rows(db, "SELECT code,status,SUM(count) count FROM (SELECT error_code code,status,COUNT(*) count FROM analytics_scans WHERE timestamp>=? AND status>=400 GROUP BY error_code,status UNION ALL SELECT error_code code,status,COUNT(*) count FROM analytics_events WHERE timestamp>=? AND status>=400 GROUP BY error_code,status) GROUP BY code,status ORDER BY count DESC LIMIT 20", start, start),
    rows(db, "SELECT * FROM (SELECT timestamp,event,path,status,NULL outcome,duration_ms durationMs,NULL model FROM analytics_events WHERE timestamp>=? AND event!='heartbeat' UNION ALL SELECT timestamp,'scan' event,'/api/scan' path,status,CASE WHEN status<400 THEN 'success' ELSE 'failed' END outcome,duration_ms durationMs,model FROM analytics_scans WHERE timestamp>=?) ORDER BY timestamp DESC LIMIT 25", start, start),
  ]);
  const eventMap = new Map(eventCounts.map(item => [item.event, item]));
  const totalSessions = number(sessions?.count), totalScans = number(counts?.scans), successes = number(counts?.successful), unpriced = number(counts?.unpriced), reviewSessions = number(eventMap.get("scan_started")?.session_count);
  const durations = scans.map(item => item.duration_ms), quantile = proportion => durations.length ? durations[Math.max(0, Math.ceil(durations.length * proportion) - 1)] : null;
  const trendMap = new Map();
  for (let time = Math.floor(start / bucketMs) * bucketMs; time <= end; time += bucketMs) { const date = days === 1 ? new Date(time).toISOString().replace('.000Z', 'Z') : new Date(time).toISOString().slice(0, 10); trendMap.set(date, { date, sessions: 0, pageviews: 0, scans: 0, successfulScans: 0, failedScans: 0, estimatedUSD: 0 }); }
  for (const item of sessionTrend) if (trendMap.has(item.date)) trendMap.get(item.date).sessions = number(item.sessions);
  for (const item of eventTrend) if (trendMap.has(item.date)) trendMap.get(item.date).pageviews = number(item.pageviews);
  for (const item of scanTrend) if (trendMap.has(item.date)) Object.assign(trendMap.get(item.date), { scans: number(item.scans), successfulScans: number(item.successfulScans), failedScans: number(item.failedScans), estimatedUSD: item.unpriced ? null : roundedCost(item.estimatedUSD || 0) });
  const billingConfigured = !!env.ANTHROPIC_ADMIN_KEY;
  return {
    range: { days, start: iso(start), end: iso(end), bucket: days === 1 ? "hour" : "day", timeZone: "UTC" }, csrfToken: auth.csrf, expiresAt: iso(auth.exp),
    coverage: { firstEventAt: iso(coverage?.first_event), lastEventAt: iso(coverage?.last_event), trackingStart: iso(coverage?.tracking_start), retentionDays: RETENTION_DAYS },
    readiness: { database: true, passwordAuth: true, telemetryLimiter: !!env.TELEMETRY_LIMITER, loginLimiter: !!env.ADMIN_LOGIN_LIMITER, telemetryEnabled: !!env.TELEMETRY_LIMITER, anthropicKey: !!env.ANTHROPIC_API_KEY, officialBilling: false },
    live: { activeSessions: number(sessions?.active), windowSeconds: ACTIVE_WINDOW_SECONDS, label: "Active browser sessions (estimate)" },
    totals: { sessions: totalSessions, pageviews: number(eventMap.get("page_view")?.count), httpRequests: number(eventMap.get("http_request")?.count), scans: totalScans, successfulScans: successes, failedScans: number(counts?.failed), scanSuccessRate: totalScans ? successes / totalScans * 100 : 0, reviewSessions, reviewRate: totalSessions ? Math.min(100, reviewSessions / totalSessions * 100) : 0 },
    scanPerformance: { averageMs: durations.length ? Math.round(durations.reduce((sum, item) => sum + item, 0) / durations.length) : null, p50Ms: quantile(0.5), p95Ms: quantile(0.95) },
    usage: { inputTokens: number(counts?.input_tokens) + number(counts?.cache_read_tokens) + number(counts?.cache_creation_tokens), uncachedInputTokens: number(counts?.input_tokens), outputTokens: number(counts?.output_tokens), cacheReadTokens: number(counts?.cache_read_tokens), cacheCreationTokens: number(counts?.cache_creation_tokens), estimatedUSD: unpriced ? null : roundedCost(counts?.known_cost || 0), knownEstimatedUSD: roundedCost(counts?.known_cost || 0), pricedScans: totalScans - unpriced, unpricedScans: unpriced, usageUnknownScans: number(counts?.unknown_usage), currency: "USD", scope: "app scans only" },
    trend: Array.from(trendMap.values()), sources: sourceRows, countries: countryRows, devices: deviceRows, campaigns,
    funnel: [["page_view", "Page views"], ["photo_added", "Photos added"], ["voice_added", "Voice added"], ["scan_started", "Reviews started"], ["photo_edited", "Photo fixes exported"], ["report_downloaded", "Reports downloaded"]].map(([event, label]) => ({ event, label, count: number(eventMap.get(event)?.count) })),
    errors, recent: recent.map(item => ({ ...item, timestamp: iso(item.timestamp) })),
    officialBilling: { configured: billingConfigured, connected: false, scope: "organization", reason: billingConfigured ? "Organization billing reporting is not connected. App scan estimates are shown separately." : "An organization Admin API connection is not configured. App scan estimates exclude Whisper, Cloudflare, and invoice adjustments." },
    privacy: { visitorUnit: "short-lived browser sessions", activeWindowSeconds: ACTIVE_WINDOW_SECONDS },
  };
}
