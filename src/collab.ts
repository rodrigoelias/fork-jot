import crypto from "node:crypto";
import { IdList, type ElementId, type SavedIdList } from "articulated";

export type ClientInsertMutation = {
  name: "insert";
  args: {
    before: ElementId | null;
    id: ElementId;
    content: string;
    isInWord: boolean;
  };
  clientCounter: number;
};

export type ClientDeleteMutation = {
  name: "delete";
  args: {
    startId: ElementId;
    endId?: ElementId;
    contentLength?: number;
  };
  clientCounter: number;
};

export type ClientMutation = ClientInsertMutation | ClientDeleteMutation;

export type ClientMutationMessage = {
  type: "mutation";
  clientId: string;
  mutations: ClientMutation[];
};

export type IdListUpdate =
  | {
      type: "insertAfter";
      before: ElementId | null;
      id: ElementId;
      count: number;
    }
  | {
      type: "deleteRange";
      startIndex: number;
      endIndex: number;
    };

export type ConfluenceBindingPublic = {
  pageId: string;
  baseUrl: string;
  importedAt: string;
  lastKnownPublishedVersion: number;
  lastKnownDraftVersion: number | null;
  lastPushedAt: string | null;
  lastPushStatus: "idle" | "pushing" | "pushed" | "conflict" | "error";
  lastPushError: string | null;
  agentEditsAllowed: boolean;
  agentCommentsAllowed: boolean;
  hasUnpushedEdits: boolean;
};

export type ServerHelloMessage = {
  type: "hello";
  clientId?: string;
  noteId: string;
  title: string;
  shareId: string;
  markdown: string;
  idListState: SavedIdList;
  serverCounter: number;
  confluence?: ConfluenceBindingPublic;
  markerCharKeys?: string[];
};

export type ServerConfluencePushMessage = {
  type: "confluence-push";
  noteId: string;
  pageId: string;
  status: "pushing" | "pushed" | "conflict" | "error";
  oldVersion?: number;
  newVersion?: number;
  appliedCount?: number;
  lastPushedAt?: string;
  errorKind?: "fetch-conflict" | "draft-conflict" | "config" | "crash";
  errorMessage?: string;
};

export type ServerConfluenceRefreshMessage = {
  type: "confluence-refresh";
  noteId: string;
  pageId: string;
};

export type ServerConfluenceMetaMessage = {
  type: "confluence-meta";
  noteId: string;
  confluence: ConfluenceBindingPublic;
};

export type ServerMarkerUpdateMessage = {
  type: "marker-ids";
  noteId: string;
  markerCharKeys: string[];
};

export type ServerMutationMessage = {
  type: "mutation";
  senderId: string;
  senderCounter: number;
  serverCounter: number;
  markdown: string;
  idListUpdates: IdListUpdate[];
};

export type PresenceSelection =
  | { type: "cursor"; cursor: { bunchId: string; counter: number } | null }
  | { type: "range"; start: { bunchId: string; counter: number } | null; end: { bunchId: string; counter: number } | null; direction: "forward" | "backward" };

export type ClientPresenceMessage = {
  type: "presence";
  clientId: string;
  selection: PresenceSelection;
};

export type ServerPresenceMessage = {
  type: "presence";
  clientId: string;
  name: string;
  color: string;
  selection: PresenceSelection;
};

export type ServerPresenceLeaveMessage = {
  type: "presence-leave";
  clientId: string;
};

export type SavedCharBunch = {
  bunchId: string;
  startCounter: number;
  chars: string;
};

export type SavedCollabState = {
  idListState: SavedIdList;
  chars: SavedCharBunch[];
  serverCounter: number;
};

export type CollabState = {
  idList: IdList;
  chars: Map<string, string>;
  serverCounter: number;
};

export class TrackedIdList {
  private _idList: IdList;
  private updates: IdListUpdate[] = [];

  constructor(idList: IdList, readonly trackChanges: boolean) {
    this._idList = idList;
  }

  get idList(): IdList {
    return this._idList;
  }

