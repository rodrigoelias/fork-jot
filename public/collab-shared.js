function cloneId(id) {
  return id ? { bunchId: id.bunchId, counter: id.counter } : null;
}

function idsEqual(a, b) {
  return !!a && !!b && a.bunchId === b.bunchId && a.counter === b.counter;
}

export class SimpleIdList {
  constructor(entries = []) {
    this.entries = entries;
    this.length = 0;
    for (const entry of entries) {
      if (!entry.isDeleted) {
        this.length++;
      }
    }
  }

  static load(savedState) {
    const entries = [];
    for (const item of savedState || []) {
      for (let offset = 0; offset < item.count; offset++) {
        entries.push({
          id: { bunchId: item.bunchId, counter: item.startCounter + offset },
          isDeleted: Boolean(item.isDeleted),
        });
      }
    }
    return new SimpleIdList(entries);
  }

  clone() {
    return new SimpleIdList(this.entries.map((entry) => ({ id: cloneId(entry.id), isDeleted: entry.isDeleted })));
  }

  findKnownIndex(id) {
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (idsEqual(entry.id, id)) {
        return index;
      }
    }
    return -1;
  }

  has(id) {
    const knownIndex = this.findKnownIndex(id);
    return knownIndex !== -1 && !this.entries[knownIndex].isDeleted;
  }

  isKnown(id) {
    return this.findKnownIndex(id) !== -1;
  }

  at(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`Index out of bounds: ${index}`);
    }
    let visibleIndex = 0;
    for (const entry of this.entries) {
      if (entry.isDeleted) {
        continue;
      }
      if (visibleIndex === index) {
        return cloneId(entry.id);
      }
      visibleIndex++;
    }
    throw new Error(`Index out of bounds: ${index}`);
  }

  indexOf(id, bias = "none") {
    const knownIndex = this.findKnownIndex(id);
    if (knownIndex === -1) {
      throw new Error("id is not known");
    }

    let visibleBefore = 0;
    for (let index = 0; index < knownIndex; index++) {
      if (!this.entries[index].isDeleted) {
        visibleBefore++;
      }
    }

    if (!this.entries[knownIndex].isDeleted) {
      return visibleBefore;
    }

    if (bias === "left") {
      return visibleBefore - 1;
    }
    if (bias === "right") {
      return visibleBefore;
    }
    return -1;
  }

  cursorAt(index, bind = "left") {
    if (!Number.isInteger(index) || index < 0 || index > this.length) {
      throw new Error(`Cursor index out of bounds: ${index}`);
    }
    if (bind === "left") {
      return index === 0 ? null : this.at(index - 1);
    }
    return index === this.length ? null : this.at(index);
  }

  cursorIndex(cursor, bind = "left") {
    if (bind === "left") {
      return cursor === null ? 0 : this.indexOf(cursor, "left") + 1;
    }
    return cursor === null ? this.length : this.indexOf(cursor, "right");
  }

  maxCounter(bunchId) {
    let max;
    for (const entry of this.entries) {
      if (entry.id.bunchId === bunchId) {
        if (max === undefined || entry.id.counter > max) {
          max = entry.id.counter;
        }
      }
    }
    return max;
  }

  insertAfter(before, startId, count = 1) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid count: ${count}`);
    }
    if (count === 0) {
      return;
    }

    let insertAt = 0;
    if (before !== null) {
      const knownIndex = this.findKnownIndex(before);
      if (knownIndex === -1) {
        throw new Error("before is not known");
      }
      insertAt = knownIndex + 1;
    }

    const inserted = [];
    for (let offset = 0; offset < count; offset++) {
      inserted.push({
        id: { bunchId: startId.bunchId, counter: startId.counter + offset },
        isDeleted: false,
      });
    }
    this.entries.splice(insertAt, 0, ...inserted);
    this.length += count;
  }

  deleteRange(startIndex, endIndex) {
    if (endIndex < startIndex) {
      return;
    }
    const knownIndexes = [];
    let visibleIndex = 0;
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (entry.isDeleted) {
        continue;
      }
      if (visibleIndex >= startIndex && visibleIndex <= endIndex) {
        knownIndexes.push(index);
      }
      visibleIndex++;
      if (visibleIndex > endIndex) {
        break;
      }
    }

    for (const knownIndex of knownIndexes) {
      if (!this.entries[knownIndex].isDeleted) {
        this.entries[knownIndex] = { ...this.entries[knownIndex], isDeleted: true };
        this.length--;
      }
    }
  }
}

export class TrackedIdList {
  constructor(idList, trackChanges) {
    this._idList = idList;
    this.trackChanges = trackChanges;
    this.updates = [];
  }

  get idList() {
    return this._idList;
  }

  getAndResetUpdates() {
    if (!this.trackChanges) {
      throw new Error("trackChanges not enabled");
    }
    const updates = this.updates;
    this.updates = [];
    return updates;
  }

  insertAfter(before, id, count = 1) {
    this._idList.insertAfter(before, id, count);
    if (this.trackChanges) {
      this.updates.push({ type: "insertAfter", before: cloneId(before), id: cloneId(id), count });
    }
  }

  deleteRange(startIndex, endIndex) {
    this._idList.deleteRange(startIndex, endIndex);
    if (this.trackChanges) {
      this.updates.push({ type: "deleteRange", startIndex, endIndex });
    }
  }

  apply(update) {
    switch (update.type) {
      case "insertAfter":
        this._idList.insertAfter(update.before, update.id, update.count);
        return;
      case "deleteRange":
        this._idList.deleteRange(update.startIndex, update.endIndex);
        return;
    }
  }
}

export class ElementIdGenerator {
  constructor(newBunchId) {
    this.newBunchId = newBunchId;
    this.nextCounterMap = new Map();
  }

  generateAfter(beforeId, count = 1) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid count: ${count}`);
    }

    if (beforeId) {
      const nextCounter = this.nextCounterMap.get(beforeId.bunchId) || 0;
      if (beforeId.counter + 1 >= nextCounter) {
        const counter = beforeId.counter + 1;
        this.nextCounterMap.set(beforeId.bunchId, counter + count);
        return { bunchId: beforeId.bunchId, counter };
      }
    }

    const bunchId = this.newBunchId();
    this.nextCounterMap.set(bunchId, count);
    return { bunchId, counter: 0 };
  }
}

