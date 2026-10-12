import test from "node:test";
import assert from "node:assert/strict";
import { fetchOfficialBilling } from "../src/analytics.js";

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("no admin key reports not configured and never calls Anthropic", async () => {
  let called = false;
  const out = await fetchOfficialBilling({}, 7, async () => { called = true; });
  assert.equal(out.configured, false); assert.equal(out.connected, false); assert.equal(called, false);
});

test("sums cost report cents across pages into dollars and sends the key server-side", async () => {
  const seen = [];
  const pages = [
    reply(200, { data: [{ results: [{ amount: "123.5", currency: "USD" }, { amount: "26.5", currency: "USD" }] }], has_more: true, next_page: "p2" }),
    reply(200, { data: [{ results: [{ amount: "50", currency: "USD" }] }], has_more: false, next_page: null }),
  ];
  const out = await fetchOfficialBilling({ ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test" }, 30, async (url, init) => { seen.push({ url, key: init.headers["x-api-key"] }); return pages.shift(); });
  assert.equal(out.connected, true); assert.equal(out.totalUSD, 2); assert.equal(out.buckets, 2);
  assert.equal(seen.length, 2); assert.equal(seen[0].key, "sk-ant-admin01-test");
  assert.match(seen[0].url, /cost_report\?starting_at=/); assert.match(seen[1].url, /page=p2/);
  assert.ok(!JSON.stringify(out).includes("sk-ant-admin01-test"));
});

test("rejected key explains what kind of key is needed", async () => {
  const out = await fetchOfficialBilling({ ANTHROPIC_ADMIN_KEY: "sk-ant-api03-wrong" }, 1, async () => reply(401, {}));
  assert.equal(out.connected, false); assert.match(out.reason, /Admin key/);
});
