import {
  SimpleIdList,
  applyClientMutation,
  applyIdListUpdates,
  buildMarkerKeySet,
  isDeletePartialMarker,
  isInsertInsideMarker,
  selectionFromIds,
  selectionToIds,
  visibleProjection,
  annotatedToVisible,
  visibleToAnnotated,
} from "./collab-shared.js";

const PRESENCE_THROTTLE_MS = 80;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PRESENCE_STALE_MS = 60000;

function isWordChar(ch) { return /[0-9A-Za-z_]/.test(ch || ""); }

function readInsertText(event) {
  if (typeof event.data === "string") return event.data;
  if (event.dataTransfer) return event.dataTransfer.getData("text/plain") || "";
  return "";
}

function clampSel(text, sel) {
  return {
    start: Math.max(0, Math.min(sel.start, text.length)),
    end: Math.max(0, Math.min(sel.end, text.length)),
    direction: sel.direction || "none",
  };
}

function wordBackward(text, cursor) {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}
function wordForward(text, cursor) {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}
function lineBackward(text, cursor) {
  let i = cursor - 1;
  while (i > 0 && text[i - 1] !== "\n") i--;
  return Math.max(0, i);
}

function buildDeleteMutation(state, start, endExcl, counter) {
  if (start < 0 || endExcl <= start || endExcl > state.text.length) return null;
  return {
    name: "delete", clientCounter: counter,
    args: { startId: state.idList.at(start), endId: state.idList.at(endExcl - 1), contentLength: endExcl - start },
  };
}

function buildInsertMutation(state, index, content, counter, newId) {
  if (!content) return null;
  const before = index === 0 ? null : state.idList.at(index - 1);
  const id = newId(before, state.idList, content.length);
  const prev = index > 0 ? state.text[index - 1] : "";
  const next = index < state.text.length ? state.text[index] : "";
  return {
    name: "insert", clientCounter: counter,
    args: { before, id, content, isInWord: isWordChar(content[0]) && (isWordChar(prev) || isWordChar(next)) },
  };
}

function replayPending(serverState, pending) {
  let s = { text: serverState.text, idList: serverState.idList.clone() };
  for (const m of pending) s = applyClientMutation(s, m);
  return s;
}

// ---- Mirror div for computing caret pixel positions in a textarea ----

function syncMirrorStyles(mirror, textarea) {
  const cs = getComputedStyle(textarea);
  const props = [
    "fontFamily","fontSize","fontWeight","fontStyle","letterSpacing","textTransform",
    "wordSpacing","textIndent","borderTopWidth","borderRightWidth","borderBottomWidth",
    "borderLeftWidth","paddingTop","paddingRight","paddingBottom","paddingLeft",
    "wordWrap","overflowWrap","whiteSpace","lineHeight","tabSize","boxSizing",
  ];
  for (const p of props) mirror.style[p] = cs[p];
  mirror.style.width = textarea.offsetWidth + "px";
}

function measureCaretPositions(textarea, mirror, indices) {
  syncMirrorStyles(mirror, textarea);
  const text = textarea.value;
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  mirror.textContent = "";
  const markers = new Map();
  let last = 0;
  for (const idx of sorted) {
    const clampedIdx = Math.max(0, Math.min(idx, text.length));
    if (clampedIdx > last) mirror.appendChild(document.createTextNode(text.substring(last, clampedIdx)));
    const span = document.createElement("span");
    span.textContent = "\u200b";
    mirror.appendChild(span);
    markers.set(idx, span);
    last = clampedIdx;
  }
  if (last < text.length) mirror.appendChild(document.createTextNode(text.substring(last)));
  if (!mirror.childNodes.length) mirror.appendChild(document.createTextNode("\u200b"));

  const result = new Map();
  for (const [idx, span] of markers) {
    result.set(idx, { top: span.offsetTop - textarea.scrollTop, left: span.offsetLeft - textarea.scrollLeft });
  }
  return result;
}

// ---- Main editor ----

