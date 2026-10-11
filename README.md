# Keep Fix Cut

Free dating-profile teardown for men. One Cloudflare Worker serves the site and runs scans.

Live: https://keepfixcut.com (the Worker itself is named `rake`, and https://rake.coleciprari.workers.dev still works)

```
rake/
  public/index.html    the whole site (landing, scanner, report, photo bench)
  public/img/          the example photos, resized and stripped of metadata
  public/og.png        the social share image
  src/index.js         the Worker: serves public/, handles POST /api/scan, redirects www
  wrangler.jsonc       Cloudflare config (rate limit, model, allowed origins, custom domain)
  .dev.vars.example    template for local testing secrets
```

How a scan works: the browser shrinks each photo to 1568px JPEG, posts it to `/api/scan`, the Worker builds the prompt itself (visitors can't send their own), calls the Claude API with your key, and returns the report as JSON. Nothing is stored. The photo bench runs entirely in the browser and never uploads anything.

## Turn on scanning

```powershell
cd C:\Users\cole\dev\rake
npx wrangler secret put ANTHROPIC_API_KEY   # paste your key when prompted
```

The secret takes effect immediately; no redeploy needed.

## Redeploy after edits

```powershell
cd C:\Users\cole\dev\rake
npx wrangler deploy
```

## Cost guards

1. Set a monthly spend limit in the Anthropic Console (Settings, Limits). This is the hard ceiling.
2. `ALLOWED_ORIGINS` in `wrangler.jsonc` lists keepfixcut.com, www, and the workers.dev address. Scans from anywhere else are refused.
3. Rate limit: 4 scans per minute per IP (`ratelimits` in `wrangler.jsonc`).

Optional Turnstile bot check (free): create a widget in the Cloudflare dashboard, put the site key in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, then:

```powershell
npx wrangler secret put TURNSTILE_SECRET
npx wrangler deploy
```

## Custom domain

`routes` in `wrangler.jsonc` attaches keepfixcut.com and www.keepfixcut.com to the Worker on every deploy. The Worker redirects www to the bare domain. If you ever move the zone out of this account, remove the `routes` block before deploying.

## Cost per scan

A 6-photo scan is roughly 10,000 input tokens and 2,000 to 3,000 output tokens on the model in `MODEL` (default `claude-sonnet-5-5`).

## Local testing

```powershell
Copy-Item .dev.vars.example .dev.vars   # put your real key in .dev.vars
npx wrangler dev
```

Open http://localhost:8787. Scans from localhost need `http://localhost:8787` added to `ALLOWED_ORIGINS`.

## Watching it live

```powershell
npx wrangler tail
```

## Changing things

- Copy, layout, the example report: `public/index.html` (the example is the `EXAMPLE` object in the script; its `pool` array is the camera-roll sheet).
- What the AI checks and how it scores: `buildPrompt()` in `src/index.js`.
- Photos per scan: `MAX_IMAGES` in `src/index.js` and `MAX` in `public/index.html` (keep them equal).
