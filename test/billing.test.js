import test from "node:test";
import assert from "node:assert/strict";
import { fetchOfficialBilling } from "../src/analytics.js";

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const APP_KEY = "sk-ant-api03-KFCabcdefghijklmnopqrstuvwxyz0123456789-zzQQ";
const keysPage = (extra = []) => reply(200, { data: [
  { id: "apikey_app", status: "active", partial_key_hint: "sk-ant-api03-KFC...zzQQ", workspace_id: "wrkspc_kfc", scope: { type: "workspace", workspace_id: "wrkspc_kfc" } },
  { id: "apikey_other", status: "active", partial_key_hint: "sk-ant-api03-XYZ...aaBB", workspace_id: "wrkspc_other", scope: { type: "workspace", workspace_id: "wrkspc_other" } },
  ...extra,
], has_more: false });
const route = map => async (url, init) => { map.calls.push({ url, key: init.headers["x-api-key"] }); return url.includes("/api_keys") ? map.keys.shift() : map.cost.shift(); };

test("no admin key reports not configured and never calls Anthropic", async () => {
  let called = false;
  const out = await fetchOfficialBilling({}, 7, async () => { called = true; });
  assert.equal(out.configured, false); assert.equal(out.connected, false); assert.equal(called, false);
});

test("counts only the workspace that holds this app's key, across pages, in dollars", async () => {
  const map = { calls: [], keys: [keysPage()], cost: [
    reply(200, { data: [{ results: [{ amount: "123.5", currency: "USD", workspace_id: "wrkspc_kfc" }, { amount: "9000", currency: "USD", workspace_id: "wrkspc_other" }] }], has_more: true, next_page: "p2" }),
    reply(200, { data: [{ results: [{ amount: "76.5", currency: "USD", workspace_id: "wrkspc_kfc" }, { amount: "500", currency: "USD", workspace_id: null }] }], has_more: false }),
  ] };
  const out = await fetchOfficialBilling({ ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test", ANTHROPIC_API_KEY: APP_KEY }, 30, route(map));
  assert.equal(out.connected, true); assert.equal(out.scope, "workspace"); assert.equal(out.workspaceId, "wrkspc_kfc");
  assert.equal(out.totalUSD, 2); assert.equal(out.sharedKeys, 0);
  const costCalls = map.calls.filter(c => c.url.includes("cost_report"));
  assert.match(costCalls[0].url, /group_by%5B%5D=workspace_id/); assert.match(costCalls[1].url, /page=p2/);
  assert.ok(map.calls.every(c => c.key === "sk-ant-admin01-test"));
  const text = JSON.stringify(out); assert.ok(!text.includes("sk-ant-admin01-test") && !text.includes(APP_KEY));
});

test("warns when other keys share the app's workspace", async () => {
  const map = { calls: [], keys: [keysPage([{ id: "apikey_side", status: "active", partial_key_hint: "sk-ant-api03-SID...ee11", workspace_id: "wrkspc_kfc", scope: { type: "workspace", workspace_id: "wrkspc_kfc" } }])], cost: [reply(200, { data: [], has_more: false })] };
  const out = await fetchOfficialBilling({ ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test", ANTHROPIC_API_KEY: APP_KEY }, 7, route(map));
  assert.equal(out.sharedKeys, 1); assert.match(out.reason, /other active key/);
});

test("fails closed when the app key isn't in the admin key's organization", async () => {
  const map = { calls: [], keys: [keysPage()], cost: [] };
  const out = await fetchOfficialBilling({ ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test", ANTHROPIC_API_KEY: "sk-ant-api03-NOPE-nope" }, 1, route(map));
  assert.equal(out.connected, false); assert.match(out.reason, /isn't in the Anthropic organization/);
});

test("rejected admin key explains what kind of key is needed", async () => {
  const out = await fetchOfficialBilling({ ANTHROPIC_ADMIN_KEY: "sk-ant-api03-wrong", ANTHROPIC_API_KEY: APP_KEY }, 2, async () => reply(401, {}));
  assert.equal(out.connected, false); assert.match(out.reason, /Admin key/);
});