export function applyClientMutation(state, mutation) {
  const trackedIds = new TrackedIdList(state.idList.clone(), false);

  if (mutation.name === "insert") {
    const { before, id, content, isInWord } = mutation.args;
    if (!content) {
      return state;
    }
    if (before !== null && !trackedIds.idList.isKnown(before)) {
      return state;
    }
    if (trackedIds.idList.isKnown(id)) {
      return state;
    }
    if (isInWord && before !== null && !trackedIds.idList.has(before)) {
      return state;
    }

    trackedIds.insertAfter(before, id, content.length);
    const insertIndex = before === null ? 0 : trackedIds.idList.indexOf(id);
    return {
      text: state.text.slice(0, insertIndex) + content + state.text.slice(insertIndex),
      idList: trackedIds.idList,
    };
  }

  const { startId, endId, contentLength } = mutation.args;
  if (!trackedIds.idList.isKnown(startId)) {
    return state;
  }

  const startIndex = trackedIds.idList.indexOf(startId, "right");
  const endIndex = endId === undefined
    ? startIndex
    : trackedIds.idList.isKnown(endId)
      ? trackedIds.idList.indexOf(endId, "left")
      : startIndex - 1;

  if (endIndex < startIndex) {
    return state;
  }

  const currentLength = endIndex - startIndex + 1;
  if (contentLength !== undefined && currentLength > contentLength + 10) {
    return state;
  }

  trackedIds.deleteRange(startIndex, endIndex);
  return {
    text: state.text.slice(0, startIndex) + state.text.slice(endIndex + 1),
    idList: trackedIds.idList,
  };
}

