import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAdmin, generatePasswordHash, verifyPasswordHash } from "../src/admin.js";
import worker from "../src/index.js";
import { analyticsStats, estimateCost, handleTelemetry, normalizeUsage, pruneAnalytics, readSmallJson, recordHttp, recordScan, sha256 } from "../src/analytics.js";

const SITE = "https://keepfixcut.com";
const PASSWORD = "test-only-password-with-strong-length";
const HASH = await generatePasswordHash(PASSWORD);
const SECRET = "test-only-session-secret-with-32-characters-minimum";
const MIGRATION = readFileSync(new URL("../migrations/0001_analytics.sql", import.meta.url), "utf8");
const SESSION_ID = "73d9b6d0-fd5d-4b11-8b52-417ffcd30b24";
const RATES = { ANALYTICS_PRICE_MODEL: "claude-sonnet-5-5", ANALYTICS_INPUT_USD_PER_MTOK: "2", ANALYTICS_OUTPUT_USD_PER_MTOK: "10", ANALYTICS_CACHE_READ_USD_PER_MTOK: "0.1", ANALYTICS_CACHE_WRITE_5M_USD_PER_MTOK: "2.5", ANALYTICS_CACHE_WRITE_1H_USD_PER_MTOK: "4" };

// Executes the real D1 SQL and migration against SQLite, rather than matching SQL
// strings to canned fixtures. Each test receives an independent in-memory DB.
class D1 {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); this.sqlite.exec(MIGRATION); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try { const values = statements.map(statement => ({ success: true, results: [], meta: this.sqlite.prepare(statement.sql).run(...statement.values) })); this.sqlite.exec("COMMIT"); return values; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.values) || null; }
  async all() { return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() { const meta = this.db.sqlite.prepare(this.sql).run(...this.values); return { success: true, results: [], meta }; }
}
function env(overrides = {}) {
  return { ANALYTICS_DB: new D1(), ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: SECRET, ADMIN_LOGIN_LIMITER: { limit: async () => ({ success: true }) }, TELEMETRY_LIMITER: { limit: async () => ({ success: true }) }, ANTHROPIC_API_KEY: "test-only-unused-placeholder", ...RATES, ...overrides };
}
function request(path, { method = "GET", body, cookie, origin = SITE, headers = {} } = {}) {
  const allHeaders = { ...headers };
  if (origin !== null && method === "POST") allHeaders.Origin = origin;
  if (cookie) allHeaders.Cookie = cookie;
  if (body !== undefined) allHeaders["Content-Type"] = "application/json";
  return new Request(SITE + path, { method, headers: allHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
}
function cookieFrom(response, name) {
  const value = response.headers.getSetCookie().find(value => value.startsWith(name + "="));
  assert.ok(value, "expected cookie to be set");
  return value.split(";")[0];
}
async function challenge(runtime) {
  const response = await handleAdmin(request("/api/admin/session"), runtime);
  assert.equal(response.status, 200);
  return { response, data: await response.json(), cookie: cookieFrom(response, "__Host-kfc_admin_challenge") };
}
async function login(runtime) {
  const start = await challenge(runtime);
  const response = await handleAdmin(request("/api/admin/login", { method: "POST", body: { password: PASSWORD, csrfToken: start.data.csrfToken }, cookie: start.cookie, headers: { "X-CSRF-Token": start.data.csrfToken } }), runtime);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.authenticated, true);
  return { response, data, cookie: cookieFrom(response, "__Host-kfc_admin") };
}
async function telemetry(runtime, changes = {}, options = {}) {
  const req = request("/api/telemetry", { method: "POST", body: { event: "page_view", sessionId: SESSION_ID, path: "/", referrer: "www.reddit.com", source: "reddit", medium: "social", campaign: "launch", ...changes }, headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS) Mobile private-ua-marker", "CF-Connecting-IP": "192.0.2.20", ...options.headers }, ...options });
  Object.defineProperty(req, "cf", { value: { country: "US" } });
  return handleTelemetry(req, runtime);
}
function context() { const tasks = []; return { tasks, waitUntil: promise => tasks.push(promise), drain: () => Promise.all(tasks) }; }
const usage = () => ({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 400, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 } });

test("password hashes are salted, bounded, and verified with the Workers-compatible PBKDF2 scheme", async () => {
  assert.match(HASH, /^pbkdf2_sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyPasswordHash(PASSWORD, HASH), true);
  assert.equal(await verifyPasswordHash("wrong password", HASH), false);
  assert.equal(await verifyPasswordHash(PASSWORD, HASH.replace("100000", "1")), false);
  assert.equal(await verifyPasswordHash(PASSWORD, "pbkdf2_sha256$100000$bad$bad"), false);
  assert.equal(await verifyPasswordHash("x".repeat(1025), HASH), false);
  assert.notEqual(await generatePasswordHash(PASSWORD), HASH);
  await assert.rejects(generatePasswordHash("short"));
  await assert.rejects(generatePasswordHash("x".repeat(1025)));
});

test("admin prerequisites fail closed and no response exposes credentials", async () => {
  for (const missing of [{ ADMIN_PASSWORD_HASH: "bad" }, { ADMIN_SESSION_SECRET: "short" }, { ANALYTICS_DB: null }, { ADMIN_LOGIN_LIMITER: null }]) {
    const runtime = env(missing);
    const response = await handleAdmin(request("/api/admin/session"), runtime);
    const data = await response.json();
    assert.equal(data.configured, false); assert.equal(data.authenticated, false); assert.equal(data.csrfToken, null);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await handleAdmin(request("/api/admin/stats"), runtime)).status, 503);
    assert.equal((await handleAdmin(request("/api/admin/login", { method: "POST", body: { password: PASSWORD } }), runtime)).status, 503);
    assert.equal(JSON.stringify(data).includes(PASSWORD), false);
    assert.equal(JSON.stringify(data).includes(HASH), false);
    assert.equal(JSON.stringify(data).includes(SECRET), false);
  }
});

