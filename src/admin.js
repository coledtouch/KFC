// Private password access. Cookies are signed, expire absolutely after two hours,
// and require a live D1 session record so logout also revokes copied cookies.
import { AnalyticsError, analyticsStats, privateJson, readSmallJson, requireOrigin, sha256 } from "./analytics.js";

const SESSION_COOKIE = "__Host-kfc_admin";
const CHALLENGE_COOKIE = "__Host-kfc_admin_challenge";
const SESSION_MS = 2 * 60 * 60 * 1000;
const CHALLENGE_MS = 10 * 60 * 1000;
const ITERATIONS = 100000; // Workers Web Crypto caps PBKDF2 at 100,000 iterations.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const TOKEN_VALUE = /^[A-Za-z0-9_-]{43}$/;

function encode(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 2048) throw new Error("invalid_encoding");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("invalid_encoding");
  return bytes;
}
function parsePasswordHash(encoded) {
  if (typeof encoded !== "string" || encoded.length > 200) return null;
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256" || parts[1] !== String(ITERATIONS)) return null;
  try {
    const salt = decode(parts[2]), expected = decode(parts[3]);
    return salt.byteLength === 16 && expected.byteLength === 32 ? { salt, expected } : null;
  } catch { return null; }
}
async function derive(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt }, key, 256));
}
/** Format: pbkdf2_sha256$100000$base64url(16-byte salt)$base64url(32-byte hash).
 * Provision a random password of at least 16 characters. Do not log the result. */
