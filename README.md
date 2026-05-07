# jot

https://github.com/user-attachments/assets/542c333c-c26e-4f04-a5bb-2cf4131e60f3

Minimal self-hosted collaborative markdown editor with inline comment threads. Built for humans and agents.

## Quick Start

```bash
npm install -g @mariozechner/jot
jot serve
```

Open `http://localhost:3210`. Set the owner password on first visit.

## Features

- Collaborative real-time editing (multiple tabs, multiple users)
- Remote cursors with names
- Inline comment threads anchored to text selections
- Threaded replies, resolve/reopen
- Share notes with configurable access (view, comment, edit)
- CLI for humans and agents (owner API keys or share links)
- Agent setup modal with copy-paste instructions
- Dark and light theme
- Mobile support
- `.md` files on disk (derived from collaborative state)

## Server

```bash
npm install -g @mariozechner/jot
jot serve                    # port 3210, data in ./data
jot serve --port=8080        # custom port
jot serve --data=/var/jot    # custom data dir
```

## Docker

```bash
cd docker
bash control.sh start
```

## Sharing

Click the share icon in the editor to configure access:

- **Not shared** (default)
- **View only**: read-only preview
- **View & comment**: preview with comment threads
- **Edit & comment**: full collaborative editor with comments

Each note has a stable share URL (`/s/<id>`). Anyone with the link gets the configured level of access, both in the browser and via the CLI. Toggle access without changing the link.

## CLI

The CLI works in two modes depending on how you register.

### Owner mode

The instance owner creates API keys from the settings gear on the landing page. An API key grants full access to all notes.

```bash
jot register myserver https://jot.example.com <api-key>
jot myserver list
jot myserver search "query"
jot myserver read <note-id>
jot myserver create "My note"
jot myserver edit <note-id> '[{"oldText":"foo","newText":"bar"}]'
jot myserver comment <note-id> "quoted text" "comment body"
jot myserver reply <note-id> <thread-id> <message-id> "reply"
jot myserver resolve <note-id> <thread-id>
jot myserver reopen <note-id> <thread-id>
jot myserver edit-comment <note-id> <message-id> "new body"
jot myserver delete-comment <note-id> <message-id>
jot myserver delete-thread <note-id> <thread-id>
jot myserver update <note-id> title "New title"
jot myserver delete <note-id>
```

### Shared mode

Anyone with a share link can use it to register. No API key needed. The link itself is the credential, and access depends on what the owner configured (view, comment, or edit). This works for both humans and their agents. Humans can use the link in the browser for better UX.

```bash
jot register shared https://jot.example.com/s/abc123
jot shared read
jot shared edit '[{"oldText":"foo","newText":"bar"}]'
jot shared comment "quoted text" "comment body" --name="My Agent"
jot shared reply <thread-id> <message-id> "reply" --name="My Agent"
```

### Agent integration

Click the robot icon in the editor or on a shared note to get copy-paste CLI instructions. The instructions are pre-filled with the instance URL and note ID. Hand them to your agent and it can read, edit, and comment on the note.

## Data

```
data/
  auth.json
  notes/
    <id>.md
    <id>.json
```

The `.md` files are derived from the collaborative editing state stored in the `.json` sidecar. The JSON is the source of truth. The markdown files are written for convenience (grep, backup, external tooling).

## HTTP API

All owner endpoints require `Authorization: Bearer <api-key>`.

| Method | Endpoint                              | Description                         |
| ------ | ------------------------------------- | ----------------------------------- |
| GET    | `/api/notes?q=<query>`                | List/search notes                   |
| POST   | `/api/notes`                          | Create note                         |
| GET    | `/api/notes/:id`                      | Read note                           |
| PUT    | `/api/notes/:id`                      | Update title, markdown, shareAccess |
| DELETE | `/api/notes/:id`                      | Delete note                         |
| POST   | `/api/notes/:id/edit`                 | Apply text edits                    |
| POST   | `/api/notes/:id/threads`              | Create comment thread               |
| POST   | `/api/notes/:id/threads/:tid/replies` | Reply to thread                     |
| PATCH  | `/api/notes/:id/threads/:tid`         | Resolve/reopen thread               |
| DELETE | `/api/notes/:id/threads/:tid`         | Delete thread                       |
| PATCH  | `/api/notes/:id/messages/:mid`        | Edit comment                        |
| DELETE | `/api/notes/:id/messages/:mid`        | Delete comment                      |
| GET    | `/api/keys`                           | List API keys                       |
| POST   | `/api/keys`                           | Create API key                      |
| DELETE | `/api/keys/:id`                       | Delete API key                      |