test("anonymous stats are rejected and challenges require secure private cookies", async () => {
  const runtime = env(), start = await challenge(runtime);
  assert.equal(start.data.authMode, "password"); assert.equal(start.data.authenticated, false);
  assert.ok(start.data.csrfToken); assert.ok(start.data.expiresAt);
  const cookies = start.response.headers.getSetCookie().join("\n");
  assert.match(cookies, /Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600/);
  assert.equal(start.response.headers.getSetCookie().some(value => value.startsWith("__Host-kfc_admin=")), false, "GET without a session cookie cannot clear a browser session");
  assert.equal(start.response.headers.get("Cache-Control"), "no-store");
  const denied = await handleAdmin(request("/api/admin/stats?days=7", { cookie: start.cookie }), runtime);
  assert.equal(denied.status, 401); assert.equal(denied.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Object.keys(await denied.json()), ["error"]);
});

test("login requires exact Origin and the signed challenge CSRF token", async () => {
  const runtime = env(), start = await challenge(runtime);
  const body = { password: PASSWORD, csrfToken: start.data.csrfToken };
  for (const origin of [null, "null", "https://attacker.example", "https://keepfixcut.com.attacker.example"]) {
    assert.equal((await handleAdmin(request("/api/admin/login", { method: "POST", body, cookie: start.cookie, origin }), runtime)).status, 403);
  }
  for (const options of [{ body: { password: PASSWORD }, cookie: start.cookie }, { body, cookie: "__Host-kfc_admin_challenge=forged" }, { body: { ...body, csrfToken: "wrong" }, cookie: start.cookie }, { body, cookie: start.cookie, headers: { "X-CSRF-Token": "wrong" } }]) {
    assert.equal((await handleAdmin(request("/api/admin/login", { method: "POST", ...options }), runtime)).status, 403);
  }
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM admin_sessions").first()).count, 0);
});

test("wrong-password attempts use the independent login limiter and remain unauthenticated", async () => {
  let calls = 0, lastKey;
  const runtime = env({ ADMIN_LOGIN_LIMITER: { limit: async ({ key }) => { lastKey = key; return { success: ++calls <= 5 }; } } }), start = await challenge(runtime);
  for (let index = 0; index < 6; index++) {
    const response = await handleAdmin(request("/api/admin/login", { method: "POST", body: { password: "wrong", csrfToken: start.data.csrfToken }, cookie: start.cookie, headers: { "CF-Connecting-IP": "192.0.2.1" } }), runtime);
    assert.equal(response.status, index < 5 ? 401 : 429);
    if (index === 5) assert.equal(response.headers.get("Retry-After"), "60");
  }
  assert.equal(lastKey, "192.0.2.1");
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM admin_sessions").first()).count, 0);
});