export function applyIdListUpdates(idList, updates) {
  const trackedIds = new TrackedIdList(idList.clone(), false);
  for (const update of updates) {
    trackedIds.apply(update);
  }
  return trackedIds.idList;
}

export function selectionToIds(idList, start, end, direction = "forward") {
  if (start === end) {
    return {
      type: "cursor",
      cursor: idList.cursorAt(start, "left"),
    };
  }

  return {
    type: "range",
    start: idList.cursorAt(start, "right"),
    end: idList.cursorAt(end, "left"),
    direction: direction === "backward" ? "backward" : "forward",
  };
}

// Confluence marker helpers. For Confluence-bound notes the buffer carries
// `<!-- @path:... -->` markers. The server tells us which ElementIds are
// inside a marker run via hello.markerCharKeys / marker-ids messages. These
// helpers let the editor (and any future visible-projection layer) detect
// inside-marker positions and translate full-buffer offsets into a marker-
// stripped projection.

export function buildMarkerKeySet(markerCharKeys) {
  const set = new Set();
  if (Array.isArray(markerCharKeys)) {
    for (const key of markerCharKeys) {
      if (typeof key === "string") set.add(key);
    }
  }
  return set;
}

function elementKeyAtIndex(idList, index) {
  if (index < 0 || index >= idList.length) return null;
  const id = idList.at(index);
  return id ? `${id.bunchId}:${id.counter}` : null;
}

// True when an insert at `insertIndex` (full-buffer offset, equal to the
// number of chars to the left of the insertion point) would land strictly
// inside a marker run — i.e. both the char immediately before AND the char
// immediately after the insertion point belong to the same marker run.
// Boundary inserts (just before "<!--" or just after "-->") are allowed.
export function isInsertInsideMarker(markerKeys, idList, insertIndex) {
  if (!markerKeys || markerKeys.size === 0) return false;
  const beforeKey = insertIndex > 0 ? elementKeyAtIndex(idList, insertIndex - 1) : null;
  if (!beforeKey || !markerKeys.has(beforeKey)) return false;
  const afterKey = insertIndex < idList.length ? elementKeyAtIndex(idList, insertIndex) : null;
  if (!afterKey || !markerKeys.has(afterKey)) return false;
  return true;
}

// True when the half-open delete range [start, end) would split a marker run
// (overlap that is neither empty nor whole-run).
export function isDeletePartialMarker(markerKeys, idList, startIndex, endIndex) {
  if (!markerKeys || markerKeys.size === 0) return false;
  if (endIndex <= startIndex) return false;
  for (let i = startIndex; i < endIndex; i++) {
    const key = elementKeyAtIndex(idList, i);
    if (!key || !markerKeys.has(key)) continue;
    let runStart = i;
    while (runStart > 0) {
      const prevKey = elementKeyAtIndex(idList, runStart - 1);
      if (!prevKey || !markerKeys.has(prevKey)) break;
      runStart--;
    }
    let runEnd = i;
    while (runEnd + 1 < idList.length) {
      const nextKey = elementKeyAtIndex(idList, runEnd + 1);
      if (!nextKey || !markerKeys.has(nextKey)) break;
      runEnd++;
    }
    if (runStart < startIndex || runEnd >= endIndex) return true;
    i = runEnd;
  }
  return false;
}

// Visible-projection helpers (kept here so any future projected-render layer
// can share them). Each helper walks the idList honoring deleted entries.
export function visibleLengthBefore(markerKeys, idList, fullIndex) {
  if (!markerKeys || markerKeys.size === 0) return Math.max(0, Math.min(fullIndex, idList.length));
  const max = Math.min(fullIndex, idList.length);
  let visible = 0;
  for (let i = 0; i < max; i++) {
    const key = elementKeyAtIndex(idList, i);
    if (!key || !markerKeys.has(key)) visible++;
  }
  return visible;
}

