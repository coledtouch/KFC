import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const site = "https://keepfixcut.com";
const baseReport = () => ({
  overall: 72, headline: "A strong start", summary: "Make the details easier to answer.",
  strengths: ["Specific interests"], metrics: [{ name: "Prompt hooks", score: 7.2, note: "Add a question." }],
  photos: [], order: [], prompts: [{ prompt: "My weekends", verdict: "fix", current: "I like hiking.", rewrite: "Sunrise trails, then pancakes. What's your pick?", why: "Gives someone a way in." }],
  fixes: [{ impact: "high", action: "Give your hiking prompt one specific detail." }],
});
function env(overrides = {}) {
  return { ANTHROPIC_API_KEY: "test-only-placeholder", ALLOWED_ORIGINS: site, SCAN_LIMITER: { limit: async () => ({ success: true }) }, ASSETS: { fetch: async () => new Response("asset", { headers: { "content-type": "text/html" } }) }, ...overrides };
}
function scan(body = { prompts: "I like hiking." }, headers = {}, url = `${site}/api/scan`) {
  return new Request(url, { method: "POST", headers: { Origin: new URL(url).origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function reply(report = baseReport(), overrides = {}) {
  return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(report) }], ...overrides });
}
function wav(seconds = 1) {
  const bytes = Buffer.alloc(44 + seconds * 32000);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
function voice(bytes = wav(), metrics = {}) {
  return { wav: bytes.toString("base64"), prompt: "A perfect weekend", metrics: { duration: 1, silenceRatio: .2, leadSilence: .1, longestPause: .1, ...metrics } };
}
function image() { return { type: "image/jpeg", data: Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]).toString("base64") }; }

test("configuration reports readiness without exposing secrets and supports HEAD", async () => {
  const configuration = await worker.fetch(new Request(`${site}/api/config`), env({ AI: {} }));
  assert.deepEqual(await configuration.json(), { turnstileSiteKey: null, turnstileRequired: false, scanningAvailable: true, voiceAvailable: true });
  const missing = await worker.fetch(new Request(`${site}/api/config`), env({ ANTHROPIC_API_KEY: "" }));
  assert.equal((await missing.json()).scanningAvailable, false);
  const partialBot = await worker.fetch(new Request(`${site}/api/config`), env({ TURNSTILE_SITE_KEY: "public-key" }));
  assert.deepEqual(await partialBot.json(), { turnstileSiteKey: null, turnstileRequired: true, scanningAvailable: false, voiceAvailable: false });
  const head = await worker.fetch(new Request(`${site}/api/config`, { method: "HEAD" }), env());
  assert.equal(await head.text(), "");
  assert.equal(configuration.headers.get("Cache-Control"), "no-store");
});

test("the limiter is required on public hosts", async () => {
  const res = await worker.fetch(scan(), env({ SCAN_LIMITER: undefined }));
  assert.equal(res.status, 503);
});

test("www redirects preserve method, path, query and include headers", async () => {
  const res = await worker.fetch(new Request("https://www.keepfixcut.com/api/scan?source=home", { method: "POST" }), env());
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("Location"), `${site}/api/scan?source=home`);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  for (const url of ["http://keepfixcut.com/upload?source=home", "http://www.keepfixcut.com/upload?source=home"]) {
    const https = await worker.fetch(new Request(url), env());
    assert.equal(https.status, 308); assert.equal(https.headers.get("Location"), `${site}/upload?source=home`);
  }
});

test("API routes return JSON 404s and method responses include Allow", async () => {
  const missing = await worker.fetch(new Request(`${site}/api/unknown`), env());
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("Content-Type"), /application\/json/);
  const wrongScan = await worker.fetch(new Request(`${site}/api/scan`), env());
  assert.equal(wrongScan.status, 405); assert.equal(wrongScan.headers.get("Allow"), "POST");
  const wrongConfig = await worker.fetch(new Request(`${site}/api/config`, { method: "POST" }), env());
  assert.equal(wrongConfig.status, 405); assert.equal(wrongConfig.headers.get("Allow"), "GET, HEAD");
});

test("static files keep their status and get voice-compatible security headers", async () => {
  const res = await worker.fetch(new Request(`${site}/missing.jpg`), env({ ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } }));
  assert.equal(res.status, 404);
  assert.match(res.headers.get("Permissions-Policy"), /microphone=\(self\)/);
  assert.match(res.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});

