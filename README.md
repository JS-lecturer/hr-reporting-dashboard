# Parumleo Orient — HR Reporting & Agent Dashboard

A 100% static HR reporting dashboard with an embedded autonomous "watch rule"
agent. No backend server, no database, no build step. Runs entirely from
files opened directly in a browser or hosted on free GitHub Pages.

---

## 1. Deploying to GitHub Pages (drag-and-drop)

1. Unzip this folder. `index.html` must be at the top level of what you upload.
2. Go to GitHub → create a new repository (public, free tier is fine).
3. On the repo's main page, click **Add file → Upload files**.
4. Drag the *contents* of this folder (not the folder itself) into the upload
   box — `index.html`, `css/`, `js/`, `data/`, `README.md` should all land at
   the repo root.
5. Commit the upload.
6. Go to **Settings → Pages**. Under "Build and deployment", set **Source** to
   "Deploy from a branch", branch `main`, folder `/ (root)`. Save.
7. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`
   within a minute or two.

You can also just open `index.html` directly from disk (double-click it) —
everything runs via plain `<script>` tags, no server required for local use.
(Note: some browsers restrict `fetch()` of local files under `file://` — if
the dashboard shows a data-load error when opened this way, run any simple
static file server, e.g. `python3 -m http.server`, from this folder instead.)

---

## 2. Data refresh & change detection

- The **Refresh** button in the header reloads `data/*.json` from disk and
  recomputes every view.
- Every 30 seconds, the app re-fetches the same JSON files and compares an
  embedded `version` hash. If it differs from what's currently loaded, a
  banner appears: "Updated data is available — refresh to view." The app
  **never** auto-refreshes without telling you — you always click Refresh
  yourself.
- **Limitation**: this only detects changes to the static JSON files sitting
  next to `index.html` (e.g. if you regenerate and re-upload them to GitHub).
  It has no way to detect changes in the original Excel/Word source files —
  those must be reconverted to JSON and re-deployed.

---

## 3. Gemini settings

- Set your Gemini API key and model name in the **Settings** tab.
- The key is stored **only** in this browser's `localStorage`, under the
  `hrdash_settings` key. It is never sent anywhere except directly to
  Google's Generative Language API from your browser. It is plaintext and
  visible to anyone with access to this browser profile (e.g. via DevTools).
  Do not use this on a shared/public computer with a real key.
- If no key is set, the AI-driven chat layer (Layer 2) degrades to a clearly
  labeled `[template — configure a Gemini key for real analysis]` output
  instead of silently pretending to reason.

---

## 4. Static-site limitations (read this once, it applies everywhere)

- **No backend.** Everything except the optional email webhook runs in your
  browser tab.
- **No true background jobs.** Watch rules only evaluate while this tab is
  open in a browser. Close the tab, and scanning stops completely — nothing
  runs "in the cloud" on your behalf.
- **No secure secret storage.** Your Gemini key and webhook URL live in
  plaintext in browser localStorage.
- **No direct email sending.** The dashboard cannot send email by itself. It
  either opens your mail client (`mailto:`) for you to hit send, or calls a
  webhook you deploy yourself (see below) which does the actual sending.
- **No database.** All data lives in memory after being loaded from the JSON
  files, plus settings/rules/logs in localStorage. Clearing browser storage
  resets settings, rules, and the agent log (not the underlying data files).

---

## 5. How email works

Two modes, chosen in Settings. **Whichever mode is saved and active is the
one that actually fires** — there is no code path where the UI shows one
mode as active but a different one sends.

### mailto mode
Fully client-side. Clicking send (or the agent triggering an email action)
opens your default mail client with `to`, `subject`, and `body` prefilled via
`window.location.href = "mailto:..."`. You still have to hit send yourself in
your mail app.

### webhook mode
Calls a Google Apps Script Web App that you deploy yourself (instructions
below). Contract:

- **Request**: `POST`, `Content-Type: text/plain` (deliberately not
  `application/json`, to avoid a CORS preflight — Apps Script still parses
  the JSON string body fine). Body is a JSON string:
  ```json
  { "to": "you@company.com", "subject": "...", "body": "...", "meta": { } }
  ```
- **Response**: the dashboard reads the real JSON response and never assumes
  success just because the request didn't throw:
  ```json
  { "ok": true }
  { "ok": false, "error": "Rate limited. Please wait before sending another email." }
  { "ok": false, "error": "Recipient is not allowed." }
  ```
- If the response is unreadable due to CORS (opaque response), the dashboard
  falls back to a `no-cors` fire-and-forget request and says plainly:
  *"Request sent — check your inbox, delivery confirmation isn't available
  from this browser."* It never claims delivery succeeded without
  confirmation.
- The email recipient field in Settings must always be your own address —
  the agent can never be configured to send anywhere else.