test("signed sessions authenticate stats and expiry is absolute after two hours", async () => {
  const runtime = env(), auth = await login(runtime);
  assert.match(auth.response.headers.getSetCookie()[0], /Secure; HttpOnly; SameSite=Strict; Max-Age=7200/);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM admin_sessions").first()).count, 1);
  const liveSession = await handleAdmin(request("/api/admin/session", { cookie: auth.cookie }), runtime);
  assert.equal((await liveSession.json()).authenticated, true);
  const originalNow = Date.now;
  try {
    Date.now = () => new Date(auth.data.expiresAt).getTime() + 1;
    assert.equal((await handleAdmin(request("/api/admin/stats", { cookie: auth.cookie }), runtime)).status, 401);
  } finally { Date.now = originalNow; }
});

test("forged, altered, duplicate, and rotated-secret cookies cannot access stats", async () => {
  const runtime = env(), auth = await login(runtime);
  const token = auth.cookie.split("=")[1], [body, signature] = token.split(".");
  const decoded = JSON.parse(Buffer.from(body, "base64url").toString()); decoded.exp += 1000;
  const altered = Buffer.from(JSON.stringify(decoded)).toString("base64url") + "." + signature;
  for (const cookie of ["__Host-kfc_admin=forged", `__Host-kfc_admin=${altered}`, `__Host-kfc_admin=${body}.${"a".repeat(43)}`, `${auth.cookie}; ${auth.cookie}`]) {
    assert.equal((await handleAdmin(request("/api/admin/stats", { cookie }), runtime)).status, 401);
  }
  assert.equal((await handleAdmin(request("/api/admin/stats", { cookie: auth.cookie }), { ...runtime, ADMIN_SESSION_SECRET: SECRET + "rotated" })).status, 401);
  assert.equal((await handleAdmin(request("/api/admin/stats", { cookie: auth.cookie }), { ...runtime, ADMIN_PASSWORD_HASH: await generatePasswordHash(PASSWORD) })).status, 401);
});

test("logout rejects CSRF attacks and revokes replayed cookies in D1", async () => {
  const runtime = env(), auth = await login(runtime);
  for (const options of [{}, { headers: { "X-CSRF-Token": "wrong" } }, { headers: { "X-CSRF-Token": auth.data.csrfToken }, origin: "https://attacker.example" }]) {
    assert.equal((await handleAdmin(request("/api/admin/logout", { method: "POST", cookie: auth.cookie, ...options }), runtime)).status, 403);
  }
  const response = await handleAdmin(request("/api/admin/logout", { method: "POST", cookie: auth.cookie, body: { csrfToken: auth.data.csrfToken } }), runtime);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, false);
  assert.match(response.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM admin_sessions").first()).count, 0);
  assert.equal((await handleAdmin(request("/api/admin/stats", { cookie: auth.cookie }), runtime)).status, 401);
});

test("header-only logout matches the existing dashboard request", async () => {
  const runtime = env(), auth = await login(runtime);
  assert.equal((await handleAdmin(request("/api/admin/logout", { method: "POST", cookie: auth.cookie, headers: { "X-CSRF-Token": auth.data.csrfToken } }), runtime)).status, 200);
});

test("header-only logout accepts the Workers empty stream while rejecting missing/wrong CSRF and cross-site Origin", async () => {
  const runtime = env(), auth = await login(runtime);
  const emptyRequest = (token, origin = SITE) => {
    const headers = { Origin: origin, Cookie: auth.cookie };
    if (token !== undefined) headers["X-CSRF-Token"] = token;
    const req = new Request(SITE + "/api/admin/logout", { method: "POST", headers, body: "" });
    // A string body gives Node an automatic text/plain header. Cloudflare's
    // actual dashboard request has no Content-Type and a non-null empty stream.
    req.headers.delete("Content-Type");
    assert.notEqual(req.body, null);
    return req;
  };
  for (const req of [emptyRequest(undefined), emptyRequest("wrong"), emptyRequest(auth.data.csrfToken, "https://attacker.example")]) {
    const denied = await handleAdmin(req, runtime);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("Cache-Control"), "no-store");
    assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM admin_sessions").first()).count, 1);
  }
  const response = await handleAdmin(emptyRequest(auth.data.csrfToken), runtime);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, false);
  assert.match(response.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM admin_sessions").first()).count, 0);
  assert.equal((await handleAdmin(request("/api/admin/stats", { cookie: auth.cookie }), runtime)).status, 401);
});