export async function generatePasswordHash(password) {
  if (typeof password !== "string" || password.length < 16 || encoder.encode(password).byteLength > 1024) throw new Error("Use a password of at least 16 characters and at most 1024 bytes.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$${ITERATIONS}$${encode(salt)}$${encode(await derive(password, salt))}`;
}
export async function verifyPasswordHash(password, encoded) {
  const parsed = parsePasswordHash(encoded);
  if (!parsed || typeof password !== "string" || encoder.encode(password).byteLength > 1024) return false;
  const actual = await derive(password, parsed.salt);
  let difference = 0;
  for (let index = 0; index < parsed.expected.length; index++) difference |= parsed.expected[index] ^ actual[index];
  return difference === 0;
}
function configured(env) {
  return !!parsePasswordHash(env.ADMIN_PASSWORD_HASH) && typeof env.ADMIN_SESSION_SECRET === "string" && encoder.encode(env.ADMIN_SESSION_SECRET).byteLength >= 32 && encoder.encode(env.ADMIN_SESSION_SECRET).byteLength <= 1024 && !!env.ANALYTICS_DB?.prepare && !!env.ADMIN_LOGIN_LIMITER?.limit;
}
function randomToken() { return encode(crypto.getRandomValues(new Uint8Array(32))); }
async function signingKey(env) {
  return crypto.subtle.importKey("raw", encoder.encode(env.ADMIN_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(payload, env) {
  const encoded = encode(encoder.encode(JSON.stringify(payload)));
  return encoded + "." + encode(await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(encoded)));
}
async function verify(token, kind, env) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const signature = decode(parts[1]);
    if (signature.byteLength !== 32 || !await crypto.subtle.verify("HMAC", await signingKey(env), signature, encoder.encode(parts[0]))) return null;
    const value = JSON.parse(decoder.decode(decode(parts[0]))), now = Date.now(), lifetime = kind === "session" ? SESSION_MS : CHALLENGE_MS;
    if (!value || value.v !== 1 || value.kind !== kind || !TOKEN_VALUE.test(value.id) || !TOKEN_VALUE.test(value.csrf) || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || value.iat > now + 5000 || value.exp <= now || value.exp <= value.iat || value.exp - value.iat > lifetime || value.passwordVersion !== await sha256(env.ADMIN_PASSWORD_HASH)) return null;
    return value;
  } catch { return null; }
}
function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  if (raw.length > 8192) return null;
  const matches = raw.split(";").map(part => part.trim()).filter(part => part.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}
function cookie(name, value, lifetime = 0) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(lifetime / 1000)}`;
}
async function payload(env, kind) {
  const now = Date.now();
  return { v: 1, kind, iat: now, exp: now + (kind === "session" ? SESSION_MS : CHALLENGE_MS), id: randomToken(), csrf: randomToken(), passwordVersion: await sha256(env.ADMIN_PASSWORD_HASH) };
}
async function session(request, env) {
  const value = await verify(readCookie(request, SESSION_COOKIE), "session", env);
  if (!value) return null;
  const stored = await env.ANALYTICS_DB.prepare("SELECT expires_at FROM admin_sessions WHERE session_id=?").bind(value.id).first();
  return stored && stored.expires_at === value.exp && stored.expires_at > Date.now() ? value : null;
}
function csrf(request, body, auth) {
  const header = request.headers.get("X-CSRF-Token"), supplied = body?.csrfToken;
  if (header && supplied && header !== supplied || (header || supplied) !== auth.csrf) throw new AnalyticsError(403, "Your sign-in session expired. Reload and try again.");
}
function strictKeys(body, keys) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new AnalyticsError(400, "The request isn't valid.");
}
function sessionJson(authenticated, auth = null) {
  return { configured: true, authenticated, authMode: "password", csrfToken: auth?.csrf || null, expiresAt: auth ? new Date(auth.exp).toISOString() : null };
}

export async function handleAdmin(request, env, _ctx) {
  const url = new URL(request.url), routes = { "/api/admin/session": "GET", "/api/admin/login": "POST", "/api/admin/logout": "POST", "/api/admin/stats": "GET" };
  const method = routes[url.pathname];
  if (!method) return privateJson({ error: "This endpoint doesn't exist." }, 404);
  if (request.method !== method) return privateJson({ error: `Use ${method}.` }, 405, { Allow: method });
  if (!configured(env)) {
    if (url.pathname === "/api/admin/session") return privateJson({ configured: false, authenticated: false, authMode: "password", csrfToken: null, expiresAt: null });
    return privateJson({ error: "Admin sign-in is temporarily unavailable." }, 503);
  }
  try {
    if (request.method === "POST") requireOrigin(request);
    if (url.pathname === "/api/admin/session") {
      const auth = await session(request, env);
      if (auth) return privateJson(sessionJson(true, auth));
      const challenge = await payload(env, "challenge");
      const response = privateJson(sessionJson(false, challenge));
      response.headers.append("Set-Cookie", cookie(CHALLENGE_COOKIE, await sign(challenge, env), CHALLENGE_MS));
      // Clear invalid/expired authentication cookies without treating them as access.
      if ((request.headers.get("Cookie") || "").split(";").some(part => part.trim().startsWith(SESSION_COOKIE + "="))) response.headers.append("Set-Cookie", cookie(SESSION_COOKIE, ""));
      return response;
    }
    if (url.pathname === "/api/admin/login") {
      const result = await env.ADMIN_LOGIN_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
      if (!result.success) return privateJson({ error: "Too many sign-in attempts. Try again in a minute." }, 429, { "Retry-After": "60" });
      const body = await readSmallJson(request), challenge = await verify(readCookie(request, CHALLENGE_COOKIE), "challenge", env);
      strictKeys(body, ["password", "csrfToken"]);
      if (!challenge) throw new AnalyticsError(403, "Your sign-in session expired. Reload and try again.");
      csrf(request, body, challenge);
      if (!await verifyPasswordHash(body.password, env.ADMIN_PASSWORD_HASH)) return privateJson({ error: "The password isn't correct." }, 401);
      const auth = await payload(env, "session");
      const statements = [env.ANALYTICS_DB.prepare("INSERT INTO admin_sessions(session_id,expires_at) VALUES(?,?)").bind(auth.id, auth.exp)];
      const previous = await session(request, env);
      if (previous) statements.push(env.ANALYTICS_DB.prepare("DELETE FROM admin_sessions WHERE session_id=?").bind(previous.id));
      await env.ANALYTICS_DB.batch(statements);
      const response = privateJson(sessionJson(true, auth));
      response.headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sign(auth, env), SESSION_MS));
      response.headers.append("Set-Cookie", cookie(CHALLENGE_COOKIE, ""));
      return response;
    }
    const auth = await session(request, env);
    if (!auth) return privateJson({ error: "Sign in to continue." }, 401);
    if (url.pathname === "/api/admin/logout") {
      // Workers can expose an empty stream for a header-only POST. Select JSON
      // validation by Content-Type so that request still reaches the CSRF check.
      const body = request.headers.has("Content-Type") ? await readSmallJson(request, 2048) : {};
      strictKeys(body, ["csrfToken"]);
      csrf(request, body, auth);
      await env.ANALYTICS_DB.prepare("DELETE FROM admin_sessions WHERE session_id=?").bind(auth.id).run();
      const response = privateJson(sessionJson(false));
      response.headers.append("Set-Cookie", cookie(SESSION_COOKIE, ""));
      response.headers.append("Set-Cookie", cookie(CHALLENGE_COOKIE, ""));
      return response;
    }
    const days = url.searchParams.get("days") || "7";
    if (!["1", "7", "30"].includes(days) || [...url.searchParams.keys()].some(key => key !== "days") || url.searchParams.getAll("days").length > 1) throw new AnalyticsError(400, "Choose a 1, 7, or 30 day range.");
    return privateJson(await analyticsStats(env, Number(days), auth));
  } catch (error) {
    if (error instanceof AnalyticsError) return privateJson({ error: error.message }, error.status);
    // Only a constant error marker. Never log credentials, cookies, or D1 results.
    console.error("admin_request_failed");
    return privateJson({ error: "The dashboard is temporarily unavailable. Try again in a minute." }, 503);
  }
}
