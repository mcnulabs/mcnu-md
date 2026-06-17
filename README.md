# MCNU MD

**Anything → Markdown. Follow the gradient. ∇**

MCNU MD is a small, self-hosted web service that turns files — PDF, Word, Excel, PowerPoint, HTML, CSV, and plain text — into clean, readable Markdown. It uses Microsoft's Python [`markitdown`](https://github.com/microsoft/markitdown) as the primary engine for the widest format coverage and best fidelity, and falls back to a pure-Node converter when markitdown isn't installed — so the service works either way. It's open source, self-hostable, and part of the **MCNU Labs** family of small self-hosted tools. A public instance runs at [md.mcnu.ro](https://md.mcnu.ro).

No sign-up. Nothing stored on disk. Drop a file, get Markdown back.

---

## Features

- **Hybrid engine.** Tries `markitdown` first for the best results, then transparently falls back to a per-format Node converter if markitdown is missing, times out, or errors. Same API either way.
- **Wide format support.** PDF, Word (`.doc`/`.docx`), Excel (`.xls`/`.xlsx`), PowerPoint (`.pptx`), HTML, CSV, and a broad text family (`.txt`, `.md`, `.markdown`, `.log`, `.json`, `.xml`, `.yaml`, `.yml`).
- **Privacy by design.** No accounts, no sign-up. Uploads are held in memory and converted on the fly — nothing is persisted to disk. When markitdown runs, its temp file lives in an isolated `/tmp` (via systemd `PrivateTmp`) and is deleted immediately after conversion.
- **Per-IP rate limiting.** A sliding-window limiter caps conversions per IP (default 30/hour) to keep a public instance healthy.
- **LaTeX-diacritics repair.** A genuinely nice differentiator: text extracted from LaTeX-generated PDFs often emits accented letters as a base letter plus a stray accent glyph. MCNU MD detects and repairs these — restoring Romanian `ă â î ș ț` (and a few Western-European accents) — without touching clean prose.
- **Security headers.** A strict Content-Security-Policy plus `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS in production, applied to every response.
- **Brandable.** Static front-end you own and can re-skin — dark theme, monospace output, the nabla `∇` mark.

---

## Supported formats

Detection is by file extension. With markitdown available, everything except plain text is routed through it first, with the Node converter as a fallback. Plain text never touches markitdown. PowerPoint has no Node handler, so it requires markitdown.

| Format | Extensions | Primary engine | Node fallback |
|---|---|---|---|
| PDF | `.pdf` | markitdown | yes (`pdf-parse`) |
| Word | `.doc`, `.docx` | markitdown | yes (`mammoth` → HTML → Markdown) |
| Excel | `.xls`, `.xlsx` | markitdown | yes (`xlsx` → Markdown tables) |
| CSV | `.csv` | markitdown | yes (`xlsx` → Markdown tables) |
| HTML | `.html`, `.htm` | markitdown | yes (`turndown`) |
| PowerPoint | `.pptx` | markitdown | **no — requires markitdown** |
| Text family | `.txt`, `.md`, `.markdown`, `.log`, `.json`, `.xml`, `.yaml`, `.yml` | Node (passthrough) | n/a — always Node |

> If markitdown is disabled or unavailable, every format goes through Node. PowerPoint and any unrecognized extension will then fail with a clear error.

---

## Quick start

Requires **Node.js >= 20**.

```bash
git clone <your-fork-or-repo-url> mcnu-md
cd mcnu-md
npm install
cp .env.example .env
npm start
```

By default the server listens on `http://127.0.0.1:3007`. Open it in a browser, drop a file, and you're converting.

Scripts:

```bash
npm start   # node server/index.js
npm run dev # node --watch server/index.js (auto-restart on changes)
```

### Optional: install markitdown for full fidelity

The Node fallback covers PDF, Word, Excel, CSV, HTML, and text out of the box. For the widest coverage and best output quality — and for PowerPoint support — install markitdown:

```bash
pipx install 'markitdown[all]'
```

Make sure the `markitdown` command is on the server's `PATH` (or point `MARKITDOWN_CMD` at its full path). Without it, the service runs Node-only and PowerPoint conversions will return an error.