test("expired login challenges fail and unknown routes/methods/ranges do not broaden access", async () => {
  const runtime = env(), start = await challenge(runtime), originalNow = Date.now;
  try {
    Date.now = () => new Date(start.data.expiresAt).getTime() + 1;
    assert.equal((await handleAdmin(request("/api/admin/login", { method: "POST", body: { password: PASSWORD, csrfToken: start.data.csrfToken }, cookie: start.cookie }), runtime)).status, 403);
  } finally { Date.now = originalNow; }
  assert.equal((await handleAdmin(request("/api/admin/missing"), runtime)).status, 404);
  const method = await handleAdmin(request("/api/admin/login"), runtime);
  assert.equal(method.status, 405); assert.equal(method.headers.get("Allow"), "POST");
  const auth = await login(runtime);
  for (const query of ["days=0", "days=31", "days=7&days=1", "days=7&password=secret"]) assert.equal((await handleAdmin(request("/api/admin/stats?" + query, { cookie: auth.cookie }), runtime)).status, 400);
});

test("database failures fail closed without leaking internal error details", async () => {
  const runtime = env(), auth = await login(runtime), logs = [], originalError = console.error;
  try {
    console.error = (...values) => logs.push(values);
    runtime.ANALYTICS_DB = { prepare: () => { throw new Error("private-db-content-and-password"); } };
    const response = await handleAdmin(request("/api/admin/stats", { cookie: auth.cookie }), runtime);
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes("private-db"), false);
    assert.deepEqual(logs, [["admin_request_failed"]]);
  } finally { console.error = originalError; }
});

test("JSON readers reject malformed and streaming oversized bodies", async () => {
  await assert.rejects(readSmallJson(new Request(SITE, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{invalid" })), error => error.status === 400);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(5000))); controller.close(); } });
  await assert.rejects(readSmallJson(new Request(SITE, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" })), error => error.status === 413);
});

test("telemetry retains only hashed sessions and coarse allowlisted attribution", async () => {
  const runtime = env(); assert.equal((await telemetry(runtime)).status, 204);
  const row = await runtime.ANALYTICS_DB.prepare("SELECT * FROM analytics_sessions").first();
  assert.equal(row.session_hash, await sha256(SESSION_ID)); assert.notEqual(row.session_hash, SESSION_ID);
  assert.equal(row.country, "US"); assert.equal(row.device, "Mobile"); assert.equal(row.referrer, "www.reddit.com"); assert.equal(row.campaign, "launch");
  const stored = JSON.stringify(row);
  assert.equal(stored.includes("192.0.2.20"), false); assert.equal(stored.includes("private-ua-marker"), false); assert.equal(stored.includes(SESSION_ID), false);
  assert.equal((await telemetry(runtime, { event: "scan_started" })).status, 204);
  const session = await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM analytics_sessions").first(); assert.equal(session.count, 1);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM analytics_events").first()).count, 2);
});

test("telemetry rejects raw URLs, identifiers, unknown events, paths, and content fields", async () => {
  const runtime = env();
  for (const fields of [{ referrer: "https://reddit.com/private?secret=value" }, { referrer: "192.0.2.1" }, { referrer: "localhost" }, { source: "email@example.com" }, { campaign: "a".repeat(65) }, { event: "private_prompt" }, { sessionId: "personal-id" }, { path: "/admin" }, { transcript: "private words" }, { images: [] }]) assert.equal((await telemetry(runtime, fields)).status, 400);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM analytics_events").first()).count, 0);
  assert.equal((await telemetry(runtime, {}, { origin: "https://attacker.example" })).status, 403);
  assert.equal((await telemetry(env({ TELEMETRY_LIMITER: null }))).status, 503);
  assert.equal((await telemetry(env({ TELEMETRY_LIMITER: { limit: async () => ({ success: false }) } }))).status, 429);
});

test("privacy opt-outs and inactive session expiry prevent telemetry writes", async () => {
  const runtime = env();
  for (const headers of [{ DNT: "1" }, { "Sec-GPC": "1" }]) assert.equal((await telemetry(runtime, {}, { headers })).status, 204);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM analytics_events").first()).count, 0);
  assert.equal((await telemetry(runtime, { event: "heartbeat" })).status, 409);
  assert.equal((await telemetry(runtime)).status, 204);
  await runtime.ANALYTICS_DB.prepare("UPDATE analytics_sessions SET expires_at=?").bind(Date.now() - 1).run();
  assert.equal((await telemetry(runtime, { event: "heartbeat" })).status, 409);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT COUNT(*) count FROM analytics_events").first()).count, 1);
});

test("usage counts cache and thinking correctly without double-counting creation tokens", () => {
  const normalized = normalizeUsage({ ...usage(), thinking_tokens: 999999, secret: "private" });
  assert.deepEqual(normalized, { input: 1000, output: 200, read: 400, creation: 300, write5m: 200, write1h: 100 });
  assert.ok(Math.abs(estimateCost(RATES, "claude-sonnet-5-5", normalized, true) - 0.00494) < 1e-10);
  assert.equal(normalizeUsage({ input_tokens: -1, output_tokens: 10 }), null);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: NaN }), null);
  assert.equal(estimateCost(RATES, "unknown-model", normalized, true), null);
  assert.equal(estimateCost(RATES, "claude-sonnet-5-5", null, true), null);
  assert.equal(estimateCost(RATES, "claude-sonnet-5-5", null, false), 0);
  assert.equal(estimateCost({}, "claude-sonnet-5-5", normalized, true), null);
  assert.equal(estimateCost(RATES, "claude-sonnet-5-5", normalizeUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 100 }), true), null);
});

