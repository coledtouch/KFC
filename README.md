# Keep Fix Cut

An account-free dating profile teardown for adult men. One Cloudflare Worker serves [keepfixcut.com](https://keepfixcut.com) and sends selected profile content to Anthropic. Cloudflare Workers AI optionally transcribes voice prompts. Photo editing and report downloads run in the browser.

## Project map

| File | Purpose |
| --- | --- |
| `public/index.html` | Landing page, scanner, report, and photo editor |
| `public/styles.css` | Responsive layout, theme, accessibility, and print styles |
| `public/fonts.css`, `public/fonts/` | Self-hosted fonts and their bundled SIL Open Font License notices |
| `public/app.js` | Uploads, scan lifecycle, report rendering, audio, and photo editing |
| `public/writing-rules.js` | Shared humanizer rules for prompt rewrites and voice scripts |
| `public/vendor/`, `scripts/vendor.mjs` | Pinned browser libraries and their bundled MIT license notices |
| `public/privacy.html`, `public/privacy.css` | Plain-language privacy notice |
| `public/robots.txt`, `public/sitemap.xml` | Public page discovery; API paths excluded from crawling |
| `public/img/`, `public/og.png` | Example photos and social preview |
| `src/index.js` | Request validation, provider calls, report validation, and response headers |
| `test/` | Worker checks with mocked providers and local QA preview |
| `docs/integrations.md` | Dating API research and library decisions |
| `wrangler.jsonc` | Domains, bindings, rate limit, and non-secret configuration |
| `.dev.vars.example` | Template for local secrets; `.dev.vars` is ignored by Git |

The deployed Worker is named `rake`. The repository is [coledtouch/KFC](https://github.com/coledtouch/KFC).

## Run locally

Use a current Node.js version supported by Wrangler and install the exact locked dependencies:

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

Set the real `ANTHROPIC_API_KEY` in `.dev.vars` before testing scans. Open the local address Wrangler prints, normally `http://localhost:8787`. Never put secrets in browser code, `wrangler.jsonc`, screenshots, or committed files.

The example report and photo editor work without an API key. Local voice scans also need the Workers AI binding to be available. A local test is not proof that the production key, model access, or AI binding works.

## Validate a change

```powershell
npm run check
npm test
npx wrangler deploy --dry-run
```

Automated checks use mocked AI responses and do not spend API credits. Before publishing, also exercise the page at desktop and narrow mobile widths:

- Navigate with a keyboard; check form labels, focus, and expanded report sections.
- Add and remove photos, try an unreadable file, and confirm the six-photo limit.
- Run a prompts-only scan and a photo scan; check stop, retry, and service errors.
- Record or upload voice, preview it, remove it, and confirm invalid audio clears safely.
- Open a suggested photo edit, change crop and light, compare, then save the result.
- Copy a rewrite, tick the fix list, and save or print a report.
- Read the privacy notice and confirm the upload disclosure matches the providers in use.

## Production configuration

Set the API key as a Cloudflare secret:

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

`MODEL` in `wrangler.jsonc` selects the Anthropic model. Verify the configured model is available to this API account before release. Changing the model can change cost, latency, and report quality.

`ALLOWED_ORIGINS` lists the accepted browser origins. Keep it limited to the actual deployed hosts. Origin validation and the per-IP rate limiter reduce unwanted traffic, but they do not replace bot protection or a provider spending limit.

The `AI` binding supports voice transcription. The `SCAN_LIMITER` binding limits scans to four per minute per IP. Cloudflare limits are applied by its rate-limiting infrastructure; they should not be treated as a global billing ceiling.

`GET /api/config` reports `scanningAvailable`, `voiceAvailable`, and optional Turnstile configuration without exposing secrets. Scanning requires an API key, a production rate-limit binding, and a complete Turnstile key pair when verification is enabled. The page handles unavailable scanning while keeping the example and photo editor usable. This endpoint checks configuration, not live provider access.

### Optional bot verification

Create a Cloudflare Turnstile widget for the production domain, set its public site key in `TURNSTILE_SITE_KEY`, and set its matching secret:

```powershell
npx wrangler secret put TURNSTILE_SECRET
```

Configure both keys together, then verify a successful challenge and an expired token in the deployed app. Review the page's privacy notice when enabling the widget.

### Publish and verify

```powershell
npm run deploy
npm run logs
```

`routes` attaches `keepfixcut.com` and `www.keepfixcut.com` as custom domains. Confirm the Cloudflare account owns the zone before deploying. After deployment:

1. Open the canonical domain and check that `www` redirects to it.
2. Confirm the page, scripts, images, privacy notice, and API configuration load. Check the availability flags at `/api/config` and the security headers on both static and API responses.
3. Run a real scan with non-sensitive test content to verify the production key and model.
4. Test voice separately to verify Workers AI access.
5. Check operational logs for provider failures without recording submitted content.

Configure a spending limit and alerts in the Anthropic account. Review Workers AI usage and Cloudflare billing separately. API cost varies with photos, prompt length, model, and output; the app has no fixed per-scan cost.

## Private analytics dashboard

The owner dashboard is served at `/admin`. Every analytics API read requires a valid admin session. Visitors still use the app without an account. Passwords are hashed with PBKDF2; the server never stores the plain password. Secure session cookies expire after two hours, and signing out revokes the session in D1.

The `ANALYTICS_DB` binding stores page views, short-lived sessions, country/device categories, referrer hostnames, campaign labels, and operational review metrics. It stores no photos, profile text, recordings, transcripts, IP addresses, or raw user agents. The scheduled cleanup removes records older than 30 days. Cloudflare recovery backups can retain deleted records longer.

Create local owner credentials, upload only the hashed secrets, and apply the database migration before deploying:

```powershell
node scripts/create-admin.mjs
npx wrangler secret bulk output/admin-secrets.json
npx wrangler d1 migrations apply ANALYTICS_DB --remote
Remove-Item -LiteralPath output/admin-secrets.json
```

Read the generated password from `output/admin-credentials.txt` and save it in your password manager. The `output/` directory is ignored by Git and never served as a public asset. Rotate with `node scripts/create-admin.mjs --rotate`, then upload the new secrets. Rotating the signing secret ends existing admin sessions.

Active visitors estimate browser sessions seen in the last 90 seconds. They are not identified people. Browser tracking respects Do Not Track and Global Privacy Control. Server-side scan reliability and token accounting continue without recording submitted content.

Campaign attribution uses short `utm_source`, `utm_medium`, and `utm_campaign` labels. For the Reddit post, use:

[Keep Fix Cut from Reddit](https://keepfixcut.com/?utm_source=reddit&utm_medium=social&utm_campaign=divorce_men)

Referrer reporting keeps only the referring website's hostname. Tagged sources remain available when an app or browser omits the referrer. Internal navigation preserves the session's original source.

Anthropic costs are estimates for this app's recorded scans. They use actual provider token counts and the explicit price variables in `wrangler.jsonc`. Missing usage or unknown pricing is shown as unavailable, with any known portion shown separately. Estimates exclude Workers AI transcription, other apps, Cloudflare hosting, and invoice adjustments. Organization-wide billing is not connected, and the dashboard labels it accordingly.

## Data flow and privacy

Selecting or editing a photo stays local. Selecting **Run teardown** sends resized images, pasted prompts, and chosen profile context through the Worker to Anthropic. Voice recordings go to Cloudflare Workers AI; their transcript and delivery measurements go to Anthropic.

The app has no server database for uploads or reports. Reports and selected files remain in page memory. Downloaded reports and edited photos remain on the user's device. Provider processing and operational traffic logs have their own policies. Never claim providers retain no data without verifying the deployed account's policy.

Users copy prompt rewrites and upload edited photos into their dating apps themselves. Keep Fix Cut does not connect to dating accounts. See [integration research](docs/integrations.md) for reviewed source capabilities and provider constraints.

Pica 10.0.3 resizes photos locally. Its self-hosted module and MIT notice are bundled under `public/vendor/`. Refresh those artifacts with `node scripts/vendor.mjs` after changing the pinned dependency. Font licenses are bundled under `public/fonts/`.

See the user-facing [privacy notice](https://keepfixcut.com/privacy), [Anthropic's commercial retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), and [Cloudflare's Workers AI data policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/). Keep this notice aligned with the actual providers, font delivery, bot verification, and logging behavior.

## Maintaining the product

Update the site's copy and examples in `public/index.html` and the `EXAMPLE` object in `public/app.js`. Update scoring instructions in `buildPrompt()` in `src/index.js`. Keep frontend and backend upload limits aligned. Treat AI responses as untrusted data: validate their shape, bound arrays and text, and render content as text rather than HTML.

The feedback is guidance, not a prediction of dating outcomes. Keep edits limited to crop, light, and color. Preserve the adult-only and content-permission guidance near the scanner.