test("cross-site, missing-origin, and non-JSON requests never reach the provider", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  assert.equal((await worker.fetch(scan(undefined, { Origin: "https://elsewhere.example" }), env())).status, 403);
  const noOrigin = scan(); noOrigin.headers.delete("Origin");
  assert.equal((await worker.fetch(noOrigin, env())).status, 403);
  assert.equal((await worker.fetch(scan(undefined, { "Content-Type": "text/plain" }), env())).status, 415);
  assert.equal(fetch.mock.callCount(), 0);
});

test("empty allowed-origin configuration stays same-origin", async t => {
  t.mock.method(globalThis, "fetch", async () => reply());
  assert.equal((await worker.fetch(scan(), env({ ALLOWED_ORIGINS: "" }))).status, 200);
  assert.equal((await worker.fetch(scan(undefined, { Origin: "https://elsewhere.example" }), env({ ALLOWED_ORIGINS: "" }))).status, 403);
});

test("local Wrangler requests work with the production origins configured", async t => {
  t.mock.method(globalThis, "fetch", async () => reply());
  const res = await worker.fetch(scan(undefined, {}, "http://localhost:8787/api/scan"), env({ SCAN_LIMITER: undefined }));
  assert.equal(res.status, 200);
});

test("rate-limited requests expose a useful retry delay", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  const res = await worker.fetch(scan(), env({ SCAN_LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(res.status, 429); assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(fetch.mock.callCount(), 0);
});

test("invalid JSON roots and invalid fields are rejected before spending tokens", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  for (const body of [null, [], 1, { prompts: {} }, { prompts: "x", images: {} }, { prompts: "x", age: [25] }, { prompts: "x", age: "17" }, { prompts: "x", age: "100" }, { prompts: "x", app: "unknown" }, { prompts: "x", goal: [] }, { images: Array(7).fill(image()) }, {}]) {
    assert.equal((await worker.fetch(scan(body), env())).status, 400, JSON.stringify(body));
  }
  assert.equal((await worker.fetch(scan({ prompts: "x".repeat(6001) }), env())).status, 413);
  assert.equal(fetch.mock.callCount(), 0);
});

test("malformed JSON yields a recoverable error", async () => {
  const req = new Request(`${site}/api/scan`, { method: "POST", headers: { Origin: site, "Content-Type": "application/json" }, body: "{" });
  assert.equal((await worker.fetch(req, env())).status, 400);
});

test("chunked uploads are capped even without Content-Length", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  let chunks = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); if (++chunks === 31) controller.close(); }, cancel() { cancelled = true; } });
  const req = new Request(`${site}/api/scan`, { method: "POST", headers: { Origin: site, "Content-Type": "application/json" }, body, duplex: "half" });
  assert.equal(req.headers.has("Content-Length"), false);
  assert.equal((await worker.fetch(req, env())).status, 413);
  assert.equal(fetch.mock.callCount(), 0);
  assert.ok(chunks <= 31);
  // Streams may have closed when their final oversize chunk was read.
  assert.ok(cancelled || chunks === 31);
});

test("declared oversize uploads are rejected without reading the body", async () => {
  const res = await worker.fetch(scan(undefined, { "Content-Length": String(31 * 1024 * 1024) }), env());
  assert.equal(res.status, 413);
});