export function createCollabEditor(textarea, opts) {
  const { noteId, shareId, name, onReady, onTextChange, onConnectionChange, onThreadsUpdated } = opts;
  let nextBunchIdCounter = 0;

  let ws = null;
  let destroyed = false;
  let programmatic = false;
  let initialized = false;
  let connected = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  let nextClientCounter = 1;
  let clientId = null;

  let serverState = { text: "", idList: new SimpleIdList() };
  let currentState = { text: "", idList: new SimpleIdList() };
  let pendingMutations = [];
  let markerKeys = new Set();
  let confluenceMeta = null;
  let projection = null; // { visibleText, visibleToFull, fullToVisible }

  function ensureProjection() {
    if (!projection) {
      const keys = isHidingMarkers() ? markerKeys : new Set();
      projection = visibleProjection(currentState.idList, currentState.text, keys);
    }
    return projection;
  }

  function invalidateProjection() {
    projection = null;
  }

  function isHidingMarkers() {
    // Hide only when the binding asks for it. Default true.
    return Boolean(confluenceMeta && confluenceMeta.hideMarkers !== false && markerKeys.size > 0);
  }

  // Remote presence
  const remoteCursors = new Map(); // clientId -> { name, color, selection, lastUpdate }

  // DOM elements for cursor overlay and mirror
  const container = textarea.parentElement;
  container.style.position = "relative";

  const overlay = document.createElement("div");
  overlay.className = "cursor-overlay";
  container.appendChild(overlay);

  const mirror = document.createElement("div");
  mirror.className = "textarea-mirror";
  mirror.style.cssText = "position:absolute;visibility:hidden;overflow:hidden;white-space:pre-wrap;word-wrap:break-word;pointer-events:none;";
  container.appendChild(mirror);

  let resizeObserver = null;
  try {
    resizeObserver = new ResizeObserver(() => renderRemoteCursors());
    resizeObserver.observe(textarea);
  } catch {}

  function newId(before, idList, count = 1) {
    if (clientId && before !== null && before.bunchId.startsWith(`${clientId}:`)) {
      const maxCounter = idList.maxCounter(before.bunchId);
      if (maxCounter === before.counter) {
        return { bunchId: before.bunchId, counter: before.counter + 1 };
      }
    }
    return {
      bunchId: `${clientId}:${nextBunchIdCounter++}:${crypto.randomUUID()}`,
      counter: 0,
    };
  }

  // ---- Connection state ----

  function setConnected(c) {
    if (connected === c) return;
    connected = c;
    textarea.readOnly = !c;
    onConnectionChange?.(c);
  }

  // ---- Rendering ----

  function render(sel) {
    const proj = ensureProjection();
    const annotatedText = currentState.text;
    const visibleText = proj.visibleText;

    // Translate the incoming sel (annotated indices) to visible for setSelectionRange.
    // If sel is null, read the textarea's current selection (which is in visible space)
    // and pass through.
    let visStart, visEnd, dir;
    if (sel) {
      const clamped = clampSel(annotatedText, sel);
      visStart = annotatedToVisible(proj, clamped.start);
      visEnd = annotatedToVisible(proj, clamped.end);
      dir = clamped.direction;
    } else {
      visStart = Math.max(0, Math.min(textarea.selectionStart, visibleText.length));
      visEnd = Math.max(0, Math.min(textarea.selectionEnd, visibleText.length));
      dir = textarea.selectionDirection || "none";
    }

    programmatic = true;
    textarea.value = visibleText;
    textarea.setSelectionRange(visStart, visEnd, dir);
    queueMicrotask(() => { programmatic = false; });
    onTextChange?.(visibleText); // preview consumers see the visible projection
    renderRemoteCursors();
  }

  function renderRemoteCursors() {
    overlay.innerHTML = "";
    if (!initialized) return;
    const indices = [];
    const cursorData = [];

    for (const [cid, info] of remoteCursors) {
      if (Date.now() - info.lastUpdate > PRESENCE_STALE_MS) { remoteCursors.delete(cid); continue; }
      try {
        const sel = selectionFromIds(info.selection, currentState.idList);
        const proj = ensureProjection();
        const visIdx = annotatedToVisible(proj, sel.start);
        indices.push(visIdx);
        cursorData.push({ idx: visIdx, name: info.name, color: info.color });
      } catch {}
    }

    if (!cursorData.length) return;

    const positions = measureCaretPositions(textarea, mirror, indices);
    const cs = getComputedStyle(textarea);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;

    for (const cursor of cursorData) {
      const pos = positions.get(cursor.idx);
      if (!pos) continue;
      // Don't render if outside visible area
      const btw = parseFloat(cs.borderTopWidth) || 0;
      const bbw = parseFloat(cs.borderBottomWidth) || 0;
      const visibleHeight = textarea.clientHeight;
      if (pos.top < 0 - lineHeight || pos.top > visibleHeight + btw + bbw) continue;

      const el = document.createElement("div");
      el.className = "remote-cursor";
      el.style.left = pos.left + "px";
      el.style.top = pos.top + "px";
      el.innerHTML = `<div class="remote-cursor-caret" style="background:${cursor.color};height:${lineHeight}px"></div><div class="remote-cursor-label" style="background:${cursor.color}">${escapeHtml(cursor.name)}</div>`;
      overlay.appendChild(el);
    }
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---- Presence sending ----

  let lastPresenceSent = 0;
  let presenceTimer = null;
  let lastSentSelection = null;

  function sendPresence() {
    if (!initialized || !connected || !clientId || !ws || ws.readyState !== WebSocket.OPEN) return;
    const proj = ensureProjection();
    const visSs = textarea.selectionStart;
    const visSe = textarea.selectionEnd;
    const annSs = visibleToAnnotated(proj, visSs, "right");
    const annSe = visibleToAnnotated(proj, visSe, "left");
    const sel = selectionToIds(
      currentState.idList, annSs, annSe,
      textarea.selectionDirection || "none",
    );
    const key = JSON.stringify(sel);
    if (key === lastSentSelection) return;
    lastSentSelection = key;
    ws.send(JSON.stringify({ type: "presence", clientId, selection: sel }));
  }

  function throttledPresence() {
    const now = Date.now();
    if (now - lastPresenceSent >= PRESENCE_THROTTLE_MS) {
      lastPresenceSent = now;
      sendPresence();
    } else {
      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(() => {
        lastPresenceSent = Date.now();
        sendPresence();
      }, PRESENCE_THROTTLE_MS - (now - lastPresenceSent));
    }
  }

  // ---- Mutations ----

  function applyLocalMutations(mutations, sel) {
    if (!mutations.length) return;
    for (const m of mutations) {
      currentState = applyClientMutation(currentState, m);
      pendingMutations.push(m);
    }
    invalidateProjection();
    render(sel);
    if (ws && ws.readyState === WebSocket.OPEN && clientId) {
      ws.send(JSON.stringify({ type: "mutation", clientId, mutations }));
    }
    throttledPresence();
  }

  // ---- Server messages ----

  function receiveHello(msg) {
    let selIds = null;
    if (initialized) {
      const proj = ensureProjection();
      const annSs = visibleToAnnotated(proj, textarea.selectionStart, "right");
      const annSe = visibleToAnnotated(proj, textarea.selectionEnd, "left");
      selIds = selectionToIds(currentState.idList, annSs, annSe, textarea.selectionDirection || "none");
    }

    if (msg.clientId) clientId = msg.clientId;
    serverState = { text: msg.markdown || "", idList: SimpleIdList.load(msg.idListState || []) };
    currentState = replayPending(serverState, pendingMutations);
    markerKeys = buildMarkerKeySet(msg.markerCharKeys);
    confluenceMeta = msg.confluence || null;
    invalidateProjection();
    initialized = true;
    setConnected(true);
    reconnectDelay = RECONNECT_BASE_MS;
    render(selIds ? selectionFromIds(selIds, currentState.idList) : { start: 0, end: 0, direction: "none" });
    onReady?.({
      noteId: msg.noteId,
      title: msg.title,
      shareId: msg.shareId,
      markdown: ensureProjection().visibleText,
      confluence: confluenceMeta,
      markerCharKeys: msg.markerCharKeys || [],
    });

    if (pendingMutations.length > 0 && ws && ws.readyState === WebSocket.OPEN && clientId) {
      ws.send(JSON.stringify({ type: "mutation", clientId, mutations: pendingMutations }));
    }
    throttledPresence();
  }

  function receiveMutation(msg) {
    if (!initialized) return;
    const projBefore = ensureProjection();
    const annSs = visibleToAnnotated(projBefore, textarea.selectionStart, "right");
    const annSe = visibleToAnnotated(projBefore, textarea.selectionEnd, "left");
    const selIds = selectionToIds(currentState.idList, annSs, annSe, textarea.selectionDirection || "none");
    serverState = { text: msg.markdown || "", idList: applyIdListUpdates(serverState.idList, msg.idListUpdates || []) };
    if (msg.senderId === clientId) {
      const idx = pendingMutations.findIndex((m) => m.clientCounter === msg.senderCounter);
      if (idx !== -1) pendingMutations = pendingMutations.slice(idx + 1);
    }
    currentState = replayPending(serverState, pendingMutations);
    invalidateProjection();
    render(selectionFromIds(selIds, currentState.idList));
    throttledPresence();
  }

  function receivePresence(msg) {
    remoteCursors.set(msg.clientId, { name: msg.name, color: msg.color, selection: msg.selection, lastUpdate: Date.now() });
    renderRemoteCursors();
  }

  function receivePresenceLeave(msg) {
    remoteCursors.delete(msg.clientId);
    renderRemoteCursors();
  }

  // ---- Input handling ----

  function handleBeforeInput(event) {
    if (!initialized || !connected) { event.preventDefault(); return; }
    if (event.isComposing || event.inputType.includes("Composition")) return;

    const it = event.inputType;
    const proj = ensureProjection();
    const visSs = textarea.selectionStart;
    const visSe = textarea.selectionEnd;
    // Translate to annotated for mutation construction.
    const ss = visibleToAnnotated(proj, visSs, "right");
    const se = visibleToAnnotated(proj, visSe, "left");
    const hasSel = visSs !== visSe;

    // Marker guard: refuse inserts strictly inside `<!-- @path:... -->` runs,
    // and refuse deletes that would split a marker run. Mirrors the server
    // validator so the user gets immediate feedback rather than a server
    // bounce + hello reset.
    if (markerKeys.size > 0) {
      if (!hasSel && isInsertInsideMarker(markerKeys, currentState.idList, ss)) {
        event.preventDefault();
        opts.onMarkerGuard?.({ kind: "insert" });
        return;
      }
      if (hasSel && isDeletePartialMarker(markerKeys, currentState.idList, ss, se)) {
        event.preventDefault();
        opts.onMarkerGuard?.({ kind: "delete" });
        return;
      }
    }

    const mutations = [];
    let ws2 = { text: currentState.text, idList: currentState.idList.clone() };

    function pushDel(s, e) {
      const m = buildDeleteMutation(ws2, s, e, nextClientCounter++);
      if (!m) return false;
      mutations.push(m); ws2 = applyClientMutation(ws2, m); return true;
    }
    function pushIns(i, c) {
      const m = buildInsertMutation(ws2, i, c, nextClientCounter++, newId);
      if (!m) return false;
      mutations.push(m); ws2 = applyClientMutation(ws2, m); return true;
    }

    let sel = { start: ss, end: se, direction: "none" };

    if (hasSel && it !== "historyUndo" && it !== "historyRedo") {
      pushDel(ss, se); sel = { start: ss, end: ss, direction: "none" };
    }

    if (it === "insertText" || it === "insertReplacementText" || it === "insertFromPaste" || it === "insertFromDrop") {
      const c = readInsertText(event); if (!c) return;
      event.preventDefault();
      if (markerKeys.size > 0 && c.includes("<!-- @path:")) {
        opts.onMarkerGuard?.({ kind: "paste-marker" });
        return;
      }
      pushIns(sel.start, c); sel = { start: sel.start + c.length, end: sel.start + c.length, direction: "none" };
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "insertLineBreak" || it === "insertParagraph") {
      event.preventDefault();
      pushIns(sel.start, "\n"); sel = { start: sel.start + 1, end: sel.start + 1, direction: "none" };
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteContentBackward") {
      event.preventDefault();
      if (!hasSel && visSs > 0) {
        // Compute the deletion range in annotated space: from the annotated
        // index of the previous visible char up to the current annotated cursor.
        let delStart = visibleToAnnotated(proj, visSs - 1, "right");
        let delEnd = ss;
        if (markerKeys.size > 0) {
          // If the char being deleted is in a marker run, extend backwards to
          // the start of the run.
          if (delStart < currentState.idList.length) {
            const idAtDel = currentState.idList.at(delStart);
            const keyAtDel = `${idAtDel.bunchId}:${idAtDel.counter}`;
            if (markerKeys.has(keyAtDel)) {
              while (delStart > 0) {
                const prevId = currentState.idList.at(delStart - 1);
                const prevKey = `${prevId.bunchId}:${prevId.counter}`;
                if (!markerKeys.has(prevKey)) break;
                delStart--;
              }
            }
          }
        }
        pushDel(delStart, delEnd);
        sel = { start: delStart, end: delStart, direction: "none" };
      }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteContentForward") {
      event.preventDefault();
      if (!hasSel && visSe < proj.visibleText.length) {
        // Delete from annotated cursor up to the annotated index just after the next visible char.
        let delStart = ss;
        let delEnd = visibleToAnnotated(proj, visSe + 1, "left");
        if (markerKeys.size > 0) {
          if (delStart < currentState.idList.length) {
            const idAtDel = currentState.idList.at(delStart);
            const keyAtDel = `${idAtDel.bunchId}:${idAtDel.counter}`;
            if (markerKeys.has(keyAtDel)) {
              while (delEnd < currentState.idList.length) {
                const nextId = currentState.idList.at(delEnd);
                const nextKey = `${nextId.bunchId}:${nextId.counter}`;
                if (!markerKeys.has(nextKey)) break;
                delEnd++;
              }
            }
          }
        }
        pushDel(delStart, delEnd);
        sel = { start: delStart, end: delStart, direction: "none" };
      }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteWordBackward") {
      event.preventDefault();
      if (!hasSel && visSs > 0) {
        const visStart = wordBackward(proj.visibleText, visSs);
        const annStart = visibleToAnnotated(proj, visStart, "right");
        pushDel(annStart, ss);
        sel = { start: annStart, end: annStart, direction: "none" };
      }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteWordForward") {
      event.preventDefault();
      if (!hasSel && visSe < proj.visibleText.length) {
        const visEnd = wordForward(proj.visibleText, visSe);
        const annEnd = visibleToAnnotated(proj, visEnd, "left");
        pushDel(ss, annEnd);
        sel = { start: ss, end: ss, direction: "none" };
      }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteSoftLineBackward" || it === "deleteHardLineBackward") {
      event.preventDefault();
      if (!hasSel && visSs > 0) {
        const visStart = lineBackward(proj.visibleText, visSs);
        const annStart = visibleToAnnotated(proj, visStart, "right");
        pushDel(annStart, ss);
        sel = { start: annStart, end: annStart, direction: "none" };
      }
      applyLocalMutations(mutations, sel); return;
    }
  }

  function handleInput() {
    if (programmatic || !initialized) return;
    applyDiffFallback(textarea.value);
  }

  function applyDiffFallback(nextText) {
    if (!initialized) return;
    const proj = ensureProjection();
    if (nextText === proj.visibleText) return;
    const prev = proj.visibleText;
    let prefix = 0;
    while (prefix < prev.length && prefix < nextText.length && prev[prefix] === nextText[prefix]) prefix++;
    let ps = prev.length, ns = nextText.length;
    while (ps > prefix && ns > prefix && prev[ps - 1] === nextText[ns - 1]) { ps--; ns--; }

    // prefix, ps are visible offsets. Translate to annotated for the mutations.
    const annPrefix = visibleToAnnotated(proj, prefix, "right");
    const annPs = visibleToAnnotated(proj, ps, "left");

    const mutations = [];
    let ws2 = { text: currentState.text, idList: currentState.idList.clone() };
    const dm = buildDeleteMutation(ws2, annPrefix, annPs, nextClientCounter);
    if (dm) { nextClientCounter++; mutations.push(dm); ws2 = applyClientMutation(ws2, dm); }
    const ins = nextText.slice(prefix, ns);
    if (ins) { const im = buildInsertMutation(ws2, annPrefix, ins, nextClientCounter, newId); if (im) { nextClientCounter++; mutations.push(im); } }
    if (!mutations.length) {
      const visCursor = prefix;
      const annCursor = visibleToAnnotated(proj, visCursor, "right");
      render({ start: annCursor, end: annCursor, direction: "none" });
      return;
    }
    const visCursor = prefix + ins.length;
    const annCursor = visibleToAnnotated(proj, visCursor, "right");
    applyLocalMutations(mutations, { start: annCursor, end: annCursor, direction: "none" });
  }

  // ---- WebSocket ----

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const param = noteId ? `noteId=${encodeURIComponent(noteId)}` : `shareId=${encodeURIComponent(shareId)}`;
    ws = new WebSocket(`${protocol}//${location.host}/?${param}`);

    ws.addEventListener("open", () => {});
    ws.addEventListener("message", (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "hello") receiveHello(msg);
      else if (msg.type === "mutation") receiveMutation(msg);
      else if (msg.type === "presence") receivePresence(msg);
      else if (msg.type === "presence-leave") receivePresenceLeave(msg);
      else if (msg.type === "threads-updated") onThreadsUpdated?.();
      else if (msg.type === "marker-ids") {
        markerKeys = buildMarkerKeySet(msg.markerCharKeys);
        invalidateProjection();
        opts.onMarkerIdsChanged?.(msg.markerCharKeys || []);
        if (initialized) render(null);
      } else if (msg.type === "confluence-meta") {
        confluenceMeta = msg.confluence || confluenceMeta;
        invalidateProjection();
        opts.onConfluenceMeta?.(msg.confluence);
        if (initialized) render(null);
      } else if (msg.type === "confluence-push") {
        opts.onConfluencePush?.(msg);
      } else if (msg.type === "confluence-refresh") {
        opts.onConfluenceRefresh?.(msg);
      }
    });
    ws.addEventListener("close", () => {
      if (destroyed) return;
      setConnected(false);
      remoteCursors.clear();
      renderRemoteCursors();
      setTimeout(() => { if (!destroyed) { reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS); connect(); } }, reconnectDelay);
    });
    ws.addEventListener("error", () => { setConnected(false); });
  }

  // ---- Event listeners ----

  textarea.addEventListener("beforeinput", handleBeforeInput);
  textarea.addEventListener("input", handleInput);
  textarea.addEventListener("compositionend", () => {
    const proj = ensureProjection();
    if (textarea.value !== proj.visibleText) applyDiffFallback(textarea.value);
  });
  document.addEventListener("selectionchange", () => { if (document.activeElement === textarea) throttledPresence(); });
  textarea.addEventListener("focus", throttledPresence);
  textarea.addEventListener("blur", throttledPresence);
  textarea.addEventListener("scroll", renderRemoteCursors);

  connect();

  return {
    destroy() {
      destroyed = true;
      textarea.removeEventListener("beforeinput", handleBeforeInput);
      textarea.removeEventListener("input", handleInput);
      if (resizeObserver) resizeObserver.disconnect();
      if (ws) ws.close();
      overlay.remove();
      mirror.remove();
    },
    getText() { return currentState.text; },
  };
}