// Build the marker-stripped projection of an IdList + text pair.
//
// Returns {
//   visibleText: string,
//   visibleToFull: number[],   // visibleToFull[k] = annotated idx of k-th visible char
//                              // length is visibleText.length + 1; last entry = annotated.length
//                              // (so a cursor at end-of-visible maps to end-of-annotated)
//   fullToVisible: number[],   // fullToVisible[i] = visible offset just before annotated idx i
//                              // length is annotated.length + 1 (to support cursor-at-end)
// }
//
// When markerKeys is empty (or undefined), returns identity maps so non-Confluence
// notes pay zero translation cost beyond a single O(N) walk.
export function visibleProjection(idList, text, markerKeys) {
  const annotatedLength = idList.length;
  const isIdentity = !markerKeys || markerKeys.size === 0;

  if (isIdentity) {
    const visibleToFull = new Array(annotatedLength + 1);
    const fullToVisible = new Array(annotatedLength + 1);
    for (let i = 0; i <= annotatedLength; i++) {
      visibleToFull[i] = i;
      fullToVisible[i] = i;
    }
    return { visibleText: text, visibleToFull, fullToVisible };
  }

  const visibleChars = [];
  const visibleToFull = [];
  const fullToVisible = new Array(annotatedLength + 1);
  let visIdx = 0;
  // Walk entries directly to keep this O(N). idList.entries is the SimpleIdList
  // backing array (with isDeleted entries interleaved); skip deleted entries to
  // align with annotated indices.
  let i = 0;
  const entries = idList.entries;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry.isDeleted) continue;
      fullToVisible[i] = visIdx;
      const key = `${entry.id.bunchId}:${entry.id.counter}`;
      if (!markerKeys.has(key)) {
        visibleChars.push(text[i]);
        visibleToFull.push(i);
        visIdx++;
      }
      i++;
    }
  } else {
    // Fallback: walk by .at() (O(N²) but correct).
    for (; i < annotatedLength; i++) {
      fullToVisible[i] = visIdx;
      const id = idList.at(i);
      const key = `${id.bunchId}:${id.counter}`;
      if (!markerKeys.has(key)) {
        visibleChars.push(text[i]);
        visibleToFull.push(i);
        visIdx++;
      }
    }
  }
  fullToVisible[annotatedLength] = visIdx;
  visibleToFull.push(annotatedLength);

  return {
    visibleText: visibleChars.join(""),
    visibleToFull,
    fullToVisible,
  };
}

// Translate annotated offset → visible offset.
export function annotatedToVisible(maps, fullIndex) {
  const i = Math.max(0, Math.min(fullIndex, maps.fullToVisible.length - 1));
  return maps.fullToVisible[i];
}

// Translate visible offset → annotated offset.
// bias="right" returns the annotated index of the visible char at visIndex
// (or end-of-annotated if visIndex === visibleLength). bias="left" snaps a
// visible-end-of-selection to "just after the previous visible char."
export function visibleToAnnotated(maps, visIndex, bias = "right") {
  const len = maps.visibleToFull.length - 1; // last entry is end-sentinel
  const v = Math.max(0, Math.min(visIndex, len));
  if (bias === "left") {
    if (v === 0) return maps.visibleToFull[0] ?? 0;
    return maps.visibleToFull[v - 1] + 1;
  }
  return maps.visibleToFull[v];
}

export function selectionFromIds(selection, idList) {
  try {
    if (selection.type === "cursor") {
      const index = idList.cursorIndex(selection.cursor, "left");
      return { start: index, end: index, direction: "none" };
    }

    const start = idList.cursorIndex(selection.start, "right");
    const end = idList.cursorIndex(selection.end, "left");
    if (selection.direction === "backward") {
      return { start, end, direction: "backward" };
    }
    return { start, end, direction: "forward" };
  } catch {
    return { start: 0, end: 0, direction: "none" };
  }
}