test("bad base64 and mismatched file signatures are rejected", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  for (const img of [{ type: "image/jpeg", data: "!!!!" }, { type: "image/png", data: image().data }, { type: "image/svg+xml", data: image().data }]) {
    assert.equal((await worker.fetch(scan({ images: [img] }), env())).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("full-size image base64 validates without exhausting the regexp stack", async t => {
  t.mock.method(globalThis, "fetch", async () => reply({ ...baseReport(), photos: [{ upload: 1, label: "Portrait", verdict: "keep", score: 8, what: "A clear portrait.", fix: "Keep this photo.", bench: null }], order: ["Portrait"] }));
  const bytes = Buffer.alloc(5 * 1024 * 1024); bytes.set([255, 216, 255, 224]);
  const res = await worker.fetch(scan({ images: [{ type: "image/jpeg", data: bytes.toString("base64") }] }), env());
  assert.equal(res.status, 200);
});

test("successful text scans use the verified model mode and return a bounded report", async t => {
  let sent;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.ok(init.signal instanceof AbortSignal);
    sent = JSON.parse(init.body);
    const report = baseReport(); report.overall = 140; report.metrics[0].score = -1; report.debug = "omit me";
    return reply(report);
  });
  const res = await worker.fetch(scan(), env());
  assert.equal(res.status, 200);
  const { report } = await res.json();
  assert.equal(report.overall, 100); assert.equal(report.metrics[0].score, 0); assert.equal(report.debug, undefined); assert.equal(report.voice, null);
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.deepEqual(sent.thinking, { type: "between_tools" }); assert.deepEqual(sent.output_config, { effort: "medium" });
  assert.equal(sent.max_tokens, 8192);
});

test("custom model IDs don't inherit Sonnet 5.5-specific options", async t => {
  let sent;
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = JSON.parse(init.body); return reply(); });
  assert.equal((await worker.fetch(scan(), env({ MODEL: "custom-model" }))).status, 200);
  assert.equal(sent.thinking, undefined); assert.equal(sent.output_config, undefined);
});

test("photo mappings and suggested edits cannot escape valid bounds", async t => {
  t.mock.method(globalThis, "fetch", async () => {
    const report = baseReport();
    report.photos = [{ upload: 99, label: "wrong", score: 9 }, { upload: 1, label: "Portrait", verdict: "anything", score: 90, what: "A portrait.", fix: "Crop closer.", bench: { zoom: 99, panX: -900, panY: 900, brightness: 99, contrast: "99", warmth: -99, saturation: 99 } }];
    report.order = ["Portrait"];
    return reply(report);
  });
  const res = await worker.fetch(scan({ images: [image()] }), env());
  assert.equal(res.status, 200);
  const { report } = await res.json();
  assert.equal(report.photos.length, 1); assert.equal(report.photos[0].verdict, "fix");
  assert.deepEqual(report.photos[0].bench, { zoom: 2, panX: -100, panY: 100, brightness: 30, contrast: 0, warmth: -30, saturation: 30 });
});

test("malformed and truncated AI reports never become successful blank reports", async t => {
  let current;
  t.mock.method(globalThis, "fetch", async () => current);
  for (const report of [[], null, {}, { ...baseReport(), metrics: null }, { ...baseReport(), metrics: [null] }, { ...baseReport(), fixes: [] }]) {
    current = reply(report);
    assert.equal((await worker.fetch(scan(), env())).status, 502);
  }
  current = reply(baseReport(), { stop_reason: "max_tokens" });
  assert.equal((await worker.fetch(scan(), env())).status, 502);
  current = reply({ error: "This service is for adults." });
  assert.equal((await worker.fetch(scan(), env())).status, 422);
  current = reply({}, { stop_reason: "refusal" });
  const refusal = await worker.fetch(scan(), env());
  assert.equal(refusal.status, 422);
  assert.doesNotMatch((await refusal.json()).error, /incomplete|try again|run.*again/i);
});

test("photo reports must cover every upload with actual feedback", async t => {
  let report;
  t.mock.method(globalThis, "fetch", async () => reply(report));
  report = { ...baseReport(), photos: [{ upload: 1, label: "Portrait", score: 8, what: "Clear.", fix: "Keep it." }] };
  assert.equal((await worker.fetch(scan({ images: [image(), image()] }), env())).status, 502);
  report = { ...baseReport(), photos: [{ upload: 1, label: "Portrait", score: 8, what: "", fix: "" }] };
  assert.equal((await worker.fetch(scan({ images: [image()] }), env())).status, 502);
});

