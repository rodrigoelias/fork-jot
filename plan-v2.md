# fork-jot v2 master plan — ADF as canonical buffer

Branch baseline: `claude/confluence-adf-structure-BjM37` of `rodrigoelias/fork-jot`.
v1 plan (for context): `/root/.claude/plans/we-want-to-adopt-declarative-acorn.md`.

## Premise

The v1 brief was "adopt jot's structure to edit Confluence Pages (ADF). Investigate `@atlaskit/adf-utils`." v1 shipped jot wrapped around the `confluence-adf` Python subprocess with annotated-markdown as the canonical buffer. A multi-agent critique concluded that v1 honored the editor brief but quietly redefined the data-model brief. v2 commits to ADF as the canonical model, in-process REST against Confluence v2 API, and a tree-aware CRDT — the architecturally correct interpretation of the original brief.

## Locked decisions

1. **Buffer**: ADF JSON tree, materialized on disk alongside per-block CRDT state.
2. **Block-list CRDT**: custom RGA modeled on `articulated`'s `IdList` (~300 LOC). Not `Y.XmlFragment`.
3. **Intra-block CRDT**: **Yjs `Y.Text` per text-bearing block** (paragraph, heading, list-item, blockquote, table cell, codeBlock). Marks (bold/italic/link/etc.) ride inside Y.Text deltas natively. *Locked over the alternative of reusing v1's `articulated` per-block because `articulated` has no mark CRDT.*
4. **Block IDs**: mint our own (`siteId:counter` UUID-shaped); mirror to ADF `localId` opportunistically on publish.
5. **Confluence client**: TS REST against `/wiki/api/v2/pages/*` + v1 fallback gated by env flag. Module-aliased telemetry stubs for `@atlaskit/feature-gate-js-client` and `@atlaskit/tmp-editor-statsig`.
6. **Editor surface**: UX.E hybrid — contenteditable rich-text region for paragraph/heading/list/blockquote/code; per-block "islands" with bespoke controls for panel/expand/table/taskList/layoutSection/status. Recursive `DocSurface` inside container blocks.
7. **Refresh policy**: **replace-with-snapshot** for v2.0 (mirrors v1's force-refresh snapshot at `server.ts:1659`, only the hash subject changes from markdown sha256 to ADF-canonical-hash). 3-way merge deferred to v2.1 with no commitment.
8. **Migration**: side-by-side files (`data/notes/` v1, `data/notes-v2/` v2), per-note opt-in migrate, `JOT_EDITOR_VERSION=v1|v2|hybrid` flag, `.v1bak` snapshot with 7-day undo.
9. **Comments**: new `CommentAnchor v2 = { blockId, startCharId, endCharId, quote, prefix, suffix, schemaVersion: 2 }`. Re-anchor pass at migration; orphan UI for unanchorable threads.
10. **Agent API**: `POST /api/v2/notes/:id/ops` with structured path-anchored verbs. v1 `oldText/newText` returns 409 on v2 notes.
11. **Auth**: stay with single-tenant service account (env vars `CONFLUENCE_BASE_URL`/`EMAIL`/`API_TOKEN`). OAuth deferred to v3.

## Salvage map

**Survives lift-and-shift:**
- Non-Confluence note infrastructure: auth helpers, share-link gating, comment-thread storage primitives.
- Atomic persist (`atomicWriteFileSync` server.ts:2292), `loadNotesIntoMemory` shape, `appendConfluenceHistory` 200-entry-pinned-head truncation, `describeAuthIdentity`, `sha256`.
- All policy gates: `agentEditsAllowed`/`agentCommentsAllowed` checks (~14 sites in server.ts), public-editor WS booting on flag-flip (server.ts:1511), force-refresh snapshot pattern (server.ts:1659), refresh-window WS bounce.
- Status broadcasts: `broadcastConfluencePush`/`Meta`/`Refresh` (server.ts:2059).
- All UI wrappers in `public/app.js`: `renderConfluencePanel`, import modal, conflict modal, agent-access modal, `__confluenceHandle*` WS bridges, agent-modal Confluence branches.
- CLI: `status` subcommand both modes (jot.mjs:260, 541), error-hint table (jot.mjs:56).

**DELETE — ~990 LOC of pure overhead:**

| Cluster | Files:lines | LOC |
|---|---|---|
| `MarkerScan`, `scanMarkerIds*`, `validateMutationAgainstMarkers`, `MARKER_OPEN_LITERAL`, `buildVisibleProjection` | collab.ts:216–402 | 187 |
| `buildMarkerKeySet`, `elementKeyAtIndex`, `isInsertInsideMarker`, `isDeletePartialMarker`, `visibleLengthBefore`, `visibleProjection`, `annotatedToVisible`, `visibleToAnnotated` | collab-shared.js:335–500 | 166 |
| `applyHttpEdits` cross-marker engulf guard + per-mutation validator + per-edit projection rebuild + `resolveMarkerText` | server.ts:428–443, 470–617 | ~130 |
| Editor projection cache, marker guards, paste-marker guard, marker-aware backspace, projection translation calls | collab-editor.js | ~120 |
| `recomputeMarkerIds`, `visibleMarkdown`, `broadcastMarkerIds`, `note.markerIds` plumbing, WS validator branch | server.ts (~10 sites) | ~70 |
| `ServerMarkerUpdateMessage`, `?annotated=1` branch, `marker-count-decreased` PUT guard, `set-hide-markers` history | various | ~50 |
| Subprocess wrapper: `runConfluenceCli`, `which`, `resolveConfluenceBin`, `parseFrontMatter`, `APPLY_OK_RE`, tempfile + spawn + SIGTERM machinery | confluence.ts entire | ~270 |
| **Total** | | **~990 LOC** |

## Module map

| File | v1 LOC | v2 status | New LOC | Phase |
|---|---|---|---|---|
| `src/server.ts` | 3156 | rewrite Confluence routes; mount `/api/v2/notes/*`; v1 routes preserved | +400 / −200 | A–E |
| `src/collab.ts` | 586 | gut markers; per-block CRDT scaffold | −187 / +200 | B |
| `src/confluence.ts` | 306 | delete; replaced by `src/confluence/{rest,adf,sync,verbs,errors}.ts` | −306 | A |
| `src/confluence/rest.ts` | new | REST client (auth, fetch, push, draft) | +350 | A |
| `src/confluence/adf.ts` | new | adf-utils wrappers (builders, traverse, validator, transforms, path resolver) | +400 | A–B |
| `src/confluence/sync.ts` | new | import/publish/refresh orchestration | +250 | B |
| `src/confluence/verbs.ts` | new | path-anchored mutation HTTP handlers | +500 | B |
| `src/confluence/errors.ts` | new | typed error union | +150 | A |
| `src/server-v2.ts` (or merge) | new | v2 WS protocol, hello/mutation shapes, block-CRDT host | +800 | B |
| `public/collab-shared.js` | 518 | drop marker helpers; per-block scoping | −166 / +50 | B |
| `public/collab-editor.js` | 650 | delete; replaced by `public/v2/editor.js` + region modules | −650 | C |
| `public/v2/editor.js` | new | `mountEditorV2`, `DocSurface`, `BlockView` dispatch | +600 | C |
| `public/v2/regions/{rich,code,list,table,panel,expand,task,layout,status}.js` | new | per-block-type rendering + edit affordances | +1500 | C |
| `public/v2/toolbar.js` + slash menu | new | sticky toolbar, floating selection menu, `/`-palette | +400 | C |
| `public/app.js` | 2278 | minor: status badge text changes; `onMarkerGuard` deleted | −20 / +30 | A |
| `cli/jot.mjs` | 608 | new `migrate` command; `edit` body shape changes for v2 | +60 | D |
| `package.json` | — | + `@atlaskit/adf-utils`, + `yjs`; remove Python install steps in Dockerfile | — | A |
| `Dockerfile`/`docker/` | — | drop Python venv layer | −80 LOC | E |

**Net code change: +~4500 LOC new TS/JS, −~2200 LOC v1 + ~6 kLOC Python.**

## Wire format (replaces `ClientMutation` from collab.ts:4-25)

```ts
type BlockId = string;             // siteId:counter UUID-shaped
type CharCrdtUpdate = Uint8Array;  // Y.js binary update for one Y.Doc
type AdfNode = { type: string; attrs?: Record<string, unknown>;
                 content?: AdfNode[]; marks?: AdfMark[]; text?: string };

type ClientTreeMutation =
  | { name: "block-insert";  parentId: BlockId | "__root__";
      afterBlockId: BlockId | null; blockId: BlockId; node: AdfNode;
      lamport: { siteId: string; counter: number } }
  | { name: "block-delete";  blockId: BlockId; lamport: ... }
  | { name: "block-move";    blockId: BlockId; newParentId: BlockId | "__root__";
      afterBlockId: BlockId | null; lamport: ... }
  | { name: "attr-set";      blockId: BlockId; attrPath: string[];
      value: unknown; lamport: ... };

type ClientTextMutation =
  | { name: "text-update";   blockId: BlockId; update: CharCrdtUpdate };
  // Marks (bold/link) ride inside Y.Text deltas — no separate wire op.

type ClientMutation = ClientTreeMutation | ClientTextMutation;
```

**Server validation per op:**
- `block-insert`: parent exists, parent's ADF schema admits this child type, `localId` not duplicated.
- `block-delete`: block exists; idempotent if already deleted.
- `block-move`: no cycle (walk new ancestors); destination parent admits child type.
- `attr-set`: targeted validator subset on the resulting node only.
- `text-update`: apply to per-block `Y.Doc`; reject if Yjs throws.

**Conflict rules:**
- Concurrent text-updates same block: Yjs CRDT merge — commutes.
- Concurrent `block-insert` after same `afterBlockId`: RGA tie-break by `(lamport.counter, siteId)`.
- Concurrent `block-move` of same block: LWW by Lamport.
- `block-delete` parent vs. `text-update` descendant: delete wins; descendant's text-update dropped.
- Concurrent `attr-set` on same path: LWW by Lamport.

## On-disk format (`data/notes-v2/<id>.json`)

```jsonc
{
  "id": "...", "title": "...", "shareId": "...",
  "createdAt": "...", "updatedAt": "...",
  "schemaVersion": 2,
  "tree": { /* full materialized ADF doc, with our block IDs in attrs._forkJotId */ },
  "blockOrder": {
    "__root__": [{ siteId, startCounter, count, blockIds: ["..."] }, ...],
    "<blockId-of-panel>": [...],
    "<blockId-of-table-row>": [...]
  },
  "tombstones": {
    "__root__": ["abc-3", "abc-7"]
  },
  "textCrdts": {
    "<blockId>": "<base64 Y.encodeStateAsUpdate>"
  },
  "siteCounters": { "__server__": 1234 },
  "threads": [/* CommentAnchor v2 */],
  "confluence": { ... }    // unchanged from v1 minus hideMarkers; lastPushedMarkdownSha256 -> lastPushedAdfHash
}
```

Sync write per persist, debounced 250ms; `atomicWriteFileSync` (tempfile+rename) survives.

## Confluence REST surface (`src/confluence/rest.ts`)

Class `ConfluenceClient` from `{ baseUrl, email, token }`. Basic auth. All methods take `signal?: AbortSignal` + `timeoutMs` (30s default, 60s for PUT). On 429 honor `Retry-After` (one retry).

1. `getPublished(pageId): Promise<PageSnapshot>` — `GET /wiki/api/v2/pages/{id}?body-format=atlas_doc_format`. v1 fallback `/rest/api/content/{id}?expand=body.atlas_doc_format,version` gated by env flag.
2. `getDraft(pageId): Promise<PageSnapshot | null>` — same URL `+ &status=draft`. Returns null on 404. Run `unwrapDraftLayout` (port of `fetcher.py:201–228`).
3. `hasDraft(pageId)` — `Promise.all([getPublished, getDraft])`.
4. `updatePage(args)` — `PUT /wiki/api/v2/pages/{id}` body shape from `fetcher.py:296–308`. Args: `{ pageId, adf, title, status: "current"|"draft", version: number, message? }`. Errors: 409 → `VersionConflictError`; 4xx → `RequestError`; 5xx → `FetchError`. v2 always writes drafts on agent edits; publish is a distinct verb.
5. `deleteDraft(pageId)` — port of `fetcher.py:338`.
6. `resolvePageId(input)` — port of `extract_page_id` (`fetcher.py:79–112`).
7. `publishDraft(pageId)` — composite: `getDraft` + `updatePage({status: "current"})`. Non-atomic; documented.

**Draft conflict** ≠ **version conflict**: distinct typed errors. `pushPublished` checks `getDraft()` first; if a draft exists with a different `lastEditor`, throw `DraftConflictError` unless `force`.

## Editing verb API (`/api/v2/notes/:id/...`)

Replaces v1 `oldText/newText`. Path syntax: `localId:<uuid>` preferred, `idx:N/N/N` fallback.

| Endpoint | Body | Failure modes |
|---|---|---|
| `POST /blocks` | `{ at: "<path>", position: "before"\|"after"\|"firstChild"\|"lastChild", block: <ADFNode> }` | path-not-found, schema-violation, not-a-container |
| `DELETE /blocks/:path` | — | path-not-found, not-deletable |
| `PATCH /blocks/:path` | `{ block: <ADFNode> }` | path-not-found, schema-violation, type-mismatch |
| `PATCH /blocks/:path/attrs` | `{ attrs: { ... } }` (shallow merge) | path-not-found, unknown-attr, schema-violation |
| `POST /blocks/:path/text` | `{ at: number, content: string, marks?: [...] }` | path-not-found, not-text-bearing, offset-out-of-range |
| `DELETE /blocks/:path/text` | `{ from: number, to: number }` | same |
| `POST /blocks/:path/marks` | `{ from, to, mark: {type, attrs?} }` | path-not-found, invalid-mark-on-type |
| `DELETE /blocks/:path/marks/:markType` | `{ from, to }` | path-not-found, mark-not-present |

**Sugar verbs (server-side macros):**
- `PATCH /status/:path { text, color }`
- `PATCH /task/:path { state: "DONE"|"TODO" }`
- `POST /table/:path/rows { row }` (builds via `builders.tableRow`)
- `PATCH /panel/:path { panelType }`

**Validation pipeline:** path resolve → mutate clone → `validator.validate` → 4xx on schema error → persist + CRDT op + broadcast.

## adf-utils integration

| Module | Use |
|---|---|
| `builders` | Block-creating verbs. ~15 builders wrapped in `mkBlock(kind, attrs, children)` factories. |
| `validator` | (a) per-mutation post-clone; (b) post-import; (c) pre-PUT. Three gates. `ValidationError` → 400 with `{ schemaPath, expected, got }`. |
| `traverse` | Path resolution. Helper `resolveBlockPath(doc, path) → { node, parent, indexInParent }`. |
| `transforms` | Import: `nestedTableTransform`, `dedupeMarksTransform`, `convertMediaSingleToMediaInlineTransform`. Publish: `dedupeMarksTransform` (idempotent guard). |
| `scrub` | Unused. |

Wrap everything in `src/confluence/adf.ts`; no other module imports `@atlaskit/adf-utils` directly.

## Editor UX

**Architecture: UX.E hybrid** — contenteditable for prose blocks, per-block "islands" for ADF-only structures.

```
<NoteEditorV2>
  <Toolbar />                                    // sticky: format/insert/block-type
  <DocSurface>
    <BlockView type=paragraph>     -> <RichTextRegion/>     // contenteditable=true
    <BlockView type=heading lvl=2> -> <RichTextRegion lvl/>
    <BlockView type=bulletList>    -> <ListRegion/>         // contenteditable subtree
    <BlockView type=codeBlock>     -> <CodeRegion/>         // textarea-like, no marks
    <BlockView type=panel kind>    -> <PanelIsland>
                                        <PanelTypePicker/>
                                        <DocSurface nested/>   // recursive
    <BlockView type=expand>        -> <ExpandIsland> title-input + nested DocSurface
    <BlockView type=table>         -> <TableIsland> grid, +/- row/col, cell=RichTextRegion
    <BlockView type=taskList>      -> <TaskIsland> checkbox + RichTextRegion per item
    <BlockView type=layoutSection cols=N> -> N x nested DocSurface
    <BlockView type=status>        -> inline pill (atom node inside parent RichTextRegion)
    <BlockView type=rule>          -> <hr> (atomic)
    <BlockView type=blockquote>    -> nested DocSurface
    <PassthroughBlock>             -> read-only chip ("media", "extension", "card")
  <PresenceLayer />                              // overlays per-block remote carets
  <CommentGutter />                              // right-rail thread markers
```

**Toolbar:** sticky top (block-type dropdown, marks, insert menu, move arrows). **Floating menu** on text selection (marks + link + comment). **Slash palette** invoked by `/` (panel/h1-h3/table/task/expand/status/code/divider/layout).

**Keybindings:** Cmd-B/I/U/Shift-X/E (code), Cmd-K (link), Cmd-Alt-1/2/3 (heading), Cmd-Shift-7/8/9 (ordered/bullet/task), Cmd-Shift-C (codeBlock), Cmd-Shift-. (blockquote), Tab/Shift-Tab (list nest), Cmd-Enter (exit block), Cmd-Shift-Up/Down (move block), Cmd-/ (slash menu), Cmd-Alt-M (comment).

## First-class ADF nodes in v2.0

paragraph, heading 1-6, bulletList, orderedList, taskList/taskItem, codeBlock, blockquote, panel, expand, status (inline), table/tableRow/tableCell, layoutSection/layoutColumn (1/2/3 col only), rule, hardBreak, marks (strong, em, code, link, strike, underline, subsup, textColor).

**Passthrough (preserved on round-trip, not authorable in v2.0):** mediaSingle/media/mediaGroup, extension/inlineExtension/bodiedExtension, blockCard/inlineCard/embedCard, mention, emoji, date, decisionList/decisionItem, nestedExpand.

## Phased delivery

| Phase | Weeks | Scope | Cutover |
|---|---|---|---|
| **A. Reads in TS** | 0–2 | `src/confluence/rest.ts` (`getPublished`, `getDraft`, `hasDraft`). Replace v1 `renderAnnotated`/`hasDraft` callers. v1 buffer untouched. Module-alias telemetry stubs. | Pure refactor — no flag needed |
| **B. v2 server core** | 2–8 | New CRDT (block RGA + Yjs leaves), v2 wire protocol, `/api/v2/notes/*` routes, path-anchored ops, validator gates, persistence (`data/notes-v2/`). v1 server unchanged. | All v2 verbs round-trip a 5000-node test corpus identically |
| **C. v2 editor** | 8–14 | `public/v2/editor.js` + region modules + toolbar/slash. Comment v2 anchors. Per-note "Migrate to v2" button. | Owner can edit panel/expand/table/status/task on a real Confluence page |
| **D. Shadow + flip** | 14–17 | Shadow mode: every Publish runs both engines on a clone, diffs canonical-sorted ADF, logs divergences to `data/shadow-divergences/`. Flip default to TS once divergence rate < 0.5% over 7 days. CLI `migrate` command. v1 edit endpoints emit `Deprecation` headers. | 7 days <0.5% divergence |
| **E. Drop v1** | 17–20 | Remove `confluence-adf` Python wrapper, drop Dockerfile Python layer, remove v1 markdown-projection code paths from server.ts (legacy notes still read; new edits forbidden). | Migrated note count > 95% of active |

Total: **~16–20 calendar weeks single-engineer.**

## v2.0 must-ship checklist

1. **Block-CRDT server** — block-list RGA + Yjs `Y.Text` per text leaf; persisted as materialized ADF + base64 Y.Doc snapshots; debounced 250 ms persist.
2. **Hybrid editor frontend** — contenteditable for paragraph/heading/list/blockquote/code; islands for panel/expand/table/taskList/layoutSection/status/rule; status renders inline.
3. **First-class ADF coverage + passthrough** — author the v2.0 set; round-trip the passthrough set unchanged.
4. **Toolbar + floating menu + slash palette** with the keybinding table above.
5. **Comments v2 + migration re-anchor** — new `CommentAnchor v2`; orphan UI for unanchorable threads.
6. **In-process Confluence REST** — fetch + draft + publish working for the v2 verbs against a real Cloud instance.
7. **Migration tooling** — per-note "Migrate" button, `.v1bak` snapshot + 7-day undo, `jot migrate <id>` CLI, deprecation headers.

## Deferred to v2.1+

Mobile authoring (read/comment only in v2.0); media authoring + alt-text; macros/extensions UI; mention/emoji autocomplete; char-precision remote cursors (block-precision in v2.0); offline editing; nestedExpand depth >1; collaborative undo (per-peer local in v2.0); table column resize; decisionList authoring; 3-way merge on refresh; OAuth/multi-tenant; per-user Confluence tokens.

## Dependencies

**Add:**
- `@atlaskit/adf-utils@^19.29` (Apache-2.0, ~140 transitive packages, ~37 MB). No production React peer.
- `yjs@^13` (MIT, ~30 KB gzipped). Do NOT use `Y.XmlFragment` — block-list RGA is ours.

**Remove (Phase E):**
- `confluence-adf` Python venv from deploy image.

**Sandboxing strategy** (mandatory before Phase A merges):
1. `package.json` `imports` map redirects `@atlaskit/feature-gate-js-client` and `@atlaskit/tmp-editor-statsig` to local stubs in `src/vendor/` returning offline defaults.
2. CI test `docker run --network=none` confirms no egress on `adf-utils` import.
3. Pinned versions in package-lock; reaudit on bump.
4. Optional `JOT_AIRGAP=1` runs validator in `worker_threads` Worker with `undici` agent that throws on outbound.

## Risk register

| # | Risk | Prob | Mitigation |
|---|---|---|---|
| 1 | TS port of ADF↔markdown converter has subtle divergences from Python | High | Shadow mode (Phase D). Regression corpus of 50+ real pages. Hard cap: if divergence stays >1% after 3 weeks of shadow, abandon. |
| 2 | `@atlaskit/feature-gate-js-client` egress on import | Medium | Module aliasing + airgap CI test. Pin versions; reaudit on bump. |
| 3 | Block-CRDT cycle / move-conflict semantics surprise users | Medium | LWW-by-Lamport for moves; reject cycle-creating moves with `move-rejected` broadcast and client-side rollback. |
| 4 | Yjs persistence growth (tombstones unbounded) | Medium | Periodic GC of tombstones older than min-known-Lamport; defer until proven bottleneck. |
| 5 | Editor UX scope creep blocks ship | High | v2.0 cut list is non-negotiable; mobile authoring, media, autocompletes are out. Only the 6 checklist items ship. |
| 6 | Draft handshake race | Medium | Idempotent retry on 409 by re-reading draft version once, plus per-`pageId` mutex in `ConfluenceClient`. |
| 7 | Schema drift (new ADF nodes) | High | Import-time `validator` runs in permissive mode (log + admit unknown nodes as opaque); publish-time runs strict. Track `unknown-node` events; bump `adf-utils` quarterly. |

## Comments migration semantics

At Phase-C migration time, for each v1 `CommentThread` in `note.threads`:

1. Compute `visibleMarkdown` offset → ADF block by walking the importer's offset map.
2. Search the target block's text for `quote`. If unique, anchor to `(blockId, startCharId, endCharId)`.
3. If duplicates, prefer the one whose `prefix` matches; tiebreak by closest source offset.
4. If the quote spans block boundaries, split at the boundary and anchor to the longer fragment; record `quoteSplit: true`.
5. If no match (text was in a marker run that ADF dropped, or in an unauthorable passthrough), set `orphaned: true`. UI surfaces orphans in a "Detached comments (N)" expander next to the note title.

Expected success: ~98% on plain prose; ~70% in marker runs.

## Authority model

Unchanged from v1:
- Owner password / owner API key: full control.
- Share link `edit`: edits server-side jot copy; never gets Publish/Refresh.
- Agent (API key, share-link) on Confluence-bound notes: gated by per-note `agentEditsAllowed` / `agentCommentsAllowed`. Default off.
- Publish/Refresh/Import/Toggle-flags/Migrate: owner-only.

Confluence service account stays single-tenant via env vars.

## Open follow-ups (not blockers)

- Define ADF-canonical-hash algorithm (stable JSON key order + canonical mark stacking). Needed for `hasUnpushedEdits` and Phase D shadow-mode diff.
- Decide whether `JOT_CONFLUENCE_V1_FALLBACK=1` (REST v1 endpoint fallback) ships default-on or default-off in Phase A. Recommend default-on through Phase B, default-off Phase C+.
- Build the regression corpus for Phase D shadow-mode: 50+ real Confluence pages spanning every ADF node type in v2.0's first-class set.

---

**Status: locked. Phase A is the safest entry point — read-only refactor, no behavior change for users, ~2 weeks single-engineer.**
