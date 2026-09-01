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
    v: 2,
    camera: { x: 0, y: 0, z: 1 },
    nodes: [],
    edges: [],
    strokes: [],        // reserved for the ink layer; serialised from now on
    roots: [],          // [{ id, label, path }] — which folders THIS board shows
    open: {},           // { rootId: ['sub', 'sub/deeper'] } — expanded folders
  };

  var defaultRoot = null;     // the served folder, from the server
  var railMode = 'tree';      // 'tree' | 'recent'
  var showAll = false;        // include files the canvas cannot render
  var dirCache = new Map();   // 'rootId::dir' -> listing, so reopening is instant
  var els = new Map();        // node id -> { root, tabsEl, bodyEl, shield, panes:Map }

  /* Selection is a set per kind, not one slot each.
     The marquee is the resting tool — a left drag across empty canvas bands
     whatever it touches — so every consumer has to cope with "more than one",
     and the old single-node case is simply a set of size 1. `selNodes` is the
     only thing that decides a node's `.selected` class; nothing else may write
     it. Panning moved to the right button to free the left one; see
     startMarquee. */
  var selNodes = new Set();
  var selStrokes = new Set();
  var selEdges = new Set();
  var liveId = null;          // node whose frame currently takes pointer events
  var focus = null;           // { id, geom, cam }
  var linking = null;         // null | { from: id|null }
  var boardName = 'default';
  var zTop = 10;
  /* Closed at rest. Every control now lives in the rail, so the burger is
     the one thing on screen when nothing is open — the canvas gets the whole
     window until you ask for the tools. Keep in step with `class="hidden"`
     on #rail in index.html. */
  var railHidden = true;

  var viewport, world, nodesEl, edgesEl, inkEl;

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
    // --ez is an inline style on each SVG, not an inherited one, so the ink
    // layer needs its own write or its hit paths stop tracking the zoom.
    if (inkEl) inkEl.style.setProperty('--ez', c.z);
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
    // Ink counts as content: a board that is only annotations still has
    // something to fit, and leaving strokes out made Fit a no-op there.
    if (!state.nodes.length && !state.strokes.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    });
    state.strokes.forEach(function (s) {
      var pad = s.size / 2;
      s.pts.forEach(function (p) {
        minX = Math.min(minX, p[0] - pad); minY = Math.min(minY, p[1] - pad);
        maxX = Math.max(maxX, p[0] + pad); maxY = Math.max(maxY, p[1] + pad);
      });
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

  /* Node types the canvas draws itself, as opposed to ones that embed a
     document. They share four exemptions: no webpage mode, no "open in a real
     tab", no shield (their content is meant to be clicked straight away), and
     no dblclick-to-focus. Adding a type here is how you opt into all four. */
  var PLAIN = { note: 1, text: 1, shape: 1 };
  function isPlain(n) { return !!PLAIN[n.type]; }

  var SHAPE_LABEL = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' };

  /* ---------------------------------------------------------------- text box
   *
   * A text box is the only node whose size is not the user's to set directly.
   * It carries a type size (n.fs) and the box is then measured from the words,
   * so the border always sits tight against the ink. The corner grip therefore
   * drives n.fs rather than n.w, and fitText() derives the box from it.
   *
   * The measurer is one off-screen div sharing the editor's CSS (see the
   * `#textMeasure` rule). It lives outside the camera's transform, so its
   * rect comes back in world units at any zoom — measuring the live editor
   * instead would hand back numbers scaled by the zoom level.
   */
  var TEXT_FS = 50, TEXT_FS_MIN = 8, TEXT_FS_MAX = 400;
  var measureEl = null;

  function fitText(n, rec) {
    if (!measureEl) {
      measureEl = el('div');
      measureEl.id = 'textMeasure';
      document.body.appendChild(measureEl);
    }
    measureEl.style.setProperty('--fs', (n.fs || TEXT_FS) + 'px');
    // An empty box still has to be big enough to click on, so it measures a
    // single space rather than nothing at all.
    measureEl.textContent = n.text ? n.text : ' ';
    var r = measureEl.getBoundingClientRect();
    n.w = Math.ceil(r.width) + 2;    // +2 for the node's own 1px border
    n.h = Math.ceil(r.height) + 2;
    if (rec) {
      rec.root.style.setProperty('--fs', (n.fs || TEXT_FS) + 'px');
      rec.root.style.width = n.w + 'px';
      rec.root.style.height = n.h + 'px';
    }
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

    (n.type === 'text' ? ['se'] : ['e', 's', 'se']).forEach(function (dir) {
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
    if (!isPlain(n)) {
      focusBtn = act('', '', function () {
        focus && focus.id === n.id ? exitFocus() : enterFocus(n);
      });
      setFocusIcon(focusBtn, false);
      act('↗', 'Open in a real browser tab', function () {
        if (n.type === 'web') { if (n.url) Shell.openExternal(n.url); }
        else {
          var t = activeTab(n);
          if (t) Shell.openExternal(Shell.urlFor(t));   // the tab is the file ref
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
      if (isPlain(n)) return;
      focus && focus.id === n.id ? exitFocus() : enterFocus(n);
    });
    // Capture phase so link mode preempts dragging, waking a frame, and
    // editing a note — all node types answer clicks the same way while linking.
    root.addEventListener('pointerdown', function (e) {
      // The right button belongs to the pan, over a window as much as anywhere
      // else, and a pan must not change what is selected on its way past.
      if (e.button !== 0) return;
      if (linking) {
        e.preventDefault(); e.stopPropagation();
        handleLinkClick(n);
        return;
      }
      claimNode(n.id, e);
    }, true);

    shield.addEventListener('click', function (e) {
      e.stopPropagation();
      setLive(n.id);
    });

    // A shape has no visible title bar to grab, and giving it one would put an
    // invisible 34px band over whatever is underneath. So a shape is dragged by
    // its own ink instead. Capture lands on .body (see the note in startDrag —
    // it must not be the node root).
    if (n.type === 'shape') {
      body.addEventListener('pointerdown', function (e) {
        if (linking) return;                 // link mode owns the click
        startDrag(e, n);
      });
    }

    /* Same problem, different answer. A text box has no bar either, but its
       body is an editor, so a plain click has to keep meaning "put the caret
       here". So: while the caret is elsewhere the words are a drag handle, and
       a press that never moves falls through to focusing the editor. Once it
       has focus the editor owns every click, and Escape or a click on the
       canvas hands the node back. */
    if (n.type === 'text') {
      body.addEventListener('pointerdown', function (e) {
        if (linking) return;
        var ta = body.querySelector('.note-text');
        if (!ta || document.activeElement === ta) return;
        e.preventDefault();       // no focus-on-mousedown; the click decides
        startDrag(e, n, function () { ta.focus(); });
      });
    }

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
        var f = refFromDrag(e.dataTransfer);
        if (f) { addTab(n, f); markDirty(); }
      });
    }

    var rec = { root: root, tabsEl: tabsEl, bodyEl: body, shield: shield, focusBtn: focusBtn, panes: new Map() };
    root.addEventListener('mouseenter', function () { syncScrollbars(rec); });
    root.addEventListener('mouseleave', function () { syncScrollbars(rec); });
    els.set(n.id, rec);
    nodesEl.appendChild(root); // append only — never reorder
    return rec;
  }

  /* The tab bar hides itself in CSS; the scrollbar inside a frame cannot, since
     it belongs to that document. So ask the DOM the same question the CSS asks
     and push the answer into every frame the window holds. Keep the selector in
     step with the reveal rule in style.css. */
  function syncScrollbars(rec) {
    var on = rec.root.matches(':hover, .selected, .focused, .dragging');
    rec.root.querySelectorAll('iframe').forEach(function (f) {
      Shell.showScrollbars(f, on);
    });
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

    // Plain types have no tabs at all — n.tabs is undefined, so the forEach
    // below would throw. Each one needs its own branch here.
    if (n.type === 'note') {
      strip.appendChild(el('span', 'tab active', 'Note'));
      return;
    }
    if (n.type === 'text') {
      strip.appendChild(el('span', 'tab active', 'Text'));
      return;
    }
    if (n.type === 'shape') {
      strip.appendChild(el('span', 'tab active', SHAPE_LABEL[n.kind] || 'Shape'));
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
    // A text box is a note without the sticky styling — same editor, same
    // one-way persistence, so they share this branch and differ only in CSS.
    if (n.type === 'note' || n.type === 'text') {
      if (!rec.panes.has('text')) {
        var pane = el('div', 'pane');
        var ta = el('div', 'note-text');
        ta.contentEditable = 'true';
        ta.spellcheck = false;
        ta.textContent = n.text || '';
        /* innerText, not textContent. Pressing Enter in a contenteditable
           breaks the line with a <div> or a <br>, and textContent cannot see
           either — "One<br>Two" reads back as "OneTwo", so every line break
           was being lost on reload. innerText reads what is on screen, so the
           newlines survive into n.text, and writing them back renders as two
           lines again because both editors are white-space: pre / pre-wrap.
           It also matters more than it used to: a text box is measured from
           n.text, so a lost break left the box a whole line too short. */
        ta.addEventListener('input', function () {
          n.text = ta.innerText;
          if (n.type === 'text') { fitText(n, rec); renderEdges(); }
          markDirty();
        });
        /* Swallow keys so shortcuts don't fire mid-sentence. Escape stops the
           editing but is swallowed too, deliberately: it leaves the node
           SELECTED rather than letting the board's own Escape clear the
           selection as well. That is the only way to delete a text box now
           that it has no chrome and so no ✕ — Escape, then Delete. A second
           Escape, with nothing focused, deselects as it always did. */
        ta.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); selectOnlyNode(n.id); return; }
          e.stopPropagation();
        });
        // A pasted paragraph must arrive as text, not as somebody else's markup.
        ta.addEventListener('paste', function (e) {
          e.preventDefault();
          var txt = (e.clipboardData || window.clipboardData).getData('text/plain');
          document.execCommand('insertText', false, txt.replace(/\r\n?/g, '\n'));
        });
        pane.appendChild(ta);
        rec.bodyEl.insertBefore(pane, rec.shield);
        rec.panes.set('text', { pane: pane });
        rec.shield.hidden = true; // always directly editable
      }
      return;
    }

    if (n.type === 'shape') {
      if (!rec.panes.has('shape')) {
        var sp = el('div', 'pane');
        var sv = svg('svg', { class: 'shape-svg', preserveAspectRatio: 'none' });
        sp.appendChild(sv);
        rec.bodyEl.insertBefore(sp, rec.shield);
        rec.panes.set('shape', { pane: sp, svg: sv });
        rec.shield.hidden = true;
      }
      syncShape(n, rec);
      return;
    }

    if (n.type === 'web') {
      if (!n.url) return;
      if (!rec.panes.has(n.url)) {
        rec.panes.forEach(function (p) { p.pane.remove(); });
        rec.panes.clear();
        var wp = el('div', 'pane');
        var embed = Shell.createEmbed({ kind: 'web', url: n.url });
        embed.addEventListener('load', function () { syncScrollbars(rec); });
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
      var em = Shell.createEmbed({ kind: t.kind, root: t.root, path: t.path });
      em.addEventListener('load', function () { syncScrollbars(rec); });
      p.appendChild(em);
      rec.bodyEl.insertBefore(p, rec.shield);
      rec.panes.set(t.id, { pane: p });
    }
    rec.panes.forEach(function (v, k) { v.pane.hidden = (k !== t.id); });
  }

  /* Shapes are drawn at 1:1 with the node's own size rather than stretched
     from a fixed viewBox — a stretched viewBox gives a resized ellipse a fat
     axis and a thin one. The cost is that geometry must be rewritten whenever
     the node resizes: syncNode covers render(), startResize covers the drag. */
  function syncShape(n, rec) {
    var p = rec.panes.get('shape');
    if (!p) return;
    var s = p.svg;
    var w = Math.max(2, n.w), h = Math.max(2, n.h);
    var sw = n.width || 2;
    var pad = sw / 2 + 1;            // keep the stroke inside the box
    var stroke = n.stroke || '#5b8cff';

    var fill = n.fill || 'none';

    s.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    while (s.firstChild) s.removeChild(s.firstChild);

    var base = {
      fill: fill, stroke: stroke, 'stroke-width': sw,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'pointer-events': 'none',
    };

    /* A shape node is a transparent rectangle, so without this the whole
       bounding box would swallow clicks — draw a rectangle around a window and
       the window underneath becomes unusable. Only the ink is clickable: an
       unfilled shape hit-tests on its stroke, a filled one on its fill too.
       The fat invisible twin is the same trick renderEdges uses to make a
       4px arrow grabbable. */
    var hit = {
      fill: fill, stroke: 'transparent',
      'stroke-width': Math.max(sw + 14, 18),
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'pointer-events': fill === 'none' ? 'stroke' : 'all',
    };

    function pair(tag, geom) {
      s.appendChild(svg(tag, Object.assign({}, geom, hit)));
      s.appendChild(svg(tag, Object.assign({}, geom, base)));
    }

    if (n.kind === 'ellipse') {
      pair('ellipse', {
        cx: w / 2, cy: h / 2,
        rx: Math.max(1, w / 2 - pad), ry: Math.max(1, h / 2 - pad),
      });
      return;
    }

    if (n.kind === 'line' || n.kind === 'arrow') {
      var x1 = pad, y1 = pad, x2 = w - pad, y2 = h - pad;
      var geom = { x1: x1, y1: y1, x2: x2, y2: y2 };
      s.appendChild(svg('line', Object.assign({}, geom, hit, { fill: 'none', 'pointer-events': 'stroke' })));
      s.appendChild(svg('line', Object.assign({}, geom, base, { fill: 'none' })));
      if (n.kind === 'arrow') {
        // Same head polygon the arrows between windows use (renderEdges).
        var a = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        var g = svg('g', { transform: 'translate(' + x2 + ',' + y2 + ') rotate(' + a + ')' });
        g.appendChild(svg('path', {
          d: 'M0,0L-17,-9L-12.5,0L-17,9Z', fill: stroke, stroke: 'none', 'pointer-events': 'all',
        }));
        s.appendChild(g);
      }
      return;
    }

    pair('rect', {
      x: pad, y: pad,
      width: Math.max(1, w - pad * 2), height: Math.max(1, h - pad * 2),
      rx: n.radius || 0,
    });
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
    if (n.type === 'text') fitText(n, rec);   // the words set the box, not n.w
    r.classList.toggle('selected', selNodes.has(n.id));
    r.classList.toggle('live', liveId === n.id);
    r.classList.toggle('focused', !!focus && focus.id === n.id);
    r.classList.toggle('linksrc', !!linking && linking.from === n.id);
    if (rec.focusBtn) setFocusIcon(rec.focusBtn, !!focus && focus.id === n.id);
    if (!isPlain(n)) rec.shield.hidden = (liveId === n.id);
    syncTabs(n, rec);
    ensurePane(n, rec);
    syncScrollbars(rec);   // the classes just above are half of what it reads
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

  /* Where an arrow actually runs, border to border. Drawing it and hit-testing
     it against the marquee are two callers that must agree, so there is one
     function for it. */
  function edgeSeg(ed) {
    var a = nodeById(ed.from), b = nodeById(ed.to);
    if (!a || !b) return null;
    var ca = center(a), cb = center(b);
    return { p1: borderPoint(a, ca, cb), p2: borderPoint(b, cb, ca) };
  }

  function renderEdges() {
    edgesEl.textContent = '';
    state.edges.forEach(function (ed) {
      var seg = edgeSeg(ed);
      if (!seg) return;
      var p1 = seg.p1, p2 = seg.p2;
      var d = 'M' + p1.x + ',' + p1.y + 'L' + p2.x + ',' + p2.y;

      var g = svg('g', {});
      if (selEdges.has(ed.id)) g.setAttribute('class', 'sel');

      // Selected on pointerdown by the viewport handler — see the note in
      // inkNode. A click listener here never fires, because the marquee
      // captures the pointer and pointer capture retargets mouseup.
      var hit = svg('path', { d: d, class: 'hit', 'data-edge': ed.id });
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

  /* ------------------------------------------------------------------ ink
   *
   * A sibling SVG of #edges in the same world-coordinate trick, but rendered
   * INCREMENTALLY. renderEdges() wipes its whole subtree on every call and
   * runs on every pointermove during a drag — fine for a handful of edges,
   * ruinous for hundreds of strokes.
   *
   * perfect-freehand returns a filled outline rather than a stroked line, so
   * the thickness is baked into the geometry in world units. That is what we
   * want: ink belongs to the world and should scale with it, exactly like a
   * node's size. The pen's *feel* stays constant instead — penSize is divided
   * by the camera zoom when a stroke is made, so drawing at 25% and at 250%
   * both put down a line the same number of screen pixels wide.
   *
   * Invariant 5 still bites for anything actually stroked here: the selection
   * halo and the invisible hit path are widths, not geometry, so they divide
   * by --ez like the edges do.
   */
  var inkEls = new Map();        // stroke id -> <g>
  var penOn = false;
  var eraseOn = false;
  var penSize = 4;
  var penColor = '#ffd166';
  var ERASE_R = 16;              // screen px; converted to world at use

  function strokePath(s) {
    var pf = window.PerfectFreehand;
    if (!pf) return '';
    var pts = pf.getStroke(s.pts, {
      size: s.size, thinning: 0.55, smoothing: 0.5, streamline: 0.5,
      simulatePressure: s.pts[0] && s.pts[0].length < 3,
      last: true,
    });
    if (!pts.length) return '';
    var d = 'M' + pts[0][0].toFixed(2) + ',' + pts[0][1].toFixed(2);
    for (var i = 1; i < pts.length; i++) d += 'L' + pts[i][0].toFixed(2) + ',' + pts[i][1].toFixed(2);
    return d + 'Z';
  }

  function inkNode(s) {
    var g = svg('g', { class: 'stroke' + (selStrokes.has(s.id) ? ' sel' : '') });
    var d = strokePath(s);
    /* Selection is claimed on pointerdown by the viewport handler, keyed off
       this attribute — NOT by a click listener here. Whichever gesture the
       press turns into captures the pointer on pointerdown, and pointer
       capture retargets mouseup, so the click would fire on #viewport and
       never reach this element. That is invariant 3, and it is why arrows
       were unselectable too. */
    var hit = svg('path', { d: d, class: 'hit', 'data-stroke': s.id });
    g.appendChild(hit);
    g.appendChild(svg('path', { d: d, fill: s.color, class: 'body' }));
    return g;
  }

  /* Adds and removes only what changed. Called after a stroke is committed or
     deleted, never from a pointermove path. */
  function renderInk() {
    inkEls.forEach(function (g, id) {
      if (!state.strokes.some(function (s) { return s.id === id; })) { g.remove(); inkEls.delete(id); }
    });
    state.strokes.forEach(function (s) {
      var g = inkEls.get(s.id);
      if (!g) { g = inkNode(s); inkEls.set(s.id, g); inkEl.appendChild(g); return; }
      g.setAttribute('class', 'stroke' + (selStrokes.has(s.id) ? ' sel' : ''));
    });
  }

  function rebuildInk() {
    inkEls.forEach(function (g) { g.remove(); });
    inkEls.clear();
    selStrokes.clear();
    renderInk();
  }

  /* Ramer-Douglas-Peucker. A raw pointermove trail is hundreds of points per
     stroke, which makes the board file unreadable and slow to parse. */
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    var a = pts[0], b = pts[pts.length - 1];
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    var dmax = 0, idx = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = len === 0
        ? Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1])
        : Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps) {
      return simplify(pts.slice(0, idx + 1), eps).slice(0, -1)
        .concat(simplify(pts.slice(idx), eps));
    }
    return [a, b];
  }

  /* Pen and eraser share one surface and are mutually exclusive. The surface
     exists only while one of them is on, so it can never sit there quietly
     eating clicks the way the old help overlay did. */
  function syncTools() {
    // Select is the absence of the other three, so there is no flag of its own
    // to hold in step — it simply lights up when nothing else is lit.
    $('#selectBtn').classList.toggle('on', !penOn && !eraseOn && !linking);
    $('#penBtn').classList.toggle('on', penOn);
    $('#eraseBtn').classList.toggle('on', eraseOn);
    viewport.classList.toggle('drawing', penOn);
    viewport.classList.toggle('erasing', eraseOn);
    $('#drawSurface').hidden = !(penOn || eraseOn);
    $('#eraseRing').hidden = !eraseOn;
  }

  /* Back to the marquee: every other tool off. Nothing to turn ON, because the
     band is what the canvas does when no mode owns the left button. */
  function selectTool() {
    if (penOn) togglePen(false);
    if (eraseOn) toggleErase(false);
    if (linking) toggleLink();
  }

  function togglePen(force) {
    penOn = force === undefined ? !penOn : !!force;
    if (penOn) { eraseOn = false; if (linking) toggleLink(); }
    syncTools();
    if (penOn) toast('Pen: drag to draw, over documents too. Esc to stop.');
  }

  function toggleErase(force) {
    eraseOn = force === undefined ? !eraseOn : !!force;
    if (eraseOn) { penOn = false; if (linking) toggleLink(); }
    syncTools();
    if (eraseOn) toast('Eraser: drag across strokes to remove them. Esc to stop.');
  }

  /* Distance from a point to a line segment, all in world units. Comparing
     against the stroke's own half-width means a fat stroke is easier to hit
     than a thin one, which is what the eye expects. */
  function distToSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function strokeNear(s, wx, wy, radius) {
    var reach = radius + s.size / 2;
    if (s.pts.length === 1) return Math.hypot(wx - s.pts[0][0], wy - s.pts[0][1]) <= reach;
    for (var i = 1; i < s.pts.length; i++) {
      var a = s.pts[i - 1], b = s.pts[i];
      if (distToSeg(wx, wy, a[0], a[1], b[0], b[1]) <= reach) return true;
    }
    return false;
  }

  /* Whole strokes, not partial rubbing-out. Splitting a stroke mid-path would
     mean rewriting its point array and re-deriving two outlines; for marking
     up a document, taking the whole pen mark is both simpler and what you
     actually want. */
  function eraseAt(sx, sy) {
    var w = screenToWorld(sx, sy);
    var radius = ERASE_R / state.camera.z;      // constant on screen
    var keep = [], hit = 0;
    state.strokes.forEach(function (s) {
      if (strokeNear(s, w.x, w.y, radius)) hit++; else keep.push(s);
    });
    if (!hit) return 0;
    state.strokes = keep;
    // Erasing a selected stroke drops it from the selection; a band selection
    // makes that likelier than it used to be, so prune the whole set.
    selStrokes.forEach(function (id) {
      if (!keep.some(function (s) { return s.id === id; })) selStrokes.delete(id);
    });
    renderInk();
    return hit;
  }

  function startErase(e) {
    holdSelection();
    var cap = $('#drawSurface');
    cap.setPointerCapture(e.pointerId);
    var removed = eraseAt(e.clientX, e.clientY);

    function move(ev) {
      moveRing(ev.clientX, ev.clientY);
      removed += eraseAt(ev.clientX, ev.clientY);
    }
    function up(ev) {
      cap.releasePointerCapture(ev.pointerId);
      cap.removeEventListener('pointermove', move);
      cap.removeEventListener('pointerup', up);
      // One dirty mark for the whole sweep, not one per stroke removed.
      if (removed) markDirty();
    }
    cap.addEventListener('pointermove', move);
    cap.addEventListener('pointerup', up);
  }

  /* The ring is the eraser's cursor: a plain CSS cursor cannot show a radius
     that changes with zoom, and knowing what you are about to remove matters. */
  function moveRing(sx, sy) {
    var r = $('#eraseRing');
    r.style.left = sx + 'px';
    r.style.top = sy + 'px';
    r.style.width = r.style.height = (ERASE_R * 2) + 'px';
  }

  /* Claims the drag away from startPan. Same capture idiom as startDrag:
     capture on the element the listener is on, listeners on that element,
     release in up. */
  function startStroke(e) {
    holdSelection();
    var cap = $('#drawSurface');
    var p = screenToWorld(e.clientX, e.clientY);
    var z = state.camera.z;
    var s = {
      id: uid('s'),
      // World units, so the stroke keeps its size relative to the documents
      // around it; dividing by z is what makes the pen feel identical at
      // every zoom level.
      size: penSize / z,
      color: penColor,
      pts: [[p.x, p.y, e.pressure || 0.5]],
    };

    var live = svg('path', { fill: s.color, class: 'live' });
    inkEl.appendChild(live);
    cap.setPointerCapture(e.pointerId);

    function move(ev) {
      var w = screenToWorld(ev.clientX, ev.clientY);
      s.pts.push([w.x, w.y, ev.pressure || 0.5]);
      live.setAttribute('d', strokePath(s));   // one element, not a rebuild
    }
    function up(ev) {
      cap.releasePointerCapture(ev.pointerId);
      cap.removeEventListener('pointermove', move);
      cap.removeEventListener('pointerup', up);
      live.remove();
      // A dot is a legitimate mark; anything shorter is a stray click.
      if (s.pts.length >= 2) {
        s.pts = simplify(s.pts, 0.6 / z);
        state.strokes.push(s);
        renderInk();
        markDirty();
      }
    }
    cap.addEventListener('pointermove', move);
    cap.addEventListener('pointerup', up);
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

  /* ---------------------------------------------------------------- selection
   *
   * Four ways in, one way out. Everything that changes what is selected writes
   * the sets and then calls syncSelection(); nothing anywhere else touches the
   * `.selected` class or the `sel` class on a stroke or an arrow.
   *
   *   claimNode      a press on a node. Shift toggles that node. A plain press
   *                  on a member of a group leaves the group alone — that is
   *                  what makes a group draggable from any one of its windows —
   *                  and a plain press on anything else selects it alone.
   *   selectOnlyNode one node and nothing else, for code that creates a node or
   *                  hands one back.
   *   toggleIn       one stroke or arrow, picked by the viewport handler.
   *   band           the marquee, which writes all three sets at once.
   */
  function selCount() { return selNodes.size + selStrokes.size + selEdges.size; }

  function clearSel() { selNodes.clear(); selStrokes.clear(); selEdges.clear(); }

  function raise(id) { var n = nodeById(id); if (n) n.zi = ++zTop; }

  /* A plain press on a member of a band keeps the whole band — that is what
     lets a band be dragged by any one of its windows. But a press that turns
     out to be a CLICK, with no travel, means "just this one", so the collapse
     is deferred to pointerup and skipped if the pointer went anywhere. Without
     it, clicking a banded window to read it and then pressing Delete would
     take all of them. */
  var pendingCollapse = null;   // { id, x, y }

  function claimNode(id, e) {
    if (e.shiftKey) {
      if (selNodes.has(id)) selNodes.delete(id); else selNodes.add(id);
    } else if (!selNodes.has(id)) {
      clearSel();
      selNodes.add(id);
    } else if (selNodes.size > 1) {
      pendingCollapse = { id: id, x: e.clientX, y: e.clientY };
    }
    raise(id);
    syncSelection();
  }

  function selectOnlyNode(id) {
    clearSel();
    selNodes.add(id);
    raise(id);
    syncSelection();
  }

  function toggleIn(set, id, additive) {
    if (additive && set.has(id)) set.delete(id); else set.add(id);
  }

  /* Pushes the sets at the DOM. Nodes are a class and a z-index each; strokes
     and arrows carry their state inside SVG that renderInk and renderEdges
     own. Cheap enough to run per pointermove while a band is being dragged —
     renderEdges already runs on every frame of a node drag. It is deliberately
     NOT render(): that would rebuild panes and re-run ensurePane on every
     frame, and structural sync is not what a selection change needs. */
  function syncSelection() {
    state.nodes.forEach(function (m) {
      var rec = els.get(m.id);
      if (!rec) return;
      rec.root.classList.toggle('selected', selNodes.has(m.id));
      rec.root.style.zIndex = focus && focus.id === m.id ? 900 : (m.zi || 1);
      syncScrollbars(rec);
    });
    renderInk();
    renderEdges();
  }

  /* Delete, for every kind at once. One pass and one markDirty, so undo folds
     a banded delete into a single entry however many things were in it. */
  function deleteSelection() {
    if (!selCount()) return;
    if (selNodes.size) {
      if (focus && selNodes.has(focus.id)) exitFocus();
      state.nodes = state.nodes.filter(function (n) { return !selNodes.has(n.id); });
      // An arrow to a window that just went is an arrow to nothing.
      state.edges = state.edges.filter(function (e) {
        return !selNodes.has(e.from) && !selNodes.has(e.to);
      });
      if (liveId && selNodes.has(liveId)) liveId = null;
    }
    if (selStrokes.size) {
      state.strokes = state.strokes.filter(function (s) { return !selStrokes.has(s.id); });
    }
    if (selEdges.size) {
      state.edges = state.edges.filter(function (e) { return !selEdges.has(e.id); });
    }
    clearSel();
    render();
    renderInk();
    markDirty();
  }

  function setLive(id) {
    liveId = id;
    state.nodes.forEach(function (m) {
      var rec = els.get(m.id);
      if (!rec || isPlain(m)) return;
      rec.shield.hidden = (m.id === id);
      rec.root.classList.toggle('live', m.id === id);
    });
  }

  function addNode(n) {
    n.id = n.id || uid('n');
    n.zi = ++zTop;
    state.nodes.push(n);
    render();
    selectOnlyNode(n.id);
    markDirty();
    return n;
  }

  /* A tab carries its root id alongside the path. `root` is null for a pasted
     screenshot (which lives under _canvas/assets, outside every root) and for
     tabs migrated from a v1 board — urlFor handles both shapes. */
  function tabFromFile(f) {
    return {
      id: uid('t'), kind: f.kind, root: f.root || null,
      path: f.path, title: f.name ? baseName(f.name) : baseName(f.path),
    };
  }

  function sameFile(t, f) {
    return t.path === f.path && (t.root || null) === (f.root || null);
  }

  function nodeFromFile(f, x, y) {
    var s = defaultSize(f.kind);
    var tab = tabFromFile(f);
    return addNode({
      type: 'doc', x: Math.round(x), y: Math.round(y), w: s.w, h: s.h,
      tabs: [tab], active: tab.id,
    });
  }

  /* The rail puts a whole file ref in the drag payload, so a drop needs no
     lookup table. text/plain is kept for drags out to other applications. */
  function refFromDrag(dt) {
    try {
      var raw = dt.getData(DRAG_TYPE);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  /*
   * Pasted or dropped images. Each one is written to disk first and then added
   * exactly like a file from the rail — the node holds a path with kind
   * 'image', which createEmbed already renders, so nothing downstream has to
   * know a screenshot is any different from a checked-in PNG.
   *
   * They are deliberately not inlined into the board: the board POST caps at
   * 8MB and the localStorage draft lane around 5MB, so a couple of screenshots
   * would make autosave fail without saying so.
   */
  async function dropImages(list, x, y) {
    var imgs = [];
    for (var i = 0; i < list.length; i++) {
      if (/^image\//.test(list[i].type)) imgs.push(list[i]);
    }
    if (!imgs.length) return;

    var step = 0;
    for (var j = 0; j < imgs.length; j++) {
      var blob = imgs[j];
      var ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      // A file dragged from Explorer has a real name worth keeping; a clipboard
      // paste usually arrives as a generic "image.png", so call that what it is.
      var hint = blob.name && !/^image\.\w+$/i.test(blob.name) ? blob.name : 'screenshot';
      try {
        // No root: assets live under _canvas/assets, outside every picked
        // folder, and resolve through urlFor's bare-path branch.
        var f = await Shell.saveAsset(blob, boardName, ext, hint);
        f.root = null;
        nodeFromFile(f, x + step, y + step);
        step += 28;               // fan out, rather than stacking exactly
      } catch (e) {
        toast('Could not save image: ' + e.message);
      }
    }
  }

  function addTab(n, f) {
    var existing = n.tabs.find(function (t) { return sameFile(t, f); });
    if (existing) { n.active = existing.id; render(); return; }
    var tab = tabFromFile(f);
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
    selNodes.delete(id);
    if (liveId === id) liveId = null;
    render();
    markDirty();
  }

  function duplicateNode(id) {
    var n = nodeById(id);
    if (!n) return null;
    var copy = JSON.parse(JSON.stringify(n));
    copy.id = uid('n');
    copy.x += 40; copy.y += 40;
    if (copy.tabs) {
      var map = {};
      copy.tabs.forEach(function (t) { var old = t.id; t.id = uid('t'); map[old] = t.id; });
      copy.active = map[n.active] || copy.tabs[0].id;
    }
    return addNode(copy);
  }

  /* Ctrl+D over a band copies the lot, and the copies become the selection.
     addNode selects each new node as it lands, so without the re-selection at
     the end only the last copy would look duplicated. */
  function duplicateSelection() {
    var ids = [];
    selNodes.forEach(function (id) { ids.push(id); });
    if (!ids.length) return;
    var made = [];
    ids.forEach(function (id) { var c = duplicateNode(id); if (c) made.push(c.id); });
    clearSel();
    made.forEach(function (id) { selNodes.add(id); });
    syncSelection();
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
    syncTools();      // Select lights back up when arrow mode ends
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

  /* A drag on the canvas is never a text selection.
   *
   * pointerdown cannot be preventDefault()ed (invariant 2), so the browser is
   * free to start a native selection underneath a pan, a stroke, or a shape
   * drag: sweep the pointer across a note and its words come up blue, and the
   * growing selection then fights the gesture for the pointer.
   *
   * selectstart is the only hook that lands after pointerdown and before the
   * selection exists. CSS cannot do this job — user-select:none applied when
   * the gesture starts does not cancel a selection already under way, and
   * putting it on #world permanently would take the notes' own editors with
   * it. So every canvas gesture calls holdSelection() and nothing releases it:
   * the flag is cleared by the next pointerup or pointercancel anywhere, which
   * is exactly the end of the gesture and cannot leak if a handler is skipped.
   */
  var noSelect = false;
  function holdSelection() { noSelect = true; }

  function startDrag(e, n, onClick) {
    if (focus) return;
    if (e.button !== 0) return;   // the right button pans, over a window too
    // Two subtleties, both learned the hard way:
    //  - No preventDefault(): on pointerdown it suppresses the compatibility
    //    mouse events, which kills the dblclick that opens webpage mode.
    //    Text selection is stopped by holdSelection() instead.
    //  - Capture on the bar itself, not the node root. Pointer capture also
    //    retargets mousedown/mouseup, so capturing on the root would make the
    //    click land on the root — and .chrome, being its child, would never
    //    see the dblclick at all.
    holdSelection();
    var cap = e.currentTarget;
    var sx = e.clientX, sy = e.clientY;
    var moved = false;

    /* Everything selected moves together. The node under the pointer was
       already claimed by the root's capture-phase handler, which ran before
       this one, so by now the sets say exactly what should travel: a press on
       a member of a band left the band intact, and a press on anything else
       collapsed it to that node alone. The fallback covers the one case that
       handler leaves out — a shift-press that toggled this node OFF and then
       dragged it. */
    var team = [];
    selNodes.forEach(function (id) {
      var m = nodeById(id), r = els.get(id);
      if (m && r) team.push({ n: m, rec: r, ox: m.x, oy: m.y });
    });
    if (!selNodes.has(n.id)) team.push({ n: n, rec: els.get(n.id), ox: n.x, oy: n.y });
    team.forEach(function (t) { t.rec.root.classList.add('dragging'); });
    cap.setPointerCapture(e.pointerId);

    function move(ev) {
      // A few pixels of slop, or a click with a shaky hand nudges the node
      // instead of opening it for editing.
      if (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 3) moved = true;
      var dx = (ev.clientX - sx) / state.camera.z;
      var dy = (ev.clientY - sy) / state.camera.z;
      team.forEach(function (t) {
        t.n.x = Math.round(t.ox + dx);
        t.n.y = Math.round(t.oy + dy);
        t.rec.root.style.left = t.n.x + 'px';
        t.rec.root.style.top = t.n.y + 'px';
      });
      renderEdges();
    }
    function up(ev) {
      team.forEach(function (t) { t.rec.root.classList.remove('dragging'); });
      cap.releasePointerCapture(ev.pointerId);
      cap.removeEventListener('pointermove', move);
      cap.removeEventListener('pointerup', up);
      if (!moved && onClick) {
        team.forEach(function (t) { t.n.x = t.ox; t.n.y = t.oy; syncNode(t.n); });
        onClick();
        return;
      }
      markDirty();
    }
    cap.addEventListener('pointermove', move);
    cap.addEventListener('pointerup', up);
  }

  function startResize(e, n, dir) {
    if (focus) return;
    // Ahead of stopPropagation, so a right-press on a grip still reaches the
    // viewport and pans. Selection is the root capture handler's job.
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    var cap = e.currentTarget;  // the grip — see the note in startDrag
    var rec = els.get(n.id);
    var sx = e.clientX, sy = e.clientY, ow = n.w, oh = n.h;
    cap.setPointerCapture(e.pointerId);

    // A window needs room for its chrome; a shape or a text box does not, and
    // clamping those to 260x160 makes small annotations impossible.
    var minW = isPlain(n) ? 40 : 260, minH = isPlain(n) ? 30 : 160;

    /* A text box has no free width to drag: the words fix its box. So the same
       grip, on the same drag, changes the type size instead — pull the corner
       out and the writing grows, and fitText re-tightens the border around it.
       The ratio is taken against the ORIGINAL width, so the box moving out from
       under the pointer cannot feed back into the next frame's reading. */
    if (n.type === 'text') {
      var ofs = n.fs || TEXT_FS;
      var base = Math.max(20, ow);
      var tmove = function (ev2) {
        var target = base + (ev2.clientX - sx) / state.camera.z;
        n.fs = Math.max(TEXT_FS_MIN, Math.min(TEXT_FS_MAX, Math.round(ofs * target / base)));
        fitText(n, rec);
        renderEdges();
      };
      var tup = function (ev2) {
        cap.releasePointerCapture(ev2.pointerId);
        cap.removeEventListener('pointermove', tmove);
        cap.removeEventListener('pointerup', tup);
        markDirty();
      };
      cap.addEventListener('pointermove', tmove);
      cap.addEventListener('pointerup', tup);
      return;
    }

    function move(ev) {
      if (dir !== 's') n.w = Math.max(minW, Math.round(ow + (ev.clientX - sx) / state.camera.z));
      if (dir !== 'e') n.h = Math.max(minH, Math.round(oh + (ev.clientY - sy) / state.camera.z));
      rec.root.style.width = n.w + 'px';
      rec.root.style.height = n.h + 'px';
      if (n.type === 'shape') syncShape(n, rec);   // geometry is size-dependent
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

  /* The right button, from anywhere: empty canvas, a window, a shape, or the
     pen's own draw surface. It had to give up the left button to the marquee,
     and the right one turns out to be the better home for it anyway — a board
     covered edge to edge in documents has no empty canvas left to drag. The
     one place it cannot reach is a frame that has been woken up: that document
     swallows the press, and keeps its own context menu with it. */
  function startPan(e) {
    holdSelection();
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

  /* ------------------------------------------------------------- marquee
   *
   * The resting tool: no mode to enter and nothing to switch off. A left drag
   * from empty canvas bands whatever it crosses — windows, ink and arrows
   * alike. Panning and banding are the same gesture with the same hand, so
   * only one of them could keep the left button; the pan went right.
   *
   * The band is a plain fixed div in SCREEN space, so it needs no camera maths
   * of its own and the zoom cannot distort it. Only the hit test converts, once
   * per move, and it runs live rather than on release: a band whose result you
   * cannot see until you let go is a band you end up drawing twice.
   *
   * Intersection, not containment. A window is usually bigger than the gap you
   * have room to drag in, and demanding the whole thing inside the box makes a
   * board of full-size documents impossible to select.
   */
  function worldRect(ax, ay, bx, by) {
    var a = screenToWorld(ax, ay), b = screenToWorld(bx, by);
    return {
      x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
    };
  }

  /* Segment against an axis-aligned rect, by the slab method: clip the
     segment's parameter range against each of the four edges in turn and see
     whether any of it survives. A segment lying wholly inside falls out of it
     for free, so there is no separate containment case. */
  function segHitsRect(ax, ay, bx, by, r) {
    var t0 = 0, t1 = 1;
    var dx = bx - ax, dy = by - ay;
    var p = [-dx, dx, -dy, dy];
    var q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; continue; }   // parallel and outside
      var t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return true;
  }

  /* A stroke is simplified down to as few as two points, so asking whether any
     of its POINTS is inside the band would miss a long straight line drawn
     clean through it. Every segment is tested instead, against a rect grown by
     the stroke's half-width, so a fat mark is as easy to catch as it is to
     erase. */
  function strokeInRect(s, r) {
    var pad = s.size / 2;
    var g = { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
    var p0 = s.pts[0];
    if (!p0) return false;
    if (s.pts.length === 1) {
      return p0[0] >= g.x0 && p0[0] <= g.x1 && p0[1] >= g.y0 && p0[1] <= g.y1;
    }
    for (var i = 1; i < s.pts.length; i++) {
      if (segHitsRect(s.pts[i - 1][0], s.pts[i - 1][1], s.pts[i][0], s.pts[i][1], g)) return true;
    }
    return false;
  }

  function band(r, base) {
    clearSel();
    base.n.forEach(function (id) { selNodes.add(id); });
    base.s.forEach(function (id) { selStrokes.add(id); });
    base.e.forEach(function (id) { selEdges.add(id); });
    state.nodes.forEach(function (n) {
      if (n.x < r.x1 && n.x + n.w > r.x0 && n.y < r.y1 && n.y + n.h > r.y0) selNodes.add(n.id);
    });
    state.strokes.forEach(function (s) {
      if (strokeInRect(s, r)) selStrokes.add(s.id);
    });
    state.edges.forEach(function (ed) {
      var seg = edgeSeg(ed);
      if (seg && segHitsRect(seg.p1.x, seg.p1.y, seg.p2.x, seg.p2.y, r)) selEdges.add(ed.id);
    });
    syncSelection();
  }

  function startMarquee(e) {
    holdSelection();
    var box = $('#marquee');
    var x0 = e.clientX, y0 = e.clientY;
    /* Shift adds to what is already selected; a plain drag replaces it. Copied
       up front so every move re-derives from the same starting point, rather
       than accumulating everything the band has ever swept over on its way. */
    var base = e.shiftKey
      ? { n: new Set(selNodes), s: new Set(selStrokes), e: new Set(selEdges) }
      : { n: new Set(), s: new Set(), e: new Set() };

    viewport.setPointerCapture(e.pointerId);
    box.hidden = false;
    place(x0, y0);

    function place(x, y) {
      box.style.left = Math.min(x0, x) + 'px';
      box.style.top = Math.min(y0, y) + 'px';
      box.style.width = Math.abs(x - x0) + 'px';
      box.style.height = Math.abs(y - y0) + 'px';
    }

    function move(ev) {
      place(ev.clientX, ev.clientY);
      band(worldRect(x0, y0, ev.clientX, ev.clientY), base);
    }
    function up(ev) {
      box.hidden = true;
      viewport.releasePointerCapture(ev.pointerId);
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
      // A press that never travelled is a click on empty canvas, and a click on
      // empty canvas clears — which is exactly what banding a zero-size rect
      // does, since base is empty unless Shift was held.
      band(worldRect(x0, y0, ev.clientX, ev.clientY), base);
    }
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------- rail

  /* ------------------------------------------------------------------ rail
   *
   * Two views over the board's folders: a lazy tree, and a flat newest-first
   * list. Typing in the search box switches to flat results regardless of
   * mode, because a tree that has only loaded the folders you opened has
   * nothing to filter locally — the search runs on the server.
   */

  var DRAG_TYPE = 'application/x-docs-canvas-ref';

  /* Everything the canvas needs to open a file, so no lookup table is
     required at drop time. `files.find(...)` could not survive lazy loading
     anyway, and it silently did nothing when the entry was missing. */
  function fileRef(f, rootId) {
    return {
      root: rootId || f.root || null,
      path: f.path, name: f.name,
      kind: f.kind, ext: f.ext,
      renderable: f.renderable !== false,
    };
  }

  function openFile(ref) {
    var c = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    var s = defaultSize(ref.kind);
    nodeFromFile(ref, c.x - s.w / 2, c.y - s.h / 2);
  }

  /* One file row, shared by the tree and the flat list. `guides` is the
     ancestor pattern that draws the elbow connectors. */
  function fileRow(ref, guides, isLast) {
    var row = el('div', 'f' + (ref.renderable ? '' : ' dim'));
    row.title = ref.path;
    addGuides(row, guides, isLast);
    row.appendChild(el('span', 'dot ' + (ref.renderable ? ref.kind : 'other')));
    row.appendChild(el('span', 'n', ref.name));

    if (!ref.renderable) {
      // Shown so the tree looks like the real folder, but there is nothing to
      // put on the canvas, so it must not pretend to be draggable.
      row.draggable = false;
      row.title = ref.path + ' — the canvas cannot display this file type';
      return row;
    }

    row.draggable = true;
    row.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ref));
      e.dataTransfer.setData('text/plain', ref.path);
      e.dataTransfer.effectAllowed = 'copy';
      /* Tab bars are hidden until hovered, and Chromium does not update :hover
         during a drag — so without this the tab bar you are aiming at would be
         invisible for the whole drag. The class shows every one of them. */
      document.body.classList.add('dragging-file');
    });
    row.addEventListener('dragend', function () {
      document.body.classList.remove('dragging-file');
    });
    row.addEventListener('click', function () { openFile(ref); });
    return row;
  }

  /* The elbow connectors are pure CSS: one spacer per ancestor, carrying a
     class that says whether that ancestor still has siblings below it, then
     the elbow itself. Lifted from the tree in the file-structure visualiser,
     at rail scale rather than canvas scale. */
  function addGuides(row, guides, isLast) {
    if (!guides) return;
    for (var i = 0; i < guides.length; i++) {
      row.appendChild(el('i', 'gd' + (guides[i] ? ' on' : '')));
    }
    if (guides.length || isLast !== undefined) {
      row.appendChild(el('i', 'gd elbow' + (isLast ? ' last' : '')));
    }
  }

  function dirKey(rootId, dir) { return rootId + '::' + (dir || ''); }

  function isOpen(rootId, dir) {
    var list = state.open[rootId];
    return !!(list && list.indexOf(dir || '') !== -1);
  }

  function setOpen(rootId, dir, on) {
    var list = state.open[rootId] || (state.open[rootId] = []);
    var i = list.indexOf(dir || '');
    if (on && i === -1) list.push(dir || '');
    if (!on && i !== -1) list.splice(i, 1);
    markDirty();
  }

  async function loadDir(rootId, dir) {
    var key = dirKey(rootId, dir);
    if (dirCache.has(key)) return dirCache.get(key);
    var listing = await Shell.listDir(rootId, dir, showAll);
    dirCache.set(key, listing);
    return listing;
  }

  /* Build the children of one folder. Recurses only into folders that are
     already expanded, so a collapsed branch costs one request and no more. */
  async function buildChildren(container, rootId, dir, guides) {
    var listing;
    try { listing = await loadDir(rootId, dir); }
    catch (e) { container.appendChild(el('div', 'tree-msg', 'Could not read this folder')); return; }

    var total = listing.dirs.length + listing.files.length;
    if (!total) { container.appendChild(el('div', 'tree-msg', 'empty')); return; }

    var i = 0;
    for (var d = 0; d < listing.dirs.length; d++, i++) {
      container.appendChild(folderBranch(rootId, dir, listing.dirs[d].name, guides, i === total - 1));
    }
    for (var f = 0; f < listing.files.length; f++, i++) {
      var ref = fileRef(listing.files[f], rootId);
      ref.path = dir ? dir + '/' + listing.files[f].name : listing.files[f].name;
      container.appendChild(fileRow(ref, guides, i === total - 1));
    }
  }

  function folderBranch(rootId, parentDir, name, guides, isLast) {
    var dir = parentDir ? parentDir + '/' + name : name;
    var det = document.createElement('details');
    det.className = 'fold';

    var sum = document.createElement('summary');
    addGuides(sum, guides, isLast);
    sum.appendChild(el('span', 'caret'));
    sum.appendChild(el('span', 'n', name));
    det.appendChild(sum);

    var kids = el('div', 'kids');
    det.appendChild(kids);

    var loaded = false;
    det.addEventListener('toggle', function () {
      setOpen(rootId, dir, det.open);
      if (det.open && !loaded) {
        loaded = true;
        // A child's guides are the parent's, plus whether the parent itself
        // still has siblings below it to draw a line past.
        buildChildren(kids, rootId, dir, guides.concat([!isLast]));
      }
    });

    if (isOpen(rootId, dir)) det.open = true;   // fires toggle, which loads
    return det;
  }

  function rootBranch(root) {
    var det = document.createElement('details');
    det.className = 'fold root';

    var sum = document.createElement('summary');
    sum.appendChild(el('span', 'caret'));
    sum.appendChild(el('span', 'n', root.label));
    sum.title = root.path;

    var x = el('span', 'x', '×');
    x.title = 'Remove this folder from this board (windows using it keep working)';
    x.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      removeRoot(root.id);
    });
    sum.appendChild(x);
    det.appendChild(sum);

    var kids = el('div', 'kids');
    det.appendChild(kids);

    var loaded = false;
    det.addEventListener('toggle', function () {
      setOpen(root.id, '', det.open);
      if (det.open && !loaded) { loaded = true; buildChildren(kids, root.id, '', []); }
    });

    if (isOpen(root.id, '')) det.open = true;
    return det;
  }

  function renderRail() {
    var list = $('#fileList');
    var q = $('#search').value.trim();
    list.textContent = '';

    $('#railTree').classList.toggle('on', railMode === 'tree' && !q);
    $('#railRecent').classList.toggle('on', railMode === 'recent' && !q);
    $('#railAll').classList.toggle('on', showAll);

    if (q) { renderFlat(list, 'search'); return; }
    if (railMode === 'recent') { renderFlat(list, 'recent'); return; }

    if (!state.roots.length) {
      list.appendChild(el('div', 'tree-msg', 'No folders yet.'));
      $('#railCount').textContent = '';
    } else {
      state.roots.forEach(function (r) { list.appendChild(rootBranch(r)); });
      $('#railCount').textContent = state.roots.length + (state.roots.length === 1 ? ' folder' : ' folders');
    }

    var add = el('button', 'add-folder', '+ Add folder');
    add.addEventListener('click', addRoot);
    list.appendChild(add);
  }

  /* Flat list, used for both search results and Recent. Rows carry their
     folder so a hit is identifiable without the tree around it. */
  async function renderFlat(list, which) {
    var ids = state.roots.map(function (r) { return r.id; });
    var q = $('#search').value.trim();

    list.appendChild(el('div', 'tree-msg', which === 'search' ? 'Searching…' : 'Loading…'));
    var hits = which === 'search'
      ? await Shell.search(ids, q, showAll)
      : await Shell.recent(ids, showAll);

    // The box may have changed while the request was in flight.
    if ($('#search').value.trim() !== q) return;
    list.textContent = '';

    $('#railCount').textContent = hits.length + (which === 'search' ? ' found' : ' recent');
    if (!hits.length) {
      list.appendChild(el('div', 'tree-msg', which === 'search' ? 'Nothing matched.' : 'Nothing yet.'));
      return;
    }

    hits.forEach(function (h) {
      var row = fileRow(fileRef(h, h.root), null);
      var where = (h.rootLabel || '') + (h.dir ? '/' + h.dir : '');
      row.appendChild(el('span', 'where', where));
      list.appendChild(row);
    });
  }

  async function addRoot() {
    var btn = $('#fileList .add-folder');
    if (btn) { btn.disabled = true; btn.textContent = 'Choose a folder…'; }
    try {
      var r = await Shell.pickFolder();
      if (!r) return;                                   // cancelled
      if (state.roots.some(function (x) { return x.id === r.id; })) {
        toast('That folder is already on this board');
        return;
      }
      state.roots.push({ id: r.id, label: r.label, path: r.path });
      setOpen(r.id, '', true);                          // land expanded
      markDirty();
    } catch (e) {
      toast('Could not open the folder picker: ' + e.message);
    } finally {
      renderRail();
    }
  }

  /* Only ever touches this board's list. Nodes keep their root id and the
     server keeps resolving it, so open windows are unaffected — which is why
     this needs no confirmation. */
  function removeRoot(id) {
    state.roots = state.roots.filter(function (r) { return r.id !== id; });
    delete state.open[id];
    markDirty();
    renderRail();
  }

  function toggleRail(force) {
    railHidden = force === undefined ? !railHidden : !force;
    $('#rail').classList.toggle('hidden', railHidden);
  }

  /* Panels are views OF the rail, never floating layers over the canvas.
     Invariant 4 exists because a hidden overlay once swallowed every click on
     the board, and a sidebar view cannot do that. */
  var VIEW_TITLE = { files: 'Docs', help: 'Shortcuts', boards: 'Boards' };
  var railView = 'files';

  function setRailView(view) {
    railView = view;
    var rail = $('#rail');
    rail.classList.toggle('help', view === 'help');
    rail.classList.toggle('boards', view === 'boards');
    $('#railTitle').textContent = VIEW_TITLE[view] || 'Docs';
    $('#railCount').hidden = view !== 'files';
    if (view !== 'files') toggleRail(true);
    if (view === 'boards') renderBoards();
  }

  function showHelp(on) {
    if (on === undefined) on = railView !== 'help';
    setRailView(on ? 'help' : 'files');
  }

  function helpOpen() { return railView === 'help' && !railHidden; }
  function panelOpen() { return railView !== 'files' && !railHidden; }

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
      v: 2,
      savedAt: Date.now(),
      camera: state.camera,
      nodes: state.nodes,
      edges: state.edges,
      strokes: state.strokes,
      // The full record, not just ids, so a board opened where roots.json
      // doesn't know these folders can re-register them rather than dangle.
      roots: state.roots,
      open: state.open,
    };
  }

  function markDirty() {
    pushUndo();          // every mutation already funnels through here
    setSaveState('unsaved', 'dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      Shell.draftSet(boardName, serialize());
      setSaveState('draft ✓', 'dirty');
    }, 700);
  }

  /* ------------------------------------------------------------------ undo
   *
   * Snapshots of the whole board, which is affordable because the board is
   * small and serialize() already exists.
   *
   * The subtle part is putting one back. adopt() drops every element and
   * rebuilds, which reloads every iframe — invariant 1, and the precise thing
   * this tool exists to avoid. Undoing a typo must not reload your documents.
   * So restore() writes the state arrays and calls render(), which diffs:
   * syncNode leaves existing nodes alone and ensurePane early-returns on panes
   * that already exist, so untouched frames keep their scroll position. Only
   * a node that genuinely came back from deletion is rebuilt, and that one has
   * to reload because its element is gone.
   */
  var undoStack = [], redoStack = [];
  var UNDO_MAX = 60;
  var pendingSnapshot = null;   // taken before a change, banked once it settles
  var snapshotTimer;
  var restoring = false;

  function snapshotNow() {
    return JSON.stringify({
      nodes: state.nodes, edges: state.edges, strokes: state.strokes,
      roots: state.roots, open: state.open,
    });
  }

  /*
   * Called by markDirty before the change is banked. Coalescing matters: a
   * sticky note fires markDirty on every keystroke and a drag fires it once,
   * but a stroke fires it per stroke. Holding the pre-change snapshot and
   * banking it only after 450ms of quiet turns a burst of typing into one
   * undo entry instead of one per character.
   */
  function pushUndo() {
    if (restoring) return;
    if (pendingSnapshot === null) { pendingSnapshot = lastCommitted; syncHistoryButtons(); }
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(bankUndo, 450);
  }

  function bankUndo() {
    clearTimeout(snapshotTimer);
    if (pendingSnapshot === null) return;
    var now = snapshotNow();
    if (pendingSnapshot !== now) {
      undoStack.push(pendingSnapshot);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
      redoStack.length = 0;        // a new edit forks the future
    }
    pendingSnapshot = null;
    lastCommitted = now;
    syncHistoryButtons();
  }

  /* An undo button that always looks available is a lie about the state of
     the board. Pending counts as available — it banks the moment you press. */
  function syncHistoryButtons() {
    var u = $('#undoBtn'), r = $('#redoBtn');
    if (!u || !r) return;
    u.disabled = !undoStack.length && pendingSnapshot === null;
    r.disabled = !redoStack.length;
  }

  var lastCommitted = snapshotNow();

  function restore(json) {
    var d = JSON.parse(json);
    restoring = true;
    state.nodes = d.nodes || [];
    state.edges = d.edges || [];
    state.strokes = d.strokes || [];
    state.roots = d.roots || [];
    state.open = d.open || {};
    clearSel();
    if (focus && !nodeById(focus.id)) focus = null;
    if (liveId && !nodeById(liveId)) liveId = null;
    state.nodes.forEach(function (n) { if (!n.zi) n.zi = ++zTop; });
    render();          // diffs — does NOT rebuild surviving frames
    syncTextPanes();
    renderInk();
    renderRail();
    restoring = false;
    lastCommitted = snapshotNow();
    markDirty();
    syncHistoryButtons();
  }

  /* ensurePane binds note and text content one way, writing n.text on input
     and never reading it back — fine until undo changes n.text underneath a
     live editor. Only touched when it actually differs, so the caret is not
     disturbed while typing. */
  function syncTextPanes() {
    state.nodes.forEach(function (n) {
      if (n.type !== 'note' && n.type !== 'text') return;
      var rec = els.get(n.id);
      if (!rec) return;
      var pane = rec.panes.get('text');
      if (!pane) return;
      var ed = pane.pane.querySelector('.note-text');
      if (ed && ed.textContent !== (n.text || '')) ed.textContent = n.text || '';
    });
  }

  function undo() {
    bankUndo();                       // fold any in-flight edit in first
    if (!undoStack.length) { toast('Nothing to undo'); return; }
    redoStack.push(snapshotNow());
    restore(undoStack.pop());
  }

  function redo() {
    bankUndo();
    if (!redoStack.length) { toast('Nothing to redo'); return; }
    undoStack.push(snapshotNow());
    restore(redoStack.pop());
  }

  /* Switching boards must not leave the previous board's history around to
     "undo" into — the ids would not even match. */
  function resetHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    pendingSnapshot = null;
    clearTimeout(snapshotTimer);
    lastCommitted = snapshotNow();
    syncHistoryButtons();
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

  /*
   * v1 boards stored bare paths relative to the single served root. Give those
   * tabs the default root id so they resolve through /__root/<id>/ like
   * everything else — except assets, which live outside every root and must
   * keep their bare path.
   */
  function migrate(data) {
    if (!data || (data.v || 1) >= 2) return data;
    var def = defaultRoot;
    data.roots = def ? [def] : [];
    data.open = {};
    if (def) data.open[def.id] = [''];    // land expanded, like a new board
    (data.nodes || []).forEach(function (n) {
      (n.tabs || []).forEach(function (t) {
        if (t.root) return;
        t.root = /^_canvas\/assets\//.test(t.path) ? null : (def ? def.id : null);
      });
    });
    data.v = 2;
    return data;
  }

  function adopt(data) {
    data = migrate(data);
    state.camera = data.camera || { x: 0, y: 0, z: 1 };
    state.nodes = data.nodes || [];
    state.edges = data.edges || [];
    state.strokes = data.strokes || [];
    state.roots = data.roots || [];
    state.open = data.open || {};
    state.nodes.forEach(function (n) { n.zi = ++zTop; });
    clearSel(); liveId = null;
    els.forEach(function (rec) { rec.root.remove(); });
    els.clear();
    dirCache.clear();          // a different board may show different folders
    applyCamera();
    render();
    rebuildInk();              // the only place ink is rebuilt wholesale
    renderRail();
    // Another board's history would undo into node ids that do not exist here.
    resetHistory();
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
      // A brand-new board starts on the served folder, so the tool works out
      // of the box before anything has been picked.
      adopt({
        v: 2, nodes: [], edges: [], strokes: [],
        camera: { x: 0, y: 0, z: 1 },
        roots: defaultRoot ? [defaultRoot] : [],
        open: defaultRoot ? (function (o) { o[defaultRoot.id] = ['']; return o; })({}) : {},
      });
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
      if (penOn) return togglePen(false);
      if (eraseOn) return toggleErase(false);
      if (linking) return toggleLink();
      if (panelOpen()) { setRailView('files'); return; }
      clearSel(); setLive(null); syncSelection();
      return;
    }
    if (typing) return;

    var mod = e.ctrlKey || e.metaKey;
    // Note and text editors stopPropagation on their keydowns, so inside one
    // of those Ctrl+Z stays the browser's own text undo, which is what you
    // want while typing. These only reach the board.
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key.toLowerCase() === 'y' ||
                (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveToDisk(); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleRail(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
    if (mod) return;

    switch (e.key) {
      case 'f': case 'F': fitAll(); break;
      case 'v': case 'V': selectTool(); break;
      case 'l': case 'L': toggleLink(); break;
      case 'p': case 'P': togglePen(); break;
      case 'e': case 'E': toggleErase(); break;
      case '0': fly(function () { state.camera.z = 1; }); markDirty(); break;
      case '?': showHelp(true); break;
      case 'Delete': case 'Backspace': deleteSelection(); break;
    }
  }

  function wireTopbar() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'save': saveToDisk(); break;
        case 'fit': fitAll(); break;
        case 'select': selectTool(); break;
        case 'link': toggleLink(); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'pen': togglePen(); break;
        case 'erase': toggleErase(); break;
        case 'help': showHelp(); break;
        case 'zoom-in': zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2); break;
        case 'zoom-out': zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2); break;
        case 'add-note': {
          var c = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
          addNode({ type: 'note', x: Math.round(c.x - 130), y: Math.round(c.y - 90), w: 260, h: 180, text: '' });
          break;
        }
        case 'add-text': {
          var tc = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
          var tn = addNode({ type: 'text', x: Math.round(tc.x - 40), y: Math.round(tc.y - 32), w: 80, h: 64, fs: TEXT_FS, text: '' });
          var trec = els.get(tn.id);
          var ted = trec && trec.root.querySelector('.note-text');
          if (ted) ted.focus();     // a new text box wants the caret straight away
          break;
        }
        case 'add-shape': {
          // The button carries the kind, so one case serves all four.
          var sc = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
          var kind = b.dataset.shape || 'rect';
          var sz = (kind === 'line' || kind === 'arrow') ? { w: 260, h: 140 } : { w: 240, h: 160 };
          addNode({
            type: 'shape', kind: kind,
            x: Math.round(sc.x - sz.w / 2), y: Math.round(sc.y - sz.h / 2),
            w: sz.w, h: sz.h,
            stroke: '#5b8cff', fill: 'none', width: 2,
          });
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
        case 'open': setRailView(railView === 'boards' ? 'files' : 'boards'); break;
        case 'save-as': saveBoardAs(); break;
        case 'rail-tree':   railMode = 'tree';   $('#search').value = ''; renderRail(); break;
        case 'rail-recent': railMode = 'recent'; $('#search').value = ''; renderRail(); break;
        case 'rail-all':
          showAll = !showAll;
          dirCache.clear();   // cached listings were filtered by the old setting
          renderRail();
          break;
      }
    });

    // 'input' fires live as the picker is dragged; 'change' only on commit.
    // Picking a colour means you intend to draw, so it arms the pen too.
    $('#penColor').addEventListener('input', function (e) {
      penColor = e.target.value;
      if (!penOn) togglePen(true);
    });

    $('#railToggle').addEventListener('click', function () { toggleRail(); });
    // Search now costs a server walk, so don't fire one per keystroke.
    var searchTimer;
    $('#search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderRail, 180);
    });
    /* Renames the board in place — it does NOT switch boards any more. The old
       behaviour meant typing a name silently swapped what you were looking at.
       Opening is the Open panel; creating a copy is Save as. */
    $('#boardName').addEventListener('change', async function () {
      var input = $('#boardName');
      var v = cleanBoardName(input.value);
      if (!v || v === boardName) { input.value = boardName; return; }

      // Renaming onto an existing name would overwrite that board with this
      // one's contents, with no undo but the filesystem. Ask first.
      var existing = await Shell.listBoards();
      if (existing.some(function (b) { return b.name === v; }) &&
          !window.confirm('"' + v + '" already exists. Overwrite it with this board?')) {
        input.value = boardName;
        return;
      }

      var from = boardName;
      boardName = v;
      Shell.setLastBoard(v);
      saveToDisk();
      // The old file stays put: rename-by-copy is the safe direction here.
      toast('Now saving as "' + v + '" — "' + from + '" is still on disk');
    });
  }

  function whenSaved(ms) {
    if (!ms) return 'never saved';
    var d = Math.floor((Date.now() - ms) / 1000);
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    if (d < 86400 * 7) return Math.floor(d / 86400) + 'd ago';
    return new Date(ms).toISOString().slice(0, 10);
  }

  function cleanBoardName(s) {
    return String(s || '').trim().replace(/[^a-z0-9_-]/gi, '');
  }

  async function renderBoards() {
    var list = $('#boardList');
    list.textContent = '';
    list.appendChild(el('div', 'tree-msg', 'Loading…'));

    var boards = await Shell.listBoards();
    if (railView !== 'boards') return;      // switched away while loading
    list.textContent = '';

    if (!boards.length) {
      list.appendChild(el('div', 'tree-msg', 'No boards saved yet. Ctrl+S saves this one.'));
      return;
    }

    boards.forEach(function (b) {
      var row = el('div', 'brd' + (b.name === boardName ? ' current' : ''));

      var main = el('div', 'brd-main');
      main.appendChild(el('div', 'brd-n', b.name));
      var bits = [b.nodes + (b.nodes === 1 ? ' window' : ' windows'), whenSaved(b.savedAt)];
      if (b.folders.length) bits.push(b.folders.join(', '));
      main.appendChild(el('div', 'brd-sub', bits.join(' · ')));
      main.addEventListener('click', function () {
        if (b.name === boardName) { setRailView('files'); return; }
        loadBoard(b.name);
        setRailView('files');
      });
      row.appendChild(main);

      var del = el('button', 'brd-x', '×');
      del.title = 'Delete this board';
      del.addEventListener('click', async function (e) {
        e.stopPropagation();
        // Deleting the board you are looking at would leave the canvas
        // pointing at a file that no longer exists, so make them leave first.
        if (b.name === boardName) { toast('Open another board before deleting this one'); return; }
        if (!window.confirm('Delete board "' + b.name + '"? This cannot be undone.')) return;
        try { await Shell.deleteBoard(b.name); toast('Deleted ' + b.name); renderBoards(); }
        catch (err) { toast('Delete failed: ' + err.message); }
      });
      row.appendChild(del);

      list.appendChild(row);
    });
  }

  /* Save-as, split out from the name field. The field used to *switch* boards
     on Enter, which CONTEXT.md flags as surprising — typing a name and losing
     your board is not what "rename" looks like anywhere else. */
  async function saveBoardAs() {
    var pick = cleanBoardName(window.prompt('Save this board as:', boardName));
    if (!pick) return;
    if (pick === boardName) { saveToDisk(); return; }
    var existing = await Shell.listBoards();
    if (existing.some(function (b) { return b.name === pick; }) &&
        !window.confirm('"' + pick + '" already exists. Overwrite it?')) return;
    boardName = pick;
    $('#boardName').value = pick;
    Shell.setLastBoard(pick);
    saveToDisk();
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    viewport = $('#viewport');
    world = $('#world');
    nodesEl = $('#nodes');
    edgesEl = $('#edges');
    inkEl = $('#ink');
    // Both layers use the same trick: a huge viewBox centred on the origin so
    // negative world coordinates aren't clipped, with the width/height
    // attributes stripped so CSS sizing wins.
    [edgesEl, inkEl].forEach(function (s) {
      s.setAttribute('viewBox', '-50000 -50000 100000 100000');
      s.removeAttribute('width');
      s.removeAttribute('height');
    });

    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('pointerdown', function (e) {
      /* The right button pans, and it pans from anywhere — including from on
         top of a window, which is half the reason for moving it off the left
         one: a board covered in documents has no empty canvas left to drag.
         Hence ahead of the .node test rather than after it. */
      if (e.button === 2) { startPan(e); return; }
      if (e.button !== 0) return;
      if (e.target.closest('.node')) return;
      if (linking) { toggleLink(); return; }

      /* Strokes and arrows are picked here, on pointerdown, because the
         marquee is about to capture the pointer and a captured pointer
         retargets the click away from them (invariant 3). Picking one also
         means not banding — a drag that starts on a stroke should not
         rubber-band the canvas behind it. */
      var pickStroke = e.target.getAttribute && e.target.getAttribute('data-stroke');
      var pickEdge = e.target.getAttribute && e.target.getAttribute('data-edge');
      if (pickStroke || pickEdge) {
        if (!e.shiftKey) clearSel();
        if (pickStroke) toggleIn(selStrokes, pickStroke, e.shiftKey);
        if (pickEdge) toggleIn(selEdges, pickEdge, e.shiftKey);
        setLive(null);
        syncSelection();
        return;
      }

      /* Clearing happens on the way down, not on release, so the board answers
         the press immediately. Shift keeps what is there and adds to it. */
      setLive(null);
      if (!e.shiftKey) { clearSel(); syncSelection(); }
      startMarquee(e);
    });
    viewport.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    viewport.addEventListener('drop', function (e) {
      e.preventDefault();
      var c = screenToWorld(e.clientX, e.clientY);

      // An image dragged in from Explorer arrives as a real File, not a path
      // into the served folder, so it takes the same route as a paste.
      var dropped = e.dataTransfer.files;
      if (dropped && dropped.length) { dropImages(dropped, c.x, c.y); return; }

      var f = refFromDrag(e.dataTransfer);
      if (!f) return;
      nodeFromFile(f, c.x, c.y);
    });

    // Win+Shift+S then Ctrl+V. Ignored while typing, so pasting text into a
    // note or the URL bar still behaves normally.
    window.addEventListener('paste', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!e.clipboardData) return;
      var imgs = [];
      var items = e.clipboardData.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var blob = items[i].getAsFile();
          if (blob) imgs.push(blob);
        }
      }
      if (!imgs.length) return;
      e.preventDefault();
      var c = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      dropImages(imgs, c.x - 310, c.y - 230);
    });

    // The pen draws on its own surface, so it reaches documents as well as
    // empty canvas. It exists only while the mode is on.
    var surf = $('#drawSurface');
    surf.addEventListener('pointerdown', function (e) {
      // The tool keeps the left button; the right one still pans, so the canvas
      // can be moved without putting the pen down first.
      if (e.button === 2) return startPan(e);
      if (e.button !== 0) return;
      if (penOn) return startStroke(e);
      if (eraseOn) return startErase(e);
    });
    // The ring has to track the pointer even when no button is down.
    surf.addEventListener('pointermove', function (e) {
      if (eraseOn) moveRing(e.clientX, e.clientY);
    });

    // See holdSelection(). Capture phase, and on window, so the gesture's own
    // handlers cannot skip the release.
    document.addEventListener('selectstart', function (e) {
      if (noSelect) e.preventDefault();
    });

    /* Right-drag is the pan, and Windows raises the context menu on the button
       coming back UP — that is, at the end of every single pan. Suppressed over
       the canvas and the draw surface only: the rail, the note editors and any
       woken frame keep their menus. (A frame's own contextmenu never leaves the
       frame, so there is nothing to suppress there even if we wanted to.) */
    viewport.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    surf.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('pointerup', function (e) {
      noSelect = false;
      // See claimNode: a press on a banded window collapses the band only if
      // it never became a drag. Capture phase, so it settles before the
      // gesture's own pointerup handlers read the selection.
      if (pendingCollapse) {
        var p = pendingCollapse;
        pendingCollapse = null;
        if (Math.abs(e.clientX - p.x) < 4 && Math.abs(e.clientY - p.y) < 4) selectOnlyNode(p.id);
      }
    }, true);
    window.addEventListener('pointercancel', function () {
      noSelect = false;
      pendingCollapse = null;
    }, true);

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
    syncTools();      // lights Select, which is what a fresh board is in
    applyCamera();

    // Needed before any board loads: it seeds new boards and is the root a
    // v1 board's bare paths get migrated onto.
    try {
      defaultRoot = await Shell.defaultRoot();
    } catch (e) {
      toast('Could not reach the file server — is node _canvas/server.js running?');
    }
    await loadBoard(Shell.lastBoard());   // adopt() renders the rail
  }

  boot();
})();