test("photo annotations identify real regions and invalid coordinates are removed", async t => {
  let annotation, verdict = "fix", bench = { zoom: 1.2 };
  t.mock.method(globalThis, "fetch", async () => reply({ ...baseReport(), photos: [{ upload: 1, label: "Portrait", score: 7, verdict, what: "Clutter distracts from the portrait.", fix: "Crop out the background clutter.", bench, annotation }] }));
  const call = async () => {
    const res = await worker.fetch(scan({ images: [image()] }), env());
    assert.equal(res.status, 200);
    return (await res.json()).report.photos[0].annotation;
  };
  annotation = { kind: "issue", x: 70, y: 50, width: 20, height: 30, label: "Background clutter" };
  assert.deepEqual(await call(), annotation);
  for (const invalid of [{ ...annotation, x: -1 }, { ...annotation, x: 95 }, { ...annotation, height: 0 }, { ...annotation, width: "20" }, { ...annotation, kind: "circle" }, { ...annotation, y: Infinity }]) {
    annotation = invalid; assert.equal(await call(), null);
  }
  annotation = { kind: "issue", x: 70, y: 50, width: 20, height: 30, label: "Background clutter" }; verdict = "keep";
  assert.equal(await call(), null);
  annotation = { kind: "crop", x: 10, y: 10, width: 80, height: 80, label: "Suggested framing" };
  assert.deepEqual(await call(), annotation);
  bench = null;
  assert.equal(await call(), null);
});

test("multiple strength callouts keep valid original-image bounds and cap at four", async t => {
  let annotations;
  const legacy = { kind: "issue", x: 5, y: 5, width: 10, height: 10, label: "Legacy clutter" };
  t.mock.method(globalThis, "fetch", async () => reply({ ...baseReport(), photos: [{ upload: 1, label: "Portrait with a guitar", score: 9, verdict: "keep", what: "The guitar gives someone a conversation hook.", fix: "Keep this photo.", bench: null, annotations, annotation: legacy }] }));
  const call = async () => {
    const res = await worker.fetch(scan({ images: [image()] }), env());
    assert.equal(res.status, 200);
    return (await res.json()).report.photos[0];
  };
  annotations = [
    { kind: "strength", x: 70, y: 10, width: 20, height: 35, label: "Guitar: a conversation hook" },
    { kind: "strength", x: 5, y: 65, width: 25, height: 30, label: "Your dog makes a natural opener" },
    { kind: "strength", x: 20, y: 5, width: 10, height: 10, label: "Hiking gear" },
    { kind: "strength", x: 40, y: 5, width: 10, height: 10, label: "Activity detail" },
    { kind: "strength", x: 55, y: 5, width: 10, height: 10, label: "Extra callout" },
  ];
  const photo = await call();
  assert.deepEqual(photo.annotations, annotations.slice(0, 4));
  assert.deepEqual(photo.annotation, annotations[0]);
  annotations = [{ kind: "strength", x: 95, y: 90, width: 20, height: 20, label: "Outside image" }, { kind: "strength", x: "10", y: 10, width: 10, height: 10, label: "Wrong type" }];
  assert.deepEqual((await call()).annotations, []);
  annotations = [{ kind: "strength", x: 10, y: 10, width: 20, height: 20, label: "Nice smile" }, { kind: "strength", x: 20, y: 20, width: 20, height: 20, label: "Strong physique" }, { kind: "strength", x: 20, y: 20, width: 20, height: 20, label: "Religious detail" }];
  assert.deepEqual((await call()).annotations, []);
  annotations = [];
  const empty = await call();
  assert.deepEqual(empty.annotations, []); assert.equal(empty.annotation, null);
});

test("provider failures never log profile data or provider bodies", async t => {
  const logs = t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "PRIVATE PROFILE TEXT" } }, { status: 429 }));
  const res = await worker.fetch(scan(), env());
  assert.equal(res.status, 503);
  assert.deepEqual(logs.mock.calls.map(c => c.arguments), [["scan_provider_error", 429]]);
  assert.doesNotMatch(await res.text(), /PRIVATE/);
});

test("WAV contents determine duration instead of trusting submitted metrics", async t => {
  let sent;
  const ai = { run: async (model, audio) => { assert.equal(model, "@cf/openai/whisper"); assert.equal(audio.audio.length, 32044); return { text: "Coffee then a long walk" }; } };
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = JSON.parse(init.body); return reply({ ...baseReport(), voice: { score: 7, verdict: "keep", what: "An easy hook.", fix: "Slow down.", script: "Coffee, then a walk.", why: "Clear detail." } }); });
  const res = await worker.fetch(scan({ voice: voice(wav(), { duration: 999 }) }), env({ AI: ai }));
  assert.equal(res.status, 200);
  const { report } = await res.json();
  assert.equal(report.voice.stats.duration, 1); assert.equal(report.voice.transcript, "Coffee then a long walk");
  assert.match(sent.messages[0].content[0].text, /recorded 1 seconds/);
});