test("scan analytics writes are deferred and discard content fields, raw errors, and unknown prices", async () => {
  const runtime = env(), ctx = context();
  recordScan(runtime, ctx, { status: 200, providerStatus: 200, durationMs: 3000, model: "claude-sonnet-5-5", mode: "photo", app: "Hinge", imageCount: 2, voiceSeconds: 0, usage: usage(), providerAttempted: true, prompts: "private text", images: ["private photo"], transcript: "private speech" });
  recordScan(runtime, ctx, { status: 504, durationMs: 85000, model: "claude-sonnet-5-5", providerAttempted: true, usage: null, errorCode: "provider_timeout" });
  recordScan(runtime, ctx, { status: 400, durationMs: 1, providerAttempted: false, errorCode: "user-private-error-message" });
  assert.equal(ctx.tasks.length, 3);
  await ctx.drain();
  const records = (await runtime.ANALYTICS_DB.prepare("SELECT * FROM analytics_scans ORDER BY id").all()).results;
  assert.equal(records.length, 3); assert.ok(records[0].estimated_usd > 0); assert.equal(records[1].estimated_usd, null); assert.equal(records[2].estimated_usd, 0);
  assert.equal(records[2].error_code, "http_400");
  assert.equal(JSON.stringify(records).includes("private"), false);
  const logs = [], original = console.error;
  try {
    console.error = (...values) => logs.push(values);
    recordScan({ ...runtime, ANALYTICS_DB: { batch: async () => { throw new Error("private failure"); }, prepare: runtime.ANALYTICS_DB.prepare.bind(runtime.ANALYTICS_DB) } }, ctx, { status: 500 });
    await ctx.drain();
    assert.deepEqual(logs, [["analytics_write_failed"]]);
  } finally { console.error = original; }
});