  getAndResetUpdates(): IdListUpdate[] {
    if (!this.trackChanges) {
      throw new Error("trackChanges not enabled");
    }
    const updates = this.updates;
    this.updates = [];
    return updates;
  }

  insertAfter(before: ElementId | null, newId: ElementId, count = 1) {
    this._idList = this._idList.insertAfter(before, newId, count);
    if (this.trackChanges) {
      this.updates.push({ type: "insertAfter", before, id: newId, count });
    }
  }

  deleteRange(startIndex: number, endIndex: number) {
    const ids: ElementId[] = [];
    for (let index = startIndex; index <= endIndex; index++) {
      ids.push(this._idList.at(index));
    }
    for (const id of ids) {
      this._idList = this._idList.delete(id);
    }
    if (this.trackChanges) {
      this.updates.push({ type: "deleteRange", startIndex, endIndex });
    }
  }

  apply(update: IdListUpdate) {
    switch (update.type) {
      case "insertAfter":
        this._idList = this._idList.insertAfter(update.before, update.id, update.count);
        return;
      case "deleteRange":
        this.deleteRange(update.startIndex, update.endIndex);
        if (!this.trackChanges) {
          return;
        }
        this.updates.pop();
        return;
    }
  }
}

export function charKey(id: ElementId) {
  return `${id.bunchId}:${id.counter}`;
}

// Scan the live buffer for `<!-- @path:...-->` regions and return the set of
// charKeys that fall inside any marker (including the opening "<!-- @path:" and
// the closing "-->"). Used by both the server-side mutation validator and the
// client-side render layer.
export function scanMarkerIds(state: CollabState): Set<string> {
  const result = new Set<string>();
  const ids: ElementId[] = [];
  const text: string[] = [];
  for (const id of state.idList.values()) {
    const ch = state.chars.get(charKey(id));
    if (ch !== undefined) {
      ids.push(id);
      text.push(ch);
    }
  }
  const joined = text.join("");
  const re = /<!--\s*@path:[^]*?-->/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(joined)) !== null) {
    for (let i = match.index; i < match.index + match[0].length; i++) {
      result.add(charKey(ids[i]));
    }
  }
  return result;
}

// Build the marker-stripped visible projection together with a mapping from
// visible-string offsets back to annotated-buffer offsets (the index space
// used by the IdList). Used by HTTP /edit to match agent-supplied oldText
// against the same view the agent reads via GET /api/notes/:id.
export function buildVisibleProjection(
  state: CollabState,
  markerIds: Set<string>,
): { visible: string; visibleToAnnotated: number[] } {
  const visibleChars: string[] = [];
  const visibleToAnnotated: number[] = [];
  let annotatedIdx = 0;
  for (const id of state.idList.values()) {
    const ch = state.chars.get(`${id.bunchId}:${id.counter}`);
    if (ch !== undefined) {
      if (!markerIds.has(`${id.bunchId}:${id.counter}`)) {
        visibleChars.push(ch);
        visibleToAnnotated.push(annotatedIdx);
      }
    }
    annotatedIdx++;
  }
  return { visible: visibleChars.join(""), visibleToAnnotated };
}

export const MARKER_OPEN_LITERAL = "<!-- @path:";

export type MarkerValidationResult =
  | { ok: true }
  | { ok: false; reason: "insert-inside-marker" | "delete-partial-overlap" | "insert-contains-marker"; markerCharKey?: string };

