/*
 * Docs Canvas — the engine.
 *
 * Everything platform-specific goes through window.Shell (see shell.js).
 *
 * One invariant runs through this whole file: DOM order of .node elements is
 * never changed after creation. Moving an <iframe> in the DOM reloads it, and
 * a reload throws away scroll position and page state — the exact thing this
 * tool exists to preserve. Stacking is done with z-index, never reordering.
 */
(function () {
  'use strict';

  var Shell = window.Shell;

  // ---------------------------------------------------------------- utils

  var $ = function (s) { return document.querySelector(s); };
  var uid = function (p) { return p + Math.random().toString(36).slice(2, 9); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function baseName(p) {
    var n = p.split('/').pop();
    return n.replace(/\.[a-z0-9]+$/i, '');
  }

  // ---------------------------------------------------------------- state

  var MIN_Z = 0.08, MAX_Z = 2.5;

  var state = {
    v: 1,
    camera: { x: 0, y: 0, z: 1 },
    nodes: [],
    edges: [],
  };

  var files = [];
  var els = new Map();        // node id -> { root, tabsEl, bodyEl, shield, panes:Map }
  var selected = null;        // node id
  var selectedEdge = null;
  var liveId = null;          // node whose frame currently takes pointer events
  var focus = null;           // { id, geom, cam }
  var linking = null;         // null | { from: id|null }
  var boardName = 'default';
  var zTop = 10;
  var railHidden = false;

  var viewport, world, nodesEl, edgesEl;

  function nodeById(id) {
    for (var i = 0; i < state.nodes.length; i++) if (state.nodes[i].id === id) return state.nodes[i];
    return null;
  }

  // ---------------------------------------------------------------- camera

  function applyCamera() {
    var c = state.camera;
    world.style.transform = 'translate(' + c.x + 'px,' + c.y + 'px) scale(' + c.z + ')';
    $('#zoomVal').textContent = Math.round(c.z * 100) + '%';
    if (edgesEl) {
      edgesEl.style.setProperty('--ez', c.z);   // stroke widths divide by this
      sizeHeads();
    }
  }

  function screenToWorld(sx, sy) {
    var c = state.camera;
    return { x: (sx - c.x) / c.z, y: (sy - c.y) / c.z };
  }

  function zoomAt(sx, sy, factor) {
    var c = state.camera;
    var z2 = clamp(c.z * factor, MIN_Z, MAX_Z);
    var k = z2 / c.z;
    c.x = sx - (sx - c.x) * k;
    c.y = sy - (sy - c.y) * k;
    c.z = z2;
    applyCamera();
    markDirty();
  }

  function fly(fn) {
    world.classList.add('flying');
    fn();
    applyCamera();
    setTimeout(function () { world.classList.remove('flying'); }, 300);
  }

  function fitAll() {
    if (!state.nodes.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    });
    var pad = 80;
    var vw = window.innerWidth - (railHidden ? 0 : 286);
    var vh = window.innerHeight;
    var z = clamp(Math.min(vw / (maxX - minX + pad * 2), vh / (maxY - minY + pad * 2)), MIN_Z, 1);
    fly(function () {
      state.camera.z = z;
      state.camera.x = (railHidden ? 0 : 286) + (vw - (maxX - minX) * z) / 2 - minX * z;
      state.camera.y = (vh - (maxY - minY) * z) / 2 - minY * z;
    });
    markDirty();
  }

  // ---------------------------------------------------------------- node dom

  function defaultSize(kind) {
    if (kind === 'image') return { w: 620, h: 460 };
    if (kind === 'video') return { w: 720, h: 470 };
    if (kind === 'text') return { w: 640, h: 560 };
    return { w: 880, h: 620 };
  }

  function buildNode(n) {
    var root = el('div', 'node type-' + n.type);
    root.dataset.id = n.id;

    var chrome = el('div', 'chrome');
    var tabsEl = el('div', 'tabs');
    var actions = el('div', 'chrome-actions');
    chrome.appendChild(tabsEl);
    chrome.appendChild(actions);
    root.appendChild(chrome);

    if (n.type === 'web') {
      var bar = el('div', 'urlbar');
      var input = document.createElement('input');
      input.type = 'text';
      input.value = n.url || '';
      input.placeholder = 'https://…  (enter to load)';
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') {
          var u = input.value.trim();
          if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
          n.url = u; input.value = u;
          reloadWeb(n);
          markDirty();
        }
      });
      bar.appendChild(input);
      root.appendChild(bar);
    }

    var body = el('div', 'body');
    var shield = el('div', 'shield');
    body.appendChild(shield);
    root.appendChild(body);

    ['e', 's', 'se'].forEach(function (dir) {
      var g = el('div', 'grip ' + dir);
      g.addEventListener('pointerdown', function (e) { startResize(e, n, dir); });
      root.appendChild(g);
    });

    // --- chrome buttons
    function act(label, title, fn) {
      var b = el('button', null, label);
      b.title = title;
      b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
      actions.appendChild(b);
      return b;
    }
    var focusBtn = null;
    if (n.type !== 'note') {
      focusBtn = act('', '', function () {
        focus && focus.id === n.id ? exitFocus() : enterFocus(n);
      });
      setFocusIcon(focusBtn, false);
      act('↗', 'Open in a real browser tab', function () {
        if (n.type === 'web') { if (n.url) Shell.openExternal(n.url); }
        else {
          var t = activeTab(n);
          if (t) Shell.openExternal(Shell.urlFor(t.path));
        }
      });
    }
    if (n.type === 'web') act('⟳', 'Reload', function () { reloadWeb(n); });
    act('✕', 'Remove this window', function () { removeNode(n.id); });

    // --- drag / focus / selection
    chrome.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button') || e.target.closest('.tab')) return;
      startDrag(e, n);
    });
    chrome.addEventListener('dblclick', function (e) {
      if (e.target.closest('button')) return;
      if (n.type === 'note') return;
      focus && focus.id === n.id ? exitFocus() : enterFocus(n);
    });
    // Capture phase so link mode preempts dragging, waking a frame, and
    // editing a note — all node types answer clicks the same way while linking.
    root.addEventListener('pointerdown', function (e) {
      if (linking) {
        e.preventDefault(); e.stopPropagation();
        handleLinkClick(n);
        return;
      }
      select(n.id);
    }, true);

    shield.addEventListener('click', function (e) {
      e.stopPropagation();
      setLive(n.id);
    });

    // dropping a file onto the tab bar adds a tab
    if (n.type === 'doc') {
      tabsEl.addEventListener('dragover', function (e) {
        e.preventDefault(); e.stopPropagation();
        tabsEl.classList.add('drop-hint');
      });
      tabsEl.addEventListener('dragleave', function () { tabsEl.classList.remove('drop-hint'); });
      tabsEl.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation();
        tabsEl.classList.remove('drop-hint');
        var path = e.dataTransfer.getData('text/docpath') || e.dataTransfer.getData('text/plain');
        var f = files.find(function (x) { return x.path === path; });
        if (f) { addTab(n, f); markDirty(); }
      });
    }

    var rec = { root: root, tabsEl: tabsEl, bodyEl: body, shield: shield, focusBtn: focusBtn, panes: new Map() };
    els.set(n.id, rec);
    nodesEl.appendChild(root); // append only — never reorder
    return rec;
  }

  /* One button, two jobs: it opens webpage mode and it is also the way out of
     it. In focus mode the node fills the screen, so this sits top-right — no
     separate exit bar floating over the document. */
  var ICON_EXPAND   = '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10"/></svg>';
  var ICON_COLLAPSE = '<svg viewBox="0 0 16 16"><path d="M6 2.5V6H2.5M10 2.5V6h3.5M6 13.5V10H2.5M10 13.5V10h3.5"/></svg>';

  function setFocusIcon(b, on) {
    b.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
    b.title = on ? 'Leave webpage mode (Esc)' : 'Webpage mode (double-click the bar)';
    b.classList.toggle('on', on);
  }

  function activeTab(n) {
    if (!n.tabs) return null;
    return n.tabs.find(function (t) { return t.id === n.active; }) || n.tabs[0] || null;
  }

  function syncTabs(n, rec) {
    var strip = rec.tabsEl;
    strip.textContent = '';

    if (n.type === 'note') {
      strip.appendChild(el('span', 'tab active', 'Note'));
      return;
    }
    if (n.type === 'web') {
      var chip = el('span', 'tab active');
      chip.appendChild(el('span', 'dot web'));
      chip.appendChild(el('span', 'label', n.url ? n.url.replace(/^https?:\/\//, '') : 'new page'));
      strip.appendChild(chip);
      return;
    }

    n.tabs.forEach(function (t) {
      var chip = el('div', 'tab' + (t.id === n.active ? ' active' : ''));
      chip.appendChild(el('span', 'dot ' + t.kind));
      chip.appendChild(el('span', 'label', t.title));
      var x = el('span', 'x', '×');
      x.title = 'Close tab';
      x.addEventListener('click', function (e) { e.stopPropagation(); closeTab(n, t.id); });
      chip.appendChild(x);
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        n.active = t.id;
        render();
        markDirty();
      });
      strip.appendChild(chip);
    });
  }

  /* Panes are created on first activation and then kept — hidden, not
     destroyed — so scroll position survives tab switching. */
  function ensurePane(n, rec) {
    if (n.type === 'note') {
      if (!rec.panes.has('note')) {
        var pane = el('div', 'pane');
        var ta = el('div', 'note-text');
        ta.contentEditable = 'true';
        ta.spellcheck = false;
        ta.textContent = n.text || '';
        ta.addEventListener('input', function () { n.text = ta.textContent; markDirty(); });
        // Swallow keys so shortcuts don't fire mid-sentence — but let Escape
        // out, otherwise there's no way to leave the note by keyboard.
        ta.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { ta.blur(); return; }
          e.stopPropagation();
        });
        pane.appendChild(ta);
        rec.bodyEl.insertBefore(pane, rec.shield);
        rec.panes.set('note', { pane: pane });
        rec.shield.hidden = true; // notes are always directly editable
      }
      return;
    }

    if (n.type === 'web') {
      if (!n.url) return;
      if (!rec.panes.has(n.url)) {
        rec.panes.forEach(function (p) { p.pane.remove(); });
        rec.panes.clear();
        var wp = el('div', 'pane');
        var embed = Shell.createEmbed({ kind: 'web', url: n.url });
        wp.appendChild(embed);
        rec.bodyEl.insertBefore(wp, rec.shield);
        rec.panes.set(n.url, { pane: wp, embed: embed });
        Shell.probeEmbed(embed).then(function (r) {
          if (r === 'ok') return;
          showBlocked(n, rec, wp);
        });
      }
      return;
    }

    var t = activeTab(n);
    if (!t) return;
    if (!rec.panes.has(t.id)) {
      var p = el('div', 'pane');
      p.appendChild(Shell.createEmbed({ kind: t.kind, path: t.path }));
      rec.bodyEl.insertBefore(p, rec.shield);
      rec.panes.set(t.id, { pane: p });
    }
    rec.panes.forEach(function (v, k) { v.pane.hidden = (k !== t.id); });
  }

  function showBlocked(n, rec, pane) {
    if (pane.querySelector('.blocked')) return;
    var box = el('div', 'blocked');
    box.appendChild(el('div', null, 'This site refused to be embedded.'));
    box.appendChild(el('div', 'u', n.url));
    var b = el('button', null, 'Open in browser');
    b.addEventListener('click', function () { Shell.openExternal(n.url); });
    box.appendChild(b);
    box.appendChild(el('div', 'why',
      'Most large sites send X-Frame-Options or frame-ancestors headers that block framing. A desktop build of this canvas would render it fine.'));
    pane.appendChild(box);
  }

  function reloadWeb(n) {
    var rec = els.get(n.id);
    if (!rec) return;
    rec.panes.forEach(function (p) { p.pane.remove(); });
    rec.panes.clear();
    ensurePane(n, rec);
    syncTabs(n, rec);
  }

  function syncNode(n) {
    var rec = els.get(n.id) || buildNode(n);
    var r = rec.root;
    r.style.left = n.x + 'px';
    r.style.top = n.y + 'px';
    r.style.width = n.w + 'px';
    r.style.height = n.h + 'px';
    r.style.zIndex = focus && focus.id === n.id ? 900 : (n.zi || 1);
    r.classList.toggle('selected', selected === n.id);
    r.classList.toggle('live', liveId === n.id);
    r.classList.toggle('focused', !!focus && focus.id === n.id);
    r.classList.toggle('linksrc', !!linking && linking.from === n.id);
    if (rec.focusBtn) setFocusIcon(rec.focusBtn, !!focus && focus.id === n.id);
    if (n.type !== 'note') rec.shield.hidden = (liveId === n.id);
    syncTabs(n, rec);
    ensurePane(n, rec);
  }

  function render() {
    // drop elements whose nodes are gone
    els.forEach(function (rec, id) {
      if (!nodeById(id)) { rec.root.remove(); els.delete(id); }
    });
    state.nodes.forEach(syncNode);
    renderEdges();
  }

  // ---------------------------------------------------------------- edges

  var SVGNS = 'http://www.w3.org/2000/svg';

  function center(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

  /* Walk from a node's centre toward a point and stop at the node's border. */
  function borderPoint(n, from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    if (!dx && !dy) return from;
    var hw = n.w / 2 + 7, hh = n.h / 2 + 7;
    var sx = dx ? hw / Math.abs(dx) : Infinity;
    var sy = dy ? hh / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return { x: from.x + dx * s, y: from.y + dy * s };
  }

  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function renderEdges() {
    edgesEl.textContent = '';
    state.edges.forEach(function (ed) {
      var a = nodeById(ed.from), b = nodeById(ed.to);
      if (!a || !b) return;
      var ca = center(a), cb = center(b);
      var p1 = borderPoint(a, ca, cb), p2 = borderPoint(b, cb, ca);
      var d = 'M' + p1.x + ',' + p1.y + 'L' + p2.x + ',' + p2.y;

      var g = svg('g', {});
      if (selectedEdge === ed.id) g.setAttribute('class', 'sel');

      var hit = svg('path', { d: d, class: 'hit' });
      hit.addEventListener('click', function (e) {
        e.stopPropagation();
        selectedEdge = ed.id; selected = null;
        render();
      });
      g.appendChild(hit);
      g.appendChild(svg('path', { d: d }));

      // The head is drawn in its own local space and scaled by 1/z, so it keeps
      // its screen size at any zoom. (vector-effect is no help anywhere here:
      // it ignores transforms *inside* the SVG, and ours is the CSS scale on
      // #world, outside it. Widths are divided by z in applyCamera instead.)
      var head = svg('g', { class: 'head' });
      head.dataset.at = 'translate(' + p2.x + ',' + p2.y + ') ' +
                        'rotate(' + (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI) + ')';
      head.appendChild(svg('path', { d: 'M0,0L-17,-9L-12.5,0L-17,9Z' }));
      g.appendChild(head);

      edgesEl.appendChild(g);
    });
    sizeHeads();
  }

  /* Cheap enough to run on every wheel tick: a board has a handful of edges. */
  function sizeHeads() {
    var k = 1 / state.camera.z;
    var heads = edgesEl.querySelectorAll('g.head');
    for (var i = 0; i < heads.length; i++) {
      heads[i].setAttribute('transform', heads[i].dataset.at + ' scale(' + k + ')');
    }
  }

  // ---------------------------------------------------------------- node ops

  function select(id) {
    selected = id;
    selectedEdge = null;
    var n = nodeById(id);
    if (n) n.zi = ++zTop;
    state.nodes.forEach(function (m) {
      var rec = els.get(m.id);
      if (!rec) return;
      rec.root.classList.toggle('selected', m.id === id);
      rec.root.style.zIndex = focus && focus.id === m.id ? 900 : (m.zi || 1);
    });
  }

  function setLive(id) {
    liveId = id;
    state.nodes.forEach(function (m) {
      var rec = els.get(m.id);
      if (!rec || m.type === 'note') return;
      rec.shield.hidden = (m.id === id);
      rec.root.classList.toggle('live', m.id === id);
    });
  }

  function addNode(n) {
    n.id = n.id || uid('n');
    n.zi = ++zTop;
    state.nodes.push(n);
    render();
    select(n.id);
    markDirty();
    return n;
  }

  function nodeFromFile(f, x, y) {
    var s = defaultSize(f.kind);
    var tab = { id: uid('t'), kind: f.kind, path: f.path, title: baseName(f.path) };
    return addNode({
      type: 'doc', x: Math.round(x), y: Math.round(y), w: s.w, h: s.h,
      tabs: [tab], active: tab.id,
    });
  }

  function addTab(n, f) {
    var existing = n.tabs.find(function (t) { return t.path === f.path; });
    if (existing) { n.active = existing.id; render(); return; }
    var tab = { id: uid('t'), kind: f.kind, path: f.path, title: baseName(f.path) };
    n.tabs.push(tab);
    n.active = tab.id;
    render();
  }

  function closeTab(n, tabId) {
    var rec = els.get(n.id);
    if (rec && rec.panes.has(tabId)) { rec.panes.get(tabId).pane.remove(); rec.panes.delete(tabId); }
    n.tabs = n.tabs.filter(function (t) { return t.id !== tabId; });
    if (!n.tabs.length) { removeNode(n.id); return; }
    if (n.active === tabId) n.active = n.tabs[0].id;
    render();
    markDirty();
  }

  function removeNode(id) {
    if (focus && focus.id === id) exitFocus();
    state.nodes = state.nodes.filter(function (n) { return n.id !== id; });
    state.edges = state.edges.filter(function (e) { return e.from !== id && e.to !== id; });
    if (selected === id) selected = null;
    if (liveId === id) liveId = null;
    render();
    markDirty();
  }

  function duplicateNode(id) {
    var n = nodeById(id);
    if (!n) return;
    var copy = JSON.parse(JSON.stringify(n));
    copy.id = uid('n');
    copy.x += 40; copy.y += 40;
    if (copy.tabs) {
      var map = {};
      copy.tabs.forEach(function (t) { var old = t.id; t.id = uid('t'); map[old] = t.id; });
      copy.active = map[n.active] || copy.tabs[0].id;
    }
    addNode(copy);
  }

  // ---------------------------------------------------------------- focus mode

  function enterFocus(n) {
    if (focus) exitFocus();
    focus = {
      id: n.id,
      geom: { x: n.x, y: n.y, w: n.w, h: n.h },
      cam: { x: state.camera.x, y: state.camera.y, z: state.camera.z },
    };
    // Resize the node to the viewport rather than magnifying it, so the
    // document genuinely reflows at full width.
    n.x = 0; n.y = 0;
    n.w = window.innerWidth;
    n.h = window.innerHeight;
    state.camera = { x: 0, y: 0, z: 1 };
    document.body.classList.add('focus-mode');
    setLive(n.id);
    applyCamera();
    render();
  }

  function exitFocus() {
    if (!focus) return;
    var n = nodeById(focus.id);
    if (n) { n.x = focus.geom.x; n.y = focus.geom.y; n.w = focus.geom.w; n.h = focus.geom.h; }
    state.camera = focus.cam;
    focus = null;
    document.body.classList.remove('focus-mode');
    applyCamera();
    render();
  }

  // ---------------------------------------------------------------- linking

  function toggleLink() {
    linking = linking ? null : { from: null };
    $('#linkBtn').classList.toggle('on', !!linking);
    viewport.classList.toggle('linking', !!linking);
    if (!linking) render();
    else toast('Arrow: click the source window, then the target');
  }

  function handleLinkClick(n) {
    if (!linking) return;
    if (!linking.from) {
      linking.from = n.id;
      render();
      return;
    }
    if (linking.from !== n.id) {
      var dup = state.edges.some(function (e) { return e.from === linking.from && e.to === n.id; });
      if (!dup) state.edges.push({ id: uid('e'), from: linking.from, to: n.id });
      markDirty();
    }
    toggleLink();
    render();
  }

  // ---------------------------------------------------------------- drag / resize / pan

  function startDrag(e, n) {
    if (focus) return;
    // Two subtleties, both learned the hard way:
    //  - No preventDefault(): on pointerdown it suppresses the compatibility
    //    mouse events, which kills the dblclick that opens webpage mode.
    //    user-select:none on .chrome already stops text selection.
    //  - Capture on the bar itself, not the node root. Pointer capture also
    //    retargets mousedown/mouseup, so capturing on the root would make the
    //    click land on the root — and .chrome, being its child, would never
    //    see the dblclick at all.
    var cap = e.currentTarget;
    var rec = els.get(n.id);
    var sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
    rec.root.classList.add('dragging');
    cap.setPointerCapture(e.pointerId);
    select(n.id);

    function move(ev) {
      n.x = Math.round(ox + (ev.clientX - sx) / state.camera.z);
      n.y = Math.round(oy + (ev.clientY - sy) / state.camera.z);
      rec.root.style.left = n.x + 'px';
      rec.root.style.top = n.y + 'px';
      renderEdges();
    }
    function up(ev) {
      rec.root.classList.remove('dragging');
      cap.releasePointerCapture(ev.pointerId);
      cap.removeEventListener('pointermove', move);
      cap.removeEventListener('pointerup', up);
      markDirty();
    }
    cap.addEventListener('pointermove', move);
    cap.addEventListener('pointerup', up);
  }

  function startResize(e, n, dir) {
    if (focus) return;
    e.preventDefault(); e.stopPropagation();
    var cap = e.currentTarget;  // the grip — see the note in startDrag
    var rec = els.get(n.id);
    var sx = e.clientX, sy = e.clientY, ow = n.w, oh = n.h;
    cap.setPointerCapture(e.pointerId);
    select(n.id);

    function move(ev) {
      if (dir !== 's') n.w = Math.max(260, Math.round(ow + (ev.clientX - sx) / state.camera.z));
      if (dir !== 'e') n.h = Math.max(160, Math.round(oh + (ev.clientY - sy) / state.camera.z));
      rec.root.style.width = n.w + 'px';
      rec.root.style.height = n.h + 'px';
      renderEdges();
    }
    function up(ev) {
      cap.releasePointerCapture(ev.pointerId);
      cap.removeEventListener('pointermove', move);
      cap.removeEventListener('pointerup', up);
      markDirty();
    }
    cap.addEventListener('pointermove', move);
    cap.addEventListener('pointerup', up);
  }

  function startPan(e) {
    var sx = e.clientX, sy = e.clientY;
    var ox = state.camera.x, oy = state.camera.y;
    viewport.classList.add('panning');
    viewport.setPointerCapture(e.pointerId);

    function move(ev) {
      state.camera.x = ox + (ev.clientX - sx);
      state.camera.y = oy + (ev.clientY - sy);
      applyCamera();
    }
    function up(ev) {
      viewport.classList.remove('panning');
      viewport.releasePointerCapture(ev.pointerId);
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
      markDirty();
    }
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------- rail

  function renderRail() {
    var q = $('#search').value.trim().toLowerCase();
    var list = $('#fileList');
    list.textContent = '';

    var shown = files.filter(function (f) {
      if (!q) return true;
      return (f.name + ' ' + f.dir).toLowerCase().indexOf(q) !== -1;
    });

    $('#railCount').textContent = shown.length + (q ? ' of ' + files.length : ' files');

    var groups = new Map();
    shown.forEach(function (f) {
      var k = f.dir || '/';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    });

    groups.forEach(function (items, dir) {
      var g = el('div', 'grp');
      g.appendChild(el('div', 'grp-h', dir));
      items.forEach(function (f) {
        var row = el('div', 'f');
        row.draggable = true;
        row.title = f.path;
        row.appendChild(el('span', 'dot ' + f.kind));
        row.appendChild(el('span', 'n', f.name));
        row.addEventListener('dragstart', function (e) {
          e.dataTransfer.setData('text/docpath', f.path);
          e.dataTransfer.setData('text/plain', f.path);
          e.dataTransfer.effectAllowed = 'copy';
        });
        row.addEventListener('click', function () {
          // click drops it in the middle of what you're looking at
          var c = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
          var s = defaultSize(f.kind);
          nodeFromFile(f, c.x - s.w / 2, c.y - s.h / 2);
        });
        g.appendChild(row);
      });
      list.appendChild(g);
    });
  }

  function toggleRail(force) {
    railHidden = force === undefined ? !railHidden : !force;
    $('#rail').classList.toggle('hidden', railHidden);
  }

  // The shortcut sheet is a second view of the rail rather than a modal, so
  // reading it never covers the board you are reading it about.
  function showHelp(on) {
    var rail = $('#rail');
    if (on === undefined) on = !rail.classList.contains('help');
    rail.classList.toggle('help', on);
    $('#railTitle').textContent = on ? 'Shortcuts' : 'Docs';
    $('#railCount').hidden = on;
    if (on) toggleRail(true);
  }

  function helpOpen() { return $('#rail').classList.contains('help') && !railHidden; }

  // ---------------------------------------------------------------- persistence

  var saveTimer;

  // 'dirty' | 'ok' | 'idle' — drives the colour of the dot in the top bar.
  function setSaveState(text, kind) {
    var e = $('#saveState');
    e.textContent = text;
    e.className = text ? (kind || 'dirty') : 'idle';
  }

  function serialize() {
    return {
      v: 1,
      savedAt: Date.now(),
      camera: state.camera,
      nodes: state.nodes,
      edges: state.edges,
    };
  }

  function markDirty() {
    setSaveState('unsaved', 'dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      Shell.draftSet(boardName, serialize());
      setSaveState('draft ✓', 'dirty');
    }, 700);
  }

  async function saveToDisk() {
    clearTimeout(saveTimer);   // don't let a queued draft relabel this
    try {
      await Shell.saveBoard(boardName, serialize());
      Shell.draftSet(boardName, serialize());
      setSaveState('saved ✓', 'ok');
      toast('Saved to _canvas/boards/' + boardName + '.json');
    } catch (e) {
      toast('Save failed: ' + e.message);
    }
  }

  function adopt(data) {
    state.camera = data.camera || { x: 0, y: 0, z: 1 };
    state.nodes = data.nodes || [];
    state.edges = data.edges || [];
    state.nodes.forEach(function (n) { n.zi = ++zTop; });
    selected = null; liveId = null; selectedEdge = null;
    els.forEach(function (rec) { rec.root.remove(); });
    els.clear();
    applyCamera();
    render();
  }

  async function loadBoard(name) {
    boardName = name;
    $('#boardName').value = name;
    Shell.setLastBoard(name);
    var disk = await Shell.loadBoard(name);
    var draft = Shell.draftGet(name);
    var pick = disk;
    if (draft && (!disk || (draft.savedAt || 0) > (disk.savedAt || 0))) pick = draft;
    if (pick) {
      adopt(pick);
      if (pick === draft && disk) setSaveState('draft ✓', 'dirty'); else setSaveState('loaded', 'ok');
    } else {
      adopt({ nodes: [], edges: [], camera: { x: 0, y: 0, z: 1 } });
      welcome();
    }
  }

  function welcome() {
    addNode({
      type: 'note', x: 60, y: 60, w: 330, h: 210,
      text: 'Drag a doc from the left onto the canvas.\n\n' +
            'Drop one on a window\'s tab bar to add it as a tab.\n\n' +
            'Click a page once to wake it, then it scrolls like normal.\n' +
            'Double-click a title bar for full webpage mode.\n\n' +
            'Press ? for everything else.',
    });
    setSaveState('');
  }

  // ---------------------------------------------------------------- input

  function onWheel(e) {
    if (focus) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    } else {
      state.camera.x -= e.deltaX;
      state.camera.y -= e.deltaY;
      applyCamera();
      markDirty();
    }
  }

  function onKey(e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    if (e.key === 'Escape') {
      if (focus) return exitFocus();
      if (linking) return toggleLink();
      if (helpOpen()) { showHelp(false); return; }
      selected = null; selectedEdge = null; setLive(null); render();
      return;
    }
    if (typing) return;

    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveToDisk(); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleRail(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (selected) duplicateNode(selected); return; }
    if (mod) return;

    switch (e.key) {
      case 'f': case 'F': fitAll(); break;
      case 'l': case 'L': toggleLink(); break;
      case '0': fly(function () { state.camera.z = 1; }); markDirty(); break;
      case '?': showHelp(true); break;
      case 'Delete': case 'Backspace':
        if (selectedEdge) {
          state.edges = state.edges.filter(function (x) { return x.id !== selectedEdge; });
          selectedEdge = null; render(); markDirty();
        } else if (selected) removeNode(selected);
        break;
    }
  }

  function wireTopbar() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'save': saveToDisk(); break;
        case 'fit': fitAll(); break;
        case 'link': toggleLink(); break;
        case 'help': showHelp(); break;
        case 'zoom-in': zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2); break;
        case 'zoom-out': zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2); break;
        case 'add-note': {
          var c = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
          addNode({ type: 'note', x: Math.round(c.x - 130), y: Math.round(c.y - 90), w: 260, h: 180, text: '' });
          break;
        }
        case 'add-web': {
          var w = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
          var n = addNode({ type: 'web', x: Math.round(w.x - 440), y: Math.round(w.y - 310), w: 880, h: 620, url: '' });
          var rec = els.get(n.id);
          var input = rec.root.querySelector('.urlbar input');
          if (input) input.focus();
          break;
        }
        case 'open': openBoardPrompt(); break;
      }
    });

    $('#railToggle').addEventListener('click', function () { toggleRail(); });
    $('#search').addEventListener('input', renderRail);
    $('#boardName').addEventListener('change', function () {
      var v = $('#boardName').value.trim().replace(/[^a-z0-9_-]/gi, '') || 'default';
      loadBoard(v);
    });
  }

  async function openBoardPrompt() {
    var names = await Shell.listBoards();
    var msg = names.length ? 'Boards on disk:\n\n  ' + names.join('\n  ') + '\n\nOpen which?' : 'No saved boards yet. Name a new one:';
    var pick = window.prompt(msg, names[0] || 'default');
    if (pick) loadBoard(pick.trim().replace(/[^a-z0-9_-]/gi, '') || 'default');
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    viewport = $('#viewport');
    world = $('#world');
    nodesEl = $('#nodes');
    edgesEl = $('#edges');
    edgesEl.setAttribute('viewBox', '-50000 -50000 100000 100000');
    edgesEl.removeAttribute('width');
    edgesEl.removeAttribute('height');

    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.node')) return;
      if (linking) { toggleLink(); return; }
      selected = null; selectedEdge = null;
      setLive(null);
      render();
      startPan(e);
    });
    viewport.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    viewport.addEventListener('drop', function (e) {
      e.preventDefault();
      var path = e.dataTransfer.getData('text/docpath') || e.dataTransfer.getData('text/plain');
      var f = files.find(function (x) { return x.path === path; });
      if (!f) return;
      var c = screenToWorld(e.clientX, e.clientY);
      nodeFromFile(f, c.x, c.y);
    });

    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', function () {
      if (!focus) return;
      var n = nodeById(focus.id);
      if (!n) return;
      n.w = window.innerWidth; n.h = window.innerHeight;
      syncNode(n);
    });
    window.addEventListener('beforeunload', function () { Shell.draftSet(boardName, serialize()); });

    wireTopbar();
    applyCamera();

    try {
      files = await Shell.listFiles();
    } catch (e) {
      toast('Could not reach the file server — is node _canvas/server.js running?');
    }
    renderRail();
    await loadBoard(Shell.lastBoard());
  }

  boot();
})();