test("authenticated stats aggregate referral, funnel, token coverage, errors and private recent events", async () => {
  const runtime = env(), ctx = context();
  await telemetry(runtime); await telemetry(runtime, { event: "scan_started" });
  recordHttp(runtime, ctx, { path: "/", status: 200 });
  recordHttp(runtime, ctx, { path: "/private?secret=data", status: 200 });
  recordScan(runtime, ctx, { status: 200, durationMs: 1000, model: "claude-sonnet-5-5", usage: usage(), providerAttempted: true });
  recordScan(runtime, ctx, { status: 502, durationMs: 2000, model: "claude-sonnet-5-5", providerAttempted: true, errorCode: "provider_error" });
  await ctx.drain();
  const auth = await login(runtime);
  for (const days of [1, 7, 30]) {
    const response = await handleAdmin(request(`/api/admin/stats?days=${days}`, { cookie: auth.cookie }), runtime);
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
    const stats = await response.json();
    assert.equal(stats.range.days, days); assert.equal(stats.totals.sessions, 1); assert.equal(stats.totals.pageviews, 1); assert.equal(stats.totals.httpRequests, 1);
    assert.equal(stats.totals.reviewSessions, 1); assert.equal(stats.totals.reviewRate, 100); assert.equal(stats.totals.scanSuccessRate, 50);
    assert.equal(stats.totals.scans, 2); assert.equal(stats.totals.failedScans, 1); assert.equal(stats.live.activeSessions, 1);
    assert.equal(stats.usage.inputTokens, 1700); assert.equal(stats.usage.outputTokens, 200); assert.equal(stats.usage.estimatedUSD, null); assert.equal(stats.usage.unpricedScans, 1); assert.equal(stats.usage.usageUnknownScans, 1);
    assert.equal(stats.usage.knownEstimatedUSD, 0.00494); assert.equal(stats.scanPerformance.p50Ms, 1000); assert.equal(stats.scanPerformance.p95Ms, 2000);
    assert.equal(stats.sources[0].label, "www.reddit.com"); assert.equal(stats.campaigns[0].campaign, "launch"); assert.equal(stats.devices[0].label, "Mobile"); assert.equal(stats.countries[0].label, "US");
    assert.equal(stats.errors[0].code, "provider_error"); assert.equal(stats.officialBilling.connected, false); assert.equal(stats.officialBilling.scope, "organization");
    assert.equal(stats.readiness.telemetryEnabled, true); assert.match(stats.coverage.firstEventAt, /Z$/); assert.equal(stats.csrfToken, auth.data.csrfToken);
    const serialized = JSON.stringify(stats);
    for (const privateValue of [SESSION_ID, await sha256(SESSION_ID), "192.0.2.20", "private-ua-marker", PASSWORD, SECRET, HASH]) assert.equal(serialized.includes(privateValue), false);
    assert.ok(stats.recent.every(item => !Object.hasOwn(item, "session_hash")));
  }
});

test("live estimates exclude stale sessions and empty databases retain truthful coverage", async () => {
  const runtime = env();
  const empty = await analyticsStats(runtime, 7, { csrf: "fixture", exp: Date.now() + 1000 });
  assert.equal(empty.coverage.trackingStart, null); assert.equal(empty.coverage.firstEventAt, null); assert.equal(empty.live.activeSessions, 0); assert.equal(empty.totals.reviewRate, 0); assert.equal(empty.usage.estimatedUSD, 0);
  await telemetry(runtime);
  await runtime.ANALYTICS_DB.prepare("UPDATE analytics_sessions SET last_seen=?").bind(Date.now() - 91000).run();
  const stats = await analyticsStats(runtime, 7, { csrf: "fixture", exp: Date.now() + 1000 });
  assert.equal(stats.live.activeSessions, 0); assert.equal(stats.totals.sessions, 1);
});

test("retention removes expired operational rows and sessions while preserving tracking start", async () => {
  const runtime = env(), ctx = context();
  await telemetry(runtime); recordScan(runtime, ctx, { status: 400, providerAttempted: false }); await ctx.drain();
  const tracking = (await runtime.ANALYTICS_DB.prepare("SELECT value FROM analytics_meta WHERE key='tracking_start'").first()).value;
  const old = Date.now() - 31 * 86400000;
  await runtime.ANALYTICS_DB.prepare("UPDATE analytics_events SET timestamp=?").bind(old).run();
  await runtime.ANALYTICS_DB.prepare("UPDATE analytics_scans SET timestamp=?").bind(old).run();
  await runtime.ANALYTICS_DB.prepare("UPDATE analytics_sessions SET last_seen=?").bind(old).run();
  await runtime.ANALYTICS_DB.prepare("INSERT INTO admin_sessions(session_id,expires_at) VALUES('expired',?)").bind(old).run();
  await pruneAnalytics(runtime);
  for (const table of ["analytics_events", "analytics_scans", "analytics_sessions", "admin_sessions"]) assert.equal((await runtime.ANALYTICS_DB.prepare(`SELECT COUNT(*) count FROM ${table}`).first()).count, 0);
  assert.equal((await runtime.ANALYTICS_DB.prepare("SELECT value FROM analytics_meta WHERE key='tracking_start'").first()).value, tracking);
});