### Deploying your own Apps Script webhook
1. Go to [script.google.com](https://script.google.com) → New project.
2. Write (or reuse) a `doPost(e)` function that parses `e.postData.contents`
   as JSON, sends the email via `MailApp.sendEmail(to, subject, body)`,
   enforces your own recipient allowlist and a 60-second rate limit, and
   returns a JSON response matching the contract above.
   *(This dashboard does not generate that script for you — write or bring
   your own Code.gs.)*
3. Deploy → New deployment → type **Web app**.
   - **Execute as**: Me
   - **Who has access**: Anyone
4. Copy the resulting web app URL and paste it into **Settings → Webhook
   URL**.

---

## 6. Watch rules — what the agent actually does

Enabled by default, out of the box:
> "If 12-month attrition crosses 15%, investigate which department is
> driving it, draft an analysis, and email me."

Every scan tick (interval configurable in Settings, default 30 seconds),
five stages run and are logged in the **Agent** tab:

1. **PERCEIVE** — recompute the rule's metric from the live loaded data.
2. **DECIDE** — compare against the threshold. Logged on every state change;
   otherwise a low-noise heartbeat roughly every 20 ticks so the log doesn't
   spam "no action needed" every 30 seconds.
3. **INVESTIGATE** — on trigger, run a real query (e.g. attrition rate by
   department) to find the actual driver, not just restate the number.
4. **ACT** — draft a plain-language analysis (via Gemini if configured, a
   labeled template otherwise), then send/attempt the configured email
   action.
5. **REPORT** — a persisted, timestamped log entry summarizing what was
   detected, investigated, and done (or why not).

Data updated through chat (e.g. "raise everyone in Shanghai Ops... to 0.85")
mutates the same in-memory dataset the agent reads — so a rule can flip
state and fire on its very next scan tick, with no page reload.

**You can also define your own rules in plain language** in the Agent tab.
The parser recognizes at least these shapes (and reasonable variants):
- rate ("if 12-month attrition crosses 15%")
- average ("if average burnout risk in Operations exceeds 3.5")
- count/existence ("if there are no employees with compa-ratio less than 1")
- count-vs-threshold ("if fewer than 5 employees have engagement score below 3")
- min/max ("if the lowest compa-ratio in any department drops below 0.75")
- equals/at-least ("if any employee compa-ratio is 2" — resolves to **≥ 2**
  by default; say "is exactly 2" for strict equality)
- percent-vs-decimal ("200%" against a decimal field like compa-ratio is
  converted to 2.0 automatically, and the converted value is always shown
  back to you when the rule is confirmed)

**Watch rules only run while this browser tab stays open.** For an always-on
alternative, you can (as a future option, not built here) replicate the same
condition logic inside your Apps Script project and attach a time-based
trigger (Triggers → Add Trigger → Time-driven) so it runs even with no
browser open — that script would need its own copy of the data and rule
logic, which is outside the scope of this static site.

---

## 7. The data agent (chat tab) — what it can and can't do

Every message is routed through exactly two hardcoded checks:
1. Is it a **write/action** request (update data, send an email, create a
   watch rule)? → deterministic action path, with preview + explicit
   confirmation required before any write is applied.
2. Is it a **pure data lookup** (count, average, filter, ranking,
   comparison) answerable directly from the loaded columns? → Layer 1,
   a deterministic query engine. No LLM involved, no guessing — if a number
   is asked for, it's actually computed from the loaded JSON.
3. Everything else → Layer 2, a single general-purpose conversational layer
   powered by Gemini. It's given only the facts Layer 1 actually computed
   (attrition, compa-ratio, engagement, burnout, headcount, by segment or
   company-wide) plus recent conversation history — it never invents a
   number. For questions unrelated to HR data, it just answers naturally and
   briefly, the way a competent assistant would.

**Without a Gemini key configured**, Layer 2 always self-labels its output
as `[template — configure a Gemini key for real analysis]` rather than
silently producing generic text.

---

## 8. Folder structure

```
index.html
README.md
css/
  styles.css
js/
  config.js         shared constants, localStorage helpers, Settings (single source of truth)
  data.js            loads data/*.json into live in-memory DataStore, change detection
  queryEngine.js      Layer 1 primitives: field synonyms, filters, grouping, aggregation, attrition calc
  layer1Answer.js    Layer 1 natural-language question parser (deterministic)
  ruleEngine.js       parses + evaluates plain-language watch rules
  email.js            mailto / webhook sender, matches section 6 contract exactly
  layer2.js           Layer 0 routing + Layer 2 Gemini-driven chat + action handling
  agent.js             the core 5-stage autonomous loop + persisted log
  charts.js            dependency-free SVG bar/pie/line/histogram charts
  ui.js                renders every tab/view
  main.js              boot sequence
data/
  employees.json        converted from Parumleo_Orient_Employees.xlsx (1,000 records, every column preserved)
  ex_employees.json     converted from Parumleo_Orient_Ex_Employees.xlsx (413 records)
  metrics_dictionary.json  converted from HR_Metrics_Dictionary.xlsx ("HR Metrics Dictionary" sheet, 241 rows)
```

All localStorage keys are namespaced `hrdash_*` (settings, rules, agent log).