Share endpoints (no auth, access controlled by `shareAccess`):

| Method | Endpoint                               | Description                    |
| ------ | -------------------------------------- | ------------------------------ |
| GET    | `/api/share/:sid`                      | Read shared note               |
| GET    | `/api/share/:sid/note`                 | Read shared note (lightweight) |
| POST   | `/api/share/:sid/edit`                 | Edit (requires edit access)    |
| POST   | `/api/share/:sid/threads`              | Create comment                 |
| POST   | `/api/share/:sid/threads/:tid/replies` | Reply                          |
| POST   | `/api/share/:sid/render`               | Render markdown to HTML        |

## Confluence-backed notes

A jot note can be **bound to a Confluence page**. The collab buffer holds
annotated markdown produced by `confluence-adf render --no-compress`; ADF
lives only at the boundary, fetched and pushed via the
[`confluence-adf`](https://github.com/rodrigoelias/the-confluence-plugin)
Python CLI.

### Setup

The deployment uses one Confluence service account for all bindings (single
tenant in v1):

```
export CONFLUENCE_BASE_URL="https://yourcompany.atlassian.net/wiki"
export CONFLUENCE_EMAIL="bot@yourcompany.com"
export CONFLUENCE_API_TOKEN="..."
# optional: explicit path to the CLI; otherwise PATH or .venv/bin
export CONFLUENCE_ADF_BIN="/usr/local/bin/confluence-adf"
```

When `GET /api/confluence/config` reports `configured: true`, the list page
shows an "Import from Confluence" button. Importing a page creates a note
seeded from the rendered annotated markdown and stores a `confluence` binding
on the note.

### Lifecycle

- **Import** (`POST /api/notes/confluence/import`, owner-only): spawns
  `confluence-adf render <pageId> --no-compress`, builds the note, records
  the binding (page id, last known versions, sha256 of imported markdown).
- **Edit**: as usual, via WebSocket or `POST /api/notes/:id/edit`. Edits
  land in the server-side jot copy. `<!-- @path:... -->` markers are
  protected by a server-side validator that rejects inserts/deletes that
  would split a marker run; clients are notified via the `marker-ids` WS
  message.
- **Publish** (`POST /api/notes/:id/confluence/push`, owner-only): sends the
  current buffer to `confluence-adf apply`. There is **no auto-publish**,
  debounced or otherwise — the owner clicks Publish.
- **Refresh** (`POST /api/notes/:id/confluence/refresh`, owner-only):
  re-runs render and replaces the server-side copy. Returns `409
  local-edits-would-be-lost` unless `force=true` or the buffer is unchanged
  since the last publish.

Confluence error mapping mirrors the CLI exit codes:

| CLI exit | jot status   | UI behavior              |
| -------- | ------------ | ------------------------ |
| 0        | `pushed`     | success                  |
| 4        | `conflict`   | fetch conflict modal     |
| 5        | `conflict`   | draft conflict modal     |
| 3        | `error`      | config message           |
| else     | `error`      | crash message            |

### Comments

`CommentThread`s remain local to jot in v1. Two-way sync to Confluence
inline annotations is a v2 follow-up.

## Agents on Confluence pages

Agents (API-key callers and share-link guests) can use jot's existing
programmatic surface to drive a Confluence-bound note. Reads are always
allowed; edit and comment access are **owner-opt-in per note** and default
off. **Publish and Refresh are owner-only and never delegated.**

### Read-only (default)

| Method | Endpoint                                   | Notes                                   |
| ------ | ------------------------------------------ | --------------------------------------- |
| GET    | `/api/notes/:id`                           | Visible projection (markers stripped)   |
| GET    | `/api/notes/:id?annotated=1`               | Owner-session-cookie only               |
| GET    | `/api/notes/:id/confluence/status`         | Cheap; safe to poll                     |
| GET    | `/api/share/:sid/note`                     | Visible projection                      |

### Owner-opt-in (per note)

| Method | Endpoint                                | Gated by                  |
| ------ | --------------------------------------- | ------------------------- |
| POST   | `/api/notes/:id/edit`                   | `agentEditsAllowed`       |
| POST   | `/api/share/:sid/edit`                  | `agentEditsAllowed`       |
| POST   | `/api/notes/:id/threads` (and replies)  | `agentCommentsAllowed`    |
| POST   | `/api/share/:sid/threads` (and replies) | `agentCommentsAllowed`    |

When the gate is closed the endpoint returns `403 agent-edits-disabled` /
`403 agent-comments-disabled`. Edits that would split a `<!-- @path: ... -->`
marker return `409 marker-conflict` with the offending marker key echoed.

### Owner-only (never delegated)

| Method | Endpoint                                | Notes                             |
| ------ | --------------------------------------- | --------------------------------- |
| POST   | `/api/notes/confluence/import`          | Bind a new note                   |
| POST   | `/api/notes/:id/confluence/push`        | **Publish** to Confluence         |
| POST   | `/api/notes/:id/confluence/refresh`     | Pull from Confluence              |
| PATCH  | `/api/notes/:id/confluence`             | Toggle agent gates (audit-logged) |

These endpoints all require an owner **session cookie**; an owner API key is
not sufficient. This is deliberate — destructive Confluence-side actions are
human-in-the-loop only.

### CLI helpers

The bundled `jot` CLI gains a `status` subcommand:

```
jot <instance> status <id>     # confluence binding status
```

`jot edit` and `jot comment` already exist; on Confluence-bound notes they
surface a clear error when the per-note flag is off. **`jot publish` and
`jot refresh` are intentionally not provided** — the owner publishes from
the UI deliberately.

## Next steps

The v1 implementation lands the full server-side surface (validator, gated
routes, audit log) and a minimal-but-functional UI. The following are
deliberate v1 deferrals, ordered roughly by user impact:

- **Hide markers in the live textarea.** The server-side visible projection
  is in place (`GET /api/notes/:id` and the share endpoints already strip
  markers), but the textarea still shows raw `<!-- @path:... -->` markers
  while editing. Building the textarea-side projection requires rewriting
  the offset ↔ ElementId translation throughout `public/collab-editor.js`
  to skip marker chars when reading `selectionStart` / `selectionEnd` and
  when calling `idList.at()`. The helpers (`buildMarkerKeySet`,
  `visibleLengthBefore`) are already exported from `collab-shared.js`.
- **Two-way comment sync** between jot threads and Confluence inline
  annotations. Comments stay local in v1; this also needs new endpoints in
  `confluence-adf`.
- **Path-anchored agent edit verbs** (e.g. `POST /edit?path=42` mapping to
  `confluence-adf edit <pathId> replace`) for surgical agent edits without
  ambiguity. v1 keeps `/api/notes/:id/edit` text-based and lets the marker
  validator + visible projection do the rest.
- **Incremental marker recompute.** `scanMarkerIds` is currently O(N) per
  accepted mutation. For very large pages, walk only the affected range.
- **3-way merge on refresh.** v1 is replace-with-confirm; a real merge
  would need to keep ElementIds stable across the swap.
- **Rich rendering of ADF-only nodes** (panels, expand, layoutSection,
  status). They render as fenced markdown today.
- **Live Confluence-side change notifications.** v1 is manual Refresh.
- **Per-user Confluence tokens / OAuth / multi-tenant auth.** v1 is single
  deployment service account.
- **`--json` flags upstream in `confluence-adf`.** v1 parses regex over
  stable stdout lines (`<!-- applied N edit(s) ... v<old> -> v<new>
  (draft) -->` and `No changes detected.`). A `--json` contribution to
  `confluence-adf` would be a small but useful upstream improvement.
- **Unit tests for the marker validator and subprocess wrapper.** Smoke
  tests pass; the seams (`scanMarkerIds`, `validateMutationAgainstMarkers`,
  `confluence.ts` regex parsers) are pure functions ready for fixtures
  when a test runner is added to the repo.
- **Rate limits on agent endpoints.** A misbehaving agent can hammer
  `/api/notes/:id/edit`. Add a per-key throttle.

## License

MIT