test("rolling 24-hour trends use UTC hour buckets and 7/30-day trends use daily buckets without losing page views", async () => {
  const runtime = env(), now = Date.parse("2026-10-11T15:37:00Z"), originalNow = Date.now;
  try {
    Date.now = () => now;
    for (const timestamp of [now - 86400000 - 1, now - 86400000 + 1, now - 12 * 3600000, now - 1]) {
      await runtime.ANALYTICS_DB.prepare("INSERT INTO analytics_events(timestamp,session_hash,event,path) VALUES(?,?,'page_view','/')").bind(timestamp, "synthetic-session-hash").run();
    }
    for (const days of [1, 7, 30]) {
      const stats = await analyticsStats(runtime, days, { csrf: "fixture", exp: now + 1000 });
      assert.equal(stats.range.timeZone, "UTC");
      assert.equal(stats.range.bucket, days === 1 ? "hour" : "day");
      assert.equal(Date.parse(stats.range.end) - Date.parse(stats.range.start), days * 86400000);
      assert.equal(stats.totals.pageviews, days === 1 ? 3 : 4);
      assert.equal(stats.trend.reduce((sum, item) => sum + item.pageviews, 0), stats.totals.pageviews);
      assert.equal(new Set(stats.trend.map(item => item.date)).size, stats.trend.length);
      if (days === 1) {
        assert.equal(stats.trend.length, 25, "rolling 24 hours crosses two partial endpoint hours");
        assert.ok(stats.trend.every(item => /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(item.date)));
        assert.equal(stats.trend[0].date, "2026-10-10T15:00:00Z");
        assert.equal(stats.trend.at(-1).date, "2026-10-11T15:00:00Z");
        assert.equal(stats.trend[0].pageviews, 1, "excluded start-boundary event must not inflate the first partial hour");
        for (let index = 1; index < stats.trend.length; index++) assert.equal(Date.parse(stats.trend[index].date) - Date.parse(stats.trend[index - 1].date), 3600000);
      } else {
        assert.ok(stats.trend.every(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date)));
        for (let index = 1; index < stats.trend.length; index++) assert.equal(Date.parse(stats.trend[index].date) - Date.parse(stats.trend[index - 1].date), 86400000);
      }
    }
  } finally { Date.now = originalNow; }
});

test("Worker preserves paid usage and provider status for refusal, truncation, and invalid report failures", async t => {
  const runtime = env({ ALLOWED_ORIGINS: SITE, SCAN_LIMITER: { limit: async () => ({ success: true }) } }), ctx = context();
  let fixture;
  const upstream = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    return Response.json({ model: "claude-sonnet-5-5", usage: usage(), ...fixture });
  });
  for (const failure of [
    { status: 422, payload: { stop_reason: "refusal", content: [{ type: "text", text: "private provider refusal" }] } },
    { status: 502, payload: { stop_reason: "max_tokens", content: [{ type: "text", text: "{truncated private provider output" }] } },
    { status: 502, payload: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ overall: 72, summary: "private invalid report" }) }] } },
  ]) {
    fixture = failure.payload;
    const response = await worker.fetch(request("/api/scan", { method: "POST", body: { prompts: "Synthetic test profile: I enjoy hiking and coffee." } }), runtime, ctx);
    assert.equal(response.status, failure.status);
  }
  assert.equal(upstream.mock.callCount(), 3); assert.equal(ctx.tasks.length, 3);
  await ctx.drain();
  const scans = (await runtime.ANALYTICS_DB.prepare("SELECT * FROM analytics_scans ORDER BY id").all()).results;
  assert.deepEqual(scans.map(item => item.status), [422, 502, 502]);
  assert.ok(scans.every(item => item.provider_status === 200 && item.provider_attempted === 1 && item.model === "claude-sonnet-5-5"));
  for (const scan of scans) {
    assert.equal(scan.input_tokens, 1000); assert.equal(scan.output_tokens, 200); assert.equal(scan.cache_read_tokens, 400); assert.equal(scan.cache_creation_tokens, 300);
    assert.ok(Math.abs(scan.estimated_usd - 0.00494) < 1e-10);
  }
  assert.equal(JSON.stringify(scans).includes("private"), false);
  const stats = await analyticsStats(runtime, 1, { csrf: "fixture", exp: Date.now() + 1000 });
  assert.equal(stats.totals.successfulScans, 0); assert.equal(stats.totals.failedScans, 3); assert.equal(stats.usage.pricedScans, 3); assert.equal(stats.usage.unpricedScans, 0);
  assert.equal(stats.usage.estimatedUSD, 0.01482);
});