---

## Configuration

All configuration is via environment variables, loaded from `.env`. Copy `.env.example` to get started. Every variable is optional and has a sensible default.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3007` | TCP port the server listens on. |
| `HOST` | `127.0.0.1` | Bind address / interface. |
| `NODE_ENV` | _(unset)_ | Set to `production` to enable prod mode (`trustProxy` + HSTS header). |
| `MD_MAX_BYTES` | `26214400` | Max upload size per file, in bytes (25 MB). |
| `MD_RATE_MAX` | `30` | Per-IP rate limit: conversions allowed per window. |
| `MD_RATE_WINDOW_MS` | `3600000` | Sliding rate-limit window length, in milliseconds (1 hour). |
| `MARKITDOWN_CMD` | `markitdown` | Command/binary used to invoke Python markitdown. |
| `MARKITDOWN_DISABLED` | _(unset)_ | Set to `1` to force Node-only mode. |
| `MARKITDOWN_TIMEOUT_MS` | `60000` | Kill the markitdown subprocess after this timeout, in milliseconds (60 s). |
| `SUMMARY_TOKEN` | _(empty)_ | Auth token gating `GET /api/summary`. Empty = endpoint disabled (always 401). |

> Tip: generate a summary token with
> `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

---

## API

### `POST /api/convert`

Converts an uploaded file to Markdown. No token required. The body is `multipart/form-data` with a single file under the field name **`file`** (max 1 file).

**Success (`200`):**

```json
{
  "ok": true,
  "markdown": "# Converted document\n\n...",
  "engine": "markitdown",
  "kind": "pdf",
  "filename": "report.pdf",
  "bytes": 184320,
  "mdError": null
}
```

- `markdown` — the converted Markdown.
- `engine` — `"markitdown"` or `"node"`, indicating which engine produced the result.
- `kind` — detected document kind (`pdf`, `docx`, `xlsx`, `csv`, `html`, `text`, `pptx`, or `unknown`).
- `filename` — the original filename (or `"file"` if none was provided).
- `bytes` — size of the uploaded file in bytes.
- `mdError` — `null`, or a message explaining why markitdown was skipped/failed and the Node fallback was used.

**Error responses:**

| Status | When |
|---|---|
| `400` | Upload failed, no file, unreadable file, or empty file. |
| `413` | File exceeds `MD_MAX_BYTES` (`File too large. Max <N> MB.`). |
| `422` | Conversion failed in both engines (e.g. PowerPoint without markitdown, or an unsupported extension). |
| `429` | Rate limit exceeded (`Rate limit: <N> conversions/hour. Try again later.`). |

**curl example:**

```bash
curl -F "file=@report.pdf" https://md.mcnu.ro/api/convert
```

### `GET /api/health`

No auth. Reports liveness and whether markitdown is available:

```json
{ "ok": true, "markitdown": true }
```

### `GET /api/summary`

Token-gated stats endpoint. Send the configured token in the **`X-Summary-Token`** request header. If `SUMMARY_TOKEN` is unset/empty, or the header doesn't exactly match, the endpoint returns `401 { "error": "unauthorized" }`.

```bash
curl -H "X-Summary-Token: <your-token>" https://md.mcnu.ro/api/summary
```

```json
{
  "ok": true,
  "numbers": [
    { "label": "Conversions", "value": "1234" },
    { "label": "Engine", "value": "markitdown" }
  ]
}
```

> The conversions counter is in-memory only and resets on restart.

---

## How it works