// Validate a single mutation against the current marker set. Mutations that
// would corrupt a `<!-- @path:... -->` region are rejected.
//
// Boundary semantics: for an insert, "before" is the id immediately to the
// left of the insertion point. The insertion is allowed when "before" sits at
// the LAST char of a marker (insert lands just after the closing "-->") or
// when the FIRST char following the insertion point is the start of a marker
// (insert lands just before "<!--"). Insertions whose `before` lies within a
// marker run AND the next char also belongs to the same marker run are the
// only "strictly inside" case — those are rejected.
export function validateMutationAgainstMarkers(
  state: CollabState,
  mutation: ClientMutation,
  markerIds: Set<string>,
): MarkerValidationResult {
  if (markerIds.size === 0) return { ok: true };

  if (mutation.name === "insert") {
    if (typeof mutation.args.content === "string" && mutation.args.content.includes(MARKER_OPEN_LITERAL)) {
      return { ok: false, reason: "insert-contains-marker" };
    }
    const { before } = mutation.args;
    if (before === null) return { ok: true };
    if (!state.idList.isKnown(before) || !state.idList.has(before)) return { ok: true };
    const beforeKey = charKey(before);
    if (!markerIds.has(beforeKey)) return { ok: true };
    // `before` is inside a marker run. Find the next live id and check if it
    // also belongs to the same marker (i.e. we are strictly inside).
    let beforeIndex: number;
    try {
      beforeIndex = state.idList.indexOf(before, "left");
    } catch {
      return { ok: true };
    }
    if (beforeIndex < 0) return { ok: true };
    const total = visibleLength(state);
    if (beforeIndex + 1 >= total) {
      // Marker is at the very end of the document — boundary insert allowed.
      return { ok: true };
    }
    const nextId = state.idList.at(beforeIndex + 1);
    const nextKey = charKey(nextId);
    if (!markerIds.has(nextKey)) {
      // Next char is outside any marker → insert at run boundary, allow.
      return { ok: true };
    }
    return { ok: false, reason: "insert-inside-marker", markerCharKey: beforeKey };
  }

  // Delete: a marker run must be deleted whole-or-not-at-all.
  const { startId, endId } = mutation.args;
  if (!state.idList.isKnown(startId)) return { ok: true };

  let startIndex: number;
  try {
    startIndex = state.idList.indexOf(startId, "right");
  } catch {
    return { ok: true };
  }
  let endIndex: number;
  if (endId === undefined) {
    endIndex = startIndex;
  } else if (state.idList.isKnown(endId)) {
    try {
      endIndex = state.idList.indexOf(endId, "left");
    } catch {
      endIndex = startIndex - 1;
    }
  } else {
    endIndex = startIndex - 1;
  }
  if (endIndex < startIndex) return { ok: true };

  const visibleTotal = visibleLength(state);
  // Walk all chars in [startIndex, endIndex]. For each marker run that
  // overlaps the range, ensure the entire run is contained in the range.
  for (let i = startIndex; i <= endIndex && i < visibleTotal; i++) {
    const key = charKey(state.idList.at(i));
    if (!markerIds.has(key)) continue;
    // Walk the marker run forward and backward from i; the entire run must
    // lie within [startIndex, endIndex].
    let runStart = i;
    while (runStart > 0 && markerIds.has(charKey(state.idList.at(runStart - 1)))) {
      runStart--;
    }
    let runEnd = i;
    while (runEnd + 1 < visibleTotal && markerIds.has(charKey(state.idList.at(runEnd + 1)))) {
      runEnd++;
    }
    if (runStart < startIndex || runEnd > endIndex) {
      return { ok: false, reason: "delete-partial-overlap", markerCharKey: key };
    }
    // Skip ahead to the end of this run.
    i = runEnd;
  }
  return { ok: true };
}

function visibleLength(state: CollabState): number {
  let n = 0;
  for (const _ of state.idList.values()) n++;
  return n;
}

export function newCollabState(): CollabState {
  return {
    idList: IdList.new(),
    chars: new Map(),
    serverCounter: 0,
  };
}

export function collabFromMarkdown(markdown: string, serverCounter = 0): CollabState {
  if (!markdown) {
    return {
      idList: IdList.new(),
      chars: new Map(),
      serverCounter,
    };
  }

  const bunchId = crypto.randomUUID();
  const startId: ElementId = { bunchId, counter: 0 };
  const idList = IdList.new().insertAfter(null, startId, markdown.length);
  const chars = new Map<string, string>();
  for (let index = 0; index < markdown.length; index++) {
    chars.set(charKey({ bunchId, counter: index }), markdown[index]);
  }

  return { idList, chars, serverCounter };
}

