# Foundry Wiki Bridge

Two-way sync between Foundry VTT journals and an [Outline](https://www.getoutline.com/) wiki.
Pick the journal folders your players may see, and they appear in Outline as a nested tree of
documents: folders, entries, pages. Edit on either side and sync. Links to items become
hover-previewable cards, GM secrets never leave Foundry, and images travel both ways.

Status: early. Version 0.6.0, built and tested against Foundry VTT v14 with the Pathfinder 2e
system and a self-hosted Outline v1.10. Other systems work with a plainer item card.

## How it works

```
Foundry (browser)  ──HTTPS──▶  wiki-bridge proxy  ──HTTP──▶  Outline API
 module, GM only     shared      Node 22, holds the       API key
                     secret      Outline API key
```

Two parts, both in this repository:

- **`module/`**: a Foundry module (plain ES modules, no build step). Adds a "Wiki Bridge" window
  to the journal sidebar for GMs, converts page content, and talks only to the proxy.
- **`proxy/`**: a small Node/TypeScript service. It holds the Outline API key, authenticates the
  module with a separate shared secret, answers CORS for your Foundry origins, converts between
  Foundry's HTML and Outline's markdown, and forwards Outline's rate-limit hints.

Why a proxy: Foundry modules run in the browser, Outline's API sends no CORS headers, and every
world setting in Foundry is readable by every player, so an API key can never live in the module.

## Mapping model

One Outline collection per game world, mirrored as a three-level tree so pages show up nested in
the wiki sidebar.

| Foundry | Outline |
|---|---|
| the selected top-level journal folders (any number) | one 📁 document each at the collection root |
| optionally, entries that sit outside any folder | documents at the collection root |
| journal folder below a selected root | 📁 document with an empty body, nested like the folder |
| journal entry | document under its folder's document |
| text page | document nested under the entry's document, title = page name |
| (none) | text typed into an entry document's own body shows as a "(body)" page |
| items linked from pages | one card document each under a 📦 Items document at the collection root |

Folders you leave unticked are never touched on either side. That is how GM-only material stays
private: keep it in its own top-level folder and do not select it.

Wiki-first content is classified by position and icon: under the root or a folder, a document
with 📁 is a folder and anything else is an entry; under an entry, every document is a page.
Anything nested deeper is reported and ignored.

## Features

- **Two-way sync with change detection.** Each side's timestamps are compared against the values
  recorded at the last sync, never content bytes. "Sync all" handles every unambiguous row and
  skips anything changed on both sides; those get Pull and Push buttons.
- **Deletions and moves.** A page deleted in Foundry is trashed in the wiki by Sync all
  (recoverable in Outline for 30 days). Entries and folders dragged elsewhere are moved on the
  other side. Something dragged out of the selected folders is never synced again and gets a
  trash button for its wiki copy.
- **GM secrets stay home.** Pages run through Foundry's enricher with secrets off before they
  leave, so secret blocks are dropped and `@UUID` links, inline rolls and system enrichers
  become readable text or links.
- **Item cards with hover previews.** Links to items become links to a card document: a stat
  line first (level, traits, price, damage, cast time and so on for PF2e), then the description,
  source and picture. Outline previews the card when you hover the link. Actors are never
  mirrored. On pull, links turn back into `@UUID[...]`, so a round trip keeps Foundry's links.
- **Images both ways.** Pushed images link to your public Foundry address (Foundry serves world
  files without a login). Images pasted into the wiki are copied into the world's data directory
  on pull.
- **Formatting.** Underline, highlight, strikethrough, tables (a header row is promoted, merged
  cells padded), PF2e action glyphs as ◆ ◆◆ ◆◆◆ ◇ ↺, inline rolls as code, Outline notice blocks
  as labelled quotes. Colour, fonts, sizes and alignment have no wiki equivalent and are dropped.
- **Auto-sync, optional.** Auto-push sends an edit a few seconds after it settles. Auto-pull has
  the active GM's browser poll the wiki once a minute. Both are off by default.
- **"Open in wiki"** in the header of every synced journal entry, for anyone who can open it.
- **Rate-limit aware.** Outline allows 25 document creates per minute per API key. The proxy
  forwards Outline's Retry-After and the module waits and retries, with progress in the window.

## Requirements

- Foundry VTT v13 or v14 (verified on v14).
- An Outline workspace you can create an API key in: self-hosted or cloud.
- Somewhere to run the proxy: Docker, or Node 22+.
- The proxy must be reachable from the players' browsers over HTTPS, for example behind the same
  reverse proxy or tunnel that serves Foundry and Outline.

## Setup

### 1. The proxy

Create an Outline API key (Settings → API & Apps). Scope it to `collections.list`, `documents.*`
and `attachments.*` if your Outline version supports scoped keys. Generate a shared secret for
the module:

```bash
openssl rand -hex 32
```

Configuration is by environment variables; see `proxy/.env.example`.

| Variable | Meaning |
|---|---|
| `OUTLINE_URL` | Outline as the proxy reaches it (inside Docker: the container, e.g. `http://outline:3000`) |
| `OUTLINE_PUBLIC_URL` | Outline as users open it, used for links. Defaults to `OUTLINE_URL` |
| `OUTLINE_API_KEY` | the API key |
| `BRIDGE_SECRET` | the shared secret the module presents |
| `ALLOWED_ORIGINS` | comma-separated browser origins allowed to call the proxy: your Foundry addresses |
| `PORT`, `HOST` | listen port (default 3002) and bind address |

With Docker, add the service from `docker-compose.example.yml` to the Compose file that runs
Outline and put the two secrets in its `.env`:

```bash
docker compose build wiki-bridge
docker compose up -d wiki-bridge
curl -s http://127.0.0.1:3002/health
```

Without Docker:

```bash
cd proxy
npm install
npm run build
OUTLINE_URL=... OUTLINE_API_KEY=... BRIDGE_SECRET=... ALLOWED_ORIGINS=... npm start
```

Expose the port through your reverse proxy or tunnel on its own hostname, e.g.
`https://bridge.example.com`. Only `GET /health` is open; everything under `/api/` needs the
secret. Cloudflare Tunnel, Caddy, nginx and Traefik all work; the proxy speaks plain HTTP.

### 2. The module

Copy `module/` into your Foundry data directory as `Data/modules/foundry-wiki-bridge/`, return
to the Setup screen so Foundry rescans packages, then enable "Foundry Wiki Bridge (Outline)" in
the world. Enabling a module reloads every connected client, so do it outside a session.

Configure Settings → Foundry Wiki Bridge:

| Setting | Scope | Meaning |
|---|---|---|
| Bridge proxy URL | world | e.g. `https://bridge.example.com` |
| Bridge secret | this browser | the shared secret; each GM browser enters it once |
| Public Foundry URL for images | world | the address players open Foundry on; empty = the browser's own |
| Mirror linked items as wiki cards | world | on by default |
| Auto-push journal edits | world | off by default |
| Auto-pull wiki changes | world | off by default |

The secret is a client setting on purpose: world settings are readable by every player.

### 3. First sync

Journal sidebar → "Wiki Bridge" (GM only). Choose the Outline collection for this world, tick the
top-level journal folders players may see, then Refresh. Every folder, entry and page shows with
a status and Pull / Push buttons; "Sync all" runs the safe moves. A first push of a big journal
takes minutes because of Outline's create limit: leave the window open.

Test against a scratch folder and a scratch collection before pointing it at a live campaign.

## Statuses

| Status | Meaning | Sync all does |
|---|---|---|
| In sync | nothing changed since the last sync | nothing |
| Only in Foundry / Only in wiki | exists on one side | push / pull |
| Foundry changed / Wiki changed | changed on one side | push / pull |
| Conflict: both changed | changed on both sides | skips; you choose Pull or Push |
| Deleted in Foundry | page deleted here, wiki copy remains | trashes the wiki copy |
| Gone from wiki | the wiki document was trashed | skips; Push recreates, trash button deletes here |
| Title differs | same content, different name | skips; Pull or Push settles it |
| Moved in Foundry / in wiki | parent changed on one side | moves the other side |
| Not selected for sync | a top-level folder you did not tick | nothing, ever |
| Moved out of the synced folders | a mapped entry dragged into a private folder | nothing; trash button for the wiki copy |

Folder and entry buttons act on everything beneath them. Deleting in Foundry has no undo;
deleting in the wiki goes to Outline's trash.

## Security notes

- The Outline API key exists only in the proxy's environment.
- The module authenticates with a shared secret compared in constant time; the secret is stored
  per browser, never in a world setting.
- CORS is an explicit allowlist of your Foundry origins.
- Content leaves Foundry only when a GM pushes it (or has auto-push on), and only from the
  selected folders. Unrevealed secret blocks are removed before conversion, and again in the
  proxy as a safety net.
- Owned items (an actor's inventory) are never turned into cards, since they can carry stat
  blocks.

## Known limits

- Wiki-side deletions are noticed on Refresh, not by auto-pull.
- A page changed on both sides always needs a decision in the window.
- Outline's editor has four heading levels and no colour, font or alignment marks.
- Non-text pages (images, PDFs, video) are listed and skipped.
- Item cards are created once; edit the card in the wiki if the item changes, or trash it and
  push again.

## Development

```
module/     Foundry module: scripts/*.mjs, templates/bridge.hbs, styles/bridge.css, module.json
proxy/      Node 22 + TypeScript: src/index.ts (server, routes), src/convert.ts (HTML <-> markdown)
```

Proxy: `npm install`, `npm run build` (tsc), `npm run dev` (tsx). Runtime dependencies are
`marked`, `turndown`, `turndown-plugin-gfm` and `@mixmark-io/domino`. Module: no build; after
copying a new version, reload Foundry with Ctrl+F5 so the browser drops cached scripts.

Proxy routes, all JSON and all behind the shared secret except `/health`:

| Route | Purpose |
|---|---|
| `GET /health` | liveness, plus the public Outline URL |
| `POST /api/convert` | `{html}` → `{markdown}` or `{markdown}` → `{html}` |
| `GET /api/collections` | collections the key can see |
| `GET /api/collections/:id/documents` | every document in a collection |
| `GET /api/collections/:id/changes?since=` | documents updated after a timestamp |
| `POST /api/collections/:id/documents` | create (title, markdown or html, parentDocumentId, icon) |
| `GET /api/documents/:id?format=html` | read |
| `PUT /api/documents/:id` | update; `expectedUpdatedAt` gives a 409 on conflict unless `force` |
| `POST /api/documents/:id/move` | re-parent |
| `DELETE /api/documents/:id` | trash |
| `GET /api/attachments/:id` | raw bytes of a wiki attachment |

## License

Not chosen yet.