1. **Detection by extension.** The filename's extension maps to a `kind` (PDF, Word, Excel, CSV, HTML, text, or PowerPoint). markitdown sniffs content itself, so extension is enough to pick the routing.
2. **markitdown first, Node fallback per format.** For every kind except plain text, MCNU MD writes the upload to a temp file and runs markitdown (subject to a configurable timeout). If markitdown is unavailable, returns empty, or errors, it falls back to a per-format Node converter — `pdf-parse` for PDFs, `mammoth` for Word, `xlsx` for spreadsheets and CSV (rendered as Markdown tables), and `turndown` for HTML. Plain text is passed through directly and never goes through markitdown.
3. **`tidy()` whitespace cleanup.** Both engines' output is normalized before returning: CRLF → LF, trailing whitespace stripped per line, runs of 3+ blank lines collapsed to one, and the whole thing trimmed. markitdown (especially on PDFs) tends to emit "shredded" runs of blank lines and trailing spaces; this cleans them up without touching content.
4. **`repairText()` diacritics repair.** PDFs — chiefly LaTeX-generated ones — often emit accented letters as a base letter plus a *separate* accent glyph (a breve, circumflex, or cedilla) rather than a proper Unicode character. The result is mangled text like `s,ir` or a stray `˘` floating next to an `a`. `repairText()` first normalizes to Unicode NFC, then — only when one of those tell-tale glyphs is present — recombines the pairs into the correct letters (`ă â î ș ț`), turns comma-below artifacts back into `ș`/`ț` using a letter-lookahead so real commas are left alone, and drops any orphan accent glyphs. Clean prose is detected up front and left completely untouched.

---

## Deployment

The [`deploy/`](deploy/) folder contains production-ready templates. The public instance runs behind nginx with a hardened systemd unit.

- **systemd unit** (`deploy/md.service`, installs to `/etc/systemd/system/mcnu-md.service`). Runs as a dedicated `mcnumd` user with `Restart=always` and `NODE_ENV=production`. It's locked down with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `ProtectKernelTunables`, `ProtectControlGroups`, and a restricted address-family set. Because `ProtectSystem=strict` makes the filesystem read-only, **`PrivateTmp=true`** gives the markitdown subprocess an isolated `/tmp` it can write its temp files to freely — which is also why no `ReadWritePaths` entry is needed (there's no data directory).
- **nginx reverse proxy** (`deploy/nginx.conf`, `server_name md.mcnu.ro`). Proxies to `http://127.0.0.1:3007`, redirects HTTP → HTTPS, and sets `client_max_body_size 30m` (a little headroom over the 25 MB app limit). Large uploads are streamed (`proxy_request_buffering off`) and `proxy_read_timeout 120s` accommodates slow markitdown runs on big PDFs.
- **TLS** via Let's Encrypt (`fullchain.pem` / `privkey.pem`), `TLSv1.2`/`TLSv1.3`, HTTP/2 on.

See the files in `deploy/` for the exact, copy-pasteable configuration.

---

## Security & privacy

- **No authentication on conversion.** The converter is intentionally public — no accounts, no sign-up. The only token-gated endpoint is `GET /api/summary` (via `X-Summary-Token`).
- **Per-IP rate limiting.** A sliding window caps conversions per IP (default 30/hour); exceeding it returns `429`.
- **File size cap.** Uploads are limited to `MD_MAX_BYTES` (25 MB by default); oversized uploads return `413`. Only one file per request.
- **Nothing persisted.** Files are processed in memory. When markitdown runs, the temp file is written into an isolated `PrivateTmp` `/tmp` and unlinked right after conversion. The conversions counter is in-memory and resets on restart.
- **Security headers on every response:** `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(), camera=()`, and `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production.

---

## Tech stack

- **Runtime:** Node.js >= 20
- **Server:** [Fastify](https://fastify.dev/) with `@fastify/multipart` (uploads) and `@fastify/static` (front-end)
- **Primary engine:** Microsoft [`markitdown`](https://github.com/microsoft/markitdown) (Python)
- **Node fallback:** `pdf-parse` (PDF), `mammoth` (Word), `xlsx` (spreadsheets/CSV), `turndown` (HTML → Markdown)
- **Config:** `dotenv`
- **Front-end:** static HTML/CSS/JS — dark theme, JetBrains Mono output, the `∇` mark

---

## License

MIT — see [`LICENSE`](LICENSE). MIT is the recommended choice for a small open-source tool like this; the author is free to change it.

---

<p align="center">
  <strong>∇ MCNU Labs — follow the gradient.</strong><br>
  Made by Andrei Mocanu.
</p>