export function collabToMarkdown(state: CollabState): string {
  const parts: string[] = [];
  for (const id of state.idList.values()) {
    const char = state.chars.get(charKey(id));
    if (char !== undefined) {
      parts.push(char);
    }
  }
  return parts.join("");
}

export function saveCollabState(state: CollabState): SavedCollabState {
  const idListState = state.idList.save();
  const chars: SavedCharBunch[] = [];

  for (const item of idListState) {
    let text = "";
    for (let offset = 0; offset < item.count; offset++) {
      const id: ElementId = {
        bunchId: item.bunchId,
        counter: item.startCounter + offset,
      };
      text += state.chars.get(charKey(id)) || "\0";
    }
    chars.push({
      bunchId: item.bunchId,
      startCounter: item.startCounter,
      chars: text,
    });
  }

  return {
    idListState,
    chars,
    serverCounter: state.serverCounter,
  };
}

export function loadCollabState(saved: SavedCollabState): CollabState {
  const idList = IdList.load(saved.idListState || []);
  const chars = new Map<string, string>();

  for (const bunch of saved.chars || []) {
    for (let offset = 0; offset < bunch.chars.length; offset++) {
      const id: ElementId = {
        bunchId: bunch.bunchId,
        counter: bunch.startCounter + offset,
      };
      chars.set(charKey(id), bunch.chars[offset]);
    }
  }

  return {
    idList,
    chars,
    serverCounter: saved.serverCounter || 0,
  };
}

export function idAtIndex(state: CollabState, index: number): ElementId {
  return state.idList.at(index);
}

export function idBeforeIndex(state: CollabState, index: number): ElementId | null {
  if (index <= 0) {
    return null;
  }
  return state.idList.at(index - 1);
}

function applyInsertMutation(
  trackedIds: TrackedIdList,
  chars: Map<string, string>,
  mutation: ClientInsertMutation,
) {
  const { before, id, content, isInWord } = mutation.args;
  if (!content) {
    return;
  }
  if (before !== null && !trackedIds.idList.isKnown(before)) {
    return;
  }
  if (trackedIds.idList.isKnown(id)) {
    return;
  }
  if (isInWord && before !== null && !trackedIds.idList.has(before)) {
    return;
  }

  trackedIds.insertAfter(before, id, content.length);
  for (let offset = 0; offset < content.length; offset++) {
    chars.set(
      charKey({ bunchId: id.bunchId, counter: id.counter + offset }),
      content[offset],
    );
  }
}

function applyDeleteMutation(
  trackedIds: TrackedIdList,
  mutation: ClientDeleteMutation,
) {
  const { startId, endId, contentLength } = mutation.args;
  if (!trackedIds.idList.isKnown(startId)) {
    return;
  }

  const startIndex = trackedIds.idList.indexOf(startId, "right");
  const endIndex = endId === undefined
    ? startIndex
    : trackedIds.idList.isKnown(endId)
      ? trackedIds.idList.indexOf(endId, "left")
      : startIndex - 1;

  if (endIndex < startIndex) {
    return;
  }

  const currentLength = endIndex - startIndex + 1;
  if (contentLength !== undefined && currentLength > contentLength + 10) {
    return;
  }

  trackedIds.deleteRange(startIndex, endIndex);
}

export function applyClientMutations(state: CollabState, mutations: ClientMutation[]) {
  const trackedIds = new TrackedIdList(state.idList, true);
  const chars = new Map(state.chars);

  for (const mutation of mutations) {
    switch (mutation.name) {
      case "insert":
        applyInsertMutation(trackedIds, chars, mutation);
        break;
      case "delete":
        applyDeleteMutation(trackedIds, mutation);
        break;
    }
  }

  const idListUpdates = trackedIds.getAndResetUpdates();
  const nextState: CollabState = {
    idList: trackedIds.idList,
    chars,
    serverCounter: idListUpdates.length > 0 ? state.serverCounter + 1 : state.serverCounter,
  };

  return {
    state: nextState,
    markdown: collabToMarkdown(nextState),
    idListUpdates,
    changed: idListUpdates.length > 0,
  };
}