test("corrupt, too-long, and unsupported WAV files are rejected before transcription", async t => {
  const ai = t.mock.fn(() => { throw new Error("unexpected transcription"); });
  const corrupt = wav(); corrupt.writeUInt32LE(99999, 40);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  for (const bytes of [corrupt, stereo, Buffer.from("not a wave")]) assert.equal((await worker.fetch(scan({ voice: voice(bytes) }), env({ AI: { run: ai } }))).status, 400);
  assert.equal((await worker.fetch(scan({ voice: voice(wav(61)) }), env({ AI: { run: ai } }))).status, 413);
  assert.equal(ai.mock.callCount(), 0);
});

test("voice reports require real feedback and use trusted transcript/stat fields", async t => {
  const ai = { run: async () => ({ text: "Coffee then a long walk" }) };
  t.mock.method(globalThis, "fetch", async () => reply({ ...baseReport(), voice: { score: 7, what: "Clear.", fix: "Speak naturally.", transcript: "forged", stats: { duration: 50 } } }));
  const res = await worker.fetch(scan({ voice: voice() }), env({ AI: ai }));
  assert.equal(res.status, 200);
  const report = (await res.json()).report;
  assert.equal(report.voice.transcript, "Coffee then a long walk"); assert.equal(report.voice.stats.duration, 1);
});

test("inaudible voice-only uploads ask for a new recording without an AI audit", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  const res = await worker.fetch(scan({ voice: voice() }), env({ AI: { run: async () => ({ text: "" }) } }));
  assert.equal(res.status, 422); assert.match((await res.json()).error, /No clear speech/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Turnstile must match both the scan action and requesting hostname", async t => {
  const bot = env({ TURNSTILE_SECRET: "test-secret", TURNSTILE_SITE_KEY: "test-public" });
  let result, providerCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("siteverify")) { assert.equal(init.body.get("response"), "test-token"); return Response.json(result); }
    providerCalls++; return reply();
  });
  for (const mismatch of [{ success: false }, { success: true, hostname: "elsewhere.example", action: "scan" }, { success: true, hostname: "keepfixcut.com", action: "login" }]) {
    result = mismatch; assert.equal((await worker.fetch(scan({ prompts: "hiking", turnstileToken: "test-token" }), bot)).status, 403);
  }
  assert.equal(providerCalls, 0);
  result = { success: true, hostname: "keepfixcut.com", action: "scan" };
  assert.equal((await worker.fetch(scan({ prompts: "hiking", turnstileToken: "test-token" }), bot)).status, 200);
  assert.equal(providerCalls, 1);
});

test("a stalled provider is bounded even if fetch ignores its abort signal", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const reached = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", () => { started(); return new Promise(() => {}); });
  const pending = worker.fetch(scan(), env());
  await reached;
  t.mock.timers.tick(85000);
  assert.equal((await pending).status, 504);
});

test("a provider that sends headers then stalls its body still times out", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const reached = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull() { started(); return new Promise(() => {}); } })));
  const pending = worker.fetch(scan(), env());
  await reached;
  t.mock.timers.tick(85000);
  assert.equal((await pending).status, 504);
});

test("a stalled chunked upload is bounded and never reaches the provider", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  let started;
  const reached = new Promise(resolve => { started = resolve; });
  const body = new ReadableStream({ pull() { started(); return new Promise(() => {}); } });
  const req = new Request(`${site}/api/scan`, { method: "POST", headers: { Origin: site, "Content-Type": "application/json" }, body, duplex: "half" });
  const pending = worker.fetch(req, env());
  await reached;
  t.mock.timers.tick(15000);
  assert.equal((await pending).status, 408);
  assert.equal(fetch.mock.callCount(), 0);
});

test("a stalled transcription is bounded without calling the scan provider", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider call"); });
  let started;
  const reached = new Promise(resolve => { started = resolve; });
  const pending = worker.fetch(scan({ voice: voice() }), env({ AI: { run: () => { started(); return new Promise(() => {}); } } }));
  await reached;
  t.mock.timers.tick(35000);
  assert.equal((await pending).status, 504);
  assert.equal(fetch.mock.callCount(), 0);
});
