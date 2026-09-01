/*
 * Shell — the platform boundary.
 *
 * Everything a desktop build (Tauri/Electron) would do differently lives in
 * this file and nowhere else: how files are listed, how a tab's content
 * element gets made, how boards persist, how an external link opens.
 * app.js never calls fetch, never constructs an <iframe>, never touches
 * localStorage directly. Swapping shells = rewriting this file only.
 */
(function () {
  'use strict';

  var LS_PREFIX = 'docscanvas:';

  function enc(rel) {
    // Paths carry spaces and parens ("2026-03-30 B2B Research/..."), so encode
    // each segment but keep the separators.
    return String(rel).split('/').map(encodeURIComponent).join('/');
  }

  /*
   * Takes either a file ref ({ root, path }) or a bare path string.
   *
   * The bare-string branch is not legacy cruft waiting to be deleted: pasted
   * screenshots live under _canvas/assets/, which is outside every picked
   * root, and v1 boards store bare paths too. Both must keep resolving.
   */
  function urlFor(ref) {
    if (ref && typeof ref === 'object') {
      if (ref.root) return '/__root/' + encodeURIComponent(ref.root) + '/' + enc(ref.path);
      return '/' + enc(ref.path);
    }
    return '/' + enc(ref);
  }

  /* A frame's scrollbar belongs to the document inside it, and no stylesheet out
     here reaches it. Ours are same-origin — the same server serves the docs — so
     inject one rule that keeps the thumb transparent until the canvas puts
     `dc-show` on that document's <html>, matching how the tab bar behaves. Only
     the thumb's colour changes: the gutter stays reserved, so a document never
     re-wraps under the pointer. Re-applied on every load, because following a
     link inside the frame throws the old document away. A cross-origin web node
     throws on contentDocument and is left with its ordinary scrollbar. */
  var QUIET_SCROLL = [
    'html::-webkit-scrollbar,body::-webkit-scrollbar{width:12px;height:12px}',
    'html::-webkit-scrollbar-track,body::-webkit-scrollbar-track{background:transparent}',
    'html::-webkit-scrollbar-corner,body::-webkit-scrollbar-corner{background:transparent}',
    'html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb{',
    'background:transparent;background-clip:content-box;',
    'border:3px solid transparent;border-radius:8px}',
    'html.dc-show::-webkit-scrollbar-thumb,html.dc-show body::-webkit-scrollbar-thumb{',
    'background:rgba(0,0,0,.32);background-clip:content-box}',
  ].join('');

  function blank(c) { return !c || c === 'transparent' || /rgba\(0, *0, *0, *0\)/.test(c); }

  /* The scrollbar's gutter is painted by the frame ELEMENT, not by the document
     inside it, so a transparent track over the frame's white default drew a
     white stripe down the side of every report whose page is not white. Copy
     the document's own canvas background — the whole shorthand, so a gradient
     comes too — onto the frame, and the gutter disappears into the page. The
     canvas comes from <html> unless <html> has none, in which case CSS
     propagates <body>'s, which is where a report usually puts it. */
  function matchBackground(f) {
    try {
      var d = f.contentDocument;
      if (!d || !d.documentElement) return;
      var cs = getComputedStyle(d.documentElement);
      if (cs.backgroundImage === 'none' && blank(cs.backgroundColor) && d.body) {
        cs = getComputedStyle(d.body);
      }
      if (cs.backgroundImage === 'none' && blank(cs.backgroundColor)) return;
      f.style.background = cs.background;
    } catch (e) { /* cross-origin */ }
  }

  function quietScrollbars(f) {
    try {
      var d = f.contentDocument;
      if (!d || !d.documentElement || d.getElementById('dc-quiet-scroll')) return;
      var st = d.createElement('style');
      st.id = 'dc-quiet-scroll';
      st.textContent = QUIET_SCROLL;
      (d.head || d.documentElement).appendChild(st);
    } catch (e) { /* cross-origin: not ours to style */ }
  }

  function frame(src) {
    var f = document.createElement('iframe');
    f.setAttribute('loading', 'lazy');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.addEventListener('load', function () { quietScrollbars(f); matchBackground(f); });
    f.src = src;
    return f;
  }

  var Shell = {
    kind: 'browser',

    // Browser frames are at the mercy of X-Frame-Options / frame-ancestors,
    // so web nodes must be prepared to fall back. A desktop webview isn't.
    canEmbedWeb: false,

    /* ---- folders ------------------------------------------------------
     * The picker runs on the server because the browser's own
     * showDirectoryPicker() never hands back an absolute path, and without
     * one the server cannot serve the folder — which would leave documents
     * as blobs with every relative link broken.
     * A desktop port replaces this one method with dialog.open({directory}).
     */
    async pickFolder() {
      var r = await fetch('/__api/pick-folder', { method: 'POST' });
      var j = await r.json().catch(function () { return null; });
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'picker failed');
      return j.cancelled ? null : j.root;
    },

    async defaultRoot() {
      try {
        var j = await (await fetch('/__api/default-root')).json();
        return j.ok ? j.root : null;
      } catch (e) { return null; }
    },

    /* One level. Lazy by design — a deep folder is only read when opened. */
    async listDir(rootId, dir, all) {
      var q = '?root=' + encodeURIComponent(rootId) +
              '&dir=' + encodeURIComponent(dir || '') +
              (all ? '&all=1' : '');
      var j = await (await fetch('/__api/tree' + q)).json();
      if (!j.ok) throw new Error(j.error || 'listing failed');
      return j;
    },

    // Server-side because a lazily-loaded tree has nothing to filter locally.
    async search(rootIds, q, all) {
      var qs = '?roots=' + encodeURIComponent((rootIds || []).join(',')) +
               '&q=' + encodeURIComponent(q || '') + (all ? '&all=1' : '');
      try {
        var j = await (await fetch('/__api/search' + qs)).json();
        return j.hits || [];
      } catch (e) { return []; }
    },

    async recent(rootIds, all) {
      var qs = '?roots=' + encodeURIComponent((rootIds || []).join(',')) + (all ? '&all=1' : '');
      try {
        var j = await (await fetch('/__api/recent' + qs)).json();
        return j.hits || [];
      } catch (e) { return []; }
    },

    urlFor: urlFor,

    /* spec: { kind: 'html'|'pdf'|'text'|'image'|'video'|'web', path?, url? } */
    createEmbed(spec) {
      // spec doubles as the file ref, so urlFor picks the root-qualified or
      // the bare URL without createEmbed needing to know which.
      switch (spec.kind) {
        case 'image': {
          var img = document.createElement('img');
          img.src = urlFor(spec);
          img.alt = spec.path;
          return img;
        }
        case 'video': {
          var v = document.createElement('video');
          v.src = urlFor(spec);
          v.controls = true;
          return v;
        }
        case 'web':
          return frame(spec.url);
        default:
          // html, pdf, text — the browser renders all three in a frame, and
          // the PDF viewer scrolls inside it just fine.
          return frame(urlFor(spec));
      }
    },

    /* Paired with the style quietScrollbars injects: shows or hides the scrollbar
       of the document inside a frame. Same-origin only — a cross-origin frame
       throws and keeps whatever scrollbar it came with. */
    showScrollbars(f, on) {
      try {
        f.contentDocument.documentElement.classList.toggle('dc-show', !!on);
      } catch (e) { /* cross-origin */ }
    },

    /*
     * Did that frame actually load, or did the site refuse to be embedded?
     * A refused frame still fires `load` in Chromium — it just lands on an
     * empty about:blank. A real cross-origin page throws on contentDocument,
     * which is the tell we want.
     *   → 'ok' | 'blocked' | 'timeout'
     */
    probeEmbed(elm) {
      return new Promise(function (resolve) {
        if (!elm || elm.tagName !== 'IFRAME') return resolve('ok');
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; resolve('timeout'); }
        }, 7000);
        elm.addEventListener('load', function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            var d = elm.contentDocument;
            if (!d) return resolve('ok');
            var blank = d.location.href === 'about:blank' ||
                        !d.body || d.body.childElementCount === 0;
            resolve(blank ? 'blocked' : 'ok');
          } catch (e) {
            resolve('ok'); // cross-origin throw means a real page is in there
          }
        }, { once: true });
      });
    },

    async loadBoard(name) {
      try {
        var r = await fetch('/__api/board?name=' + encodeURIComponent(name));
        if (!r.ok) return null;
        var j = await r.json();
        return j && j.nodes ? j : null;
      } catch (e) { return null; }
    },

    async saveBoard(name, data) {
      var r = await fetch('/__api/board?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('save failed: ' + r.status);
      return r.json();
    },

    /* → [{ name, savedAt, nodes, folders:[label], v }], newest first. */
    async listBoards() {
      try {
        var r = await fetch('/__api/boards');
        var j = await r.json();
        return j.boards || [];
      } catch (e) { return []; }
    },

    async deleteBoard(name) {
      var r = await fetch('/__api/board?name=' + encodeURIComponent(name), { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed: ' + r.status);
      return true;
    },

    /*
     * Write a pasted or dropped image to disk and hand back a file record
     * shaped exactly like a row from listDir(), so the caller can treat a
     * screenshot as an ordinary image file from that point on.
     * Posts the Blob raw — no base64, no multipart, no JSON wrapper.
     */
    async saveAsset(blob, board, ext, name) {
      var q = '?board=' + encodeURIComponent(board || 'default') +
              '&ext=' + encodeURIComponent(ext || 'png') +
              '&name=' + encodeURIComponent(name || 'screenshot');
      var r = await fetch('/__api/asset' + q, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      var j = await r.json().catch(function () { return null; });
      if (!r.ok || !j || !j.ok) {
        throw new Error((j && j.error) || ('asset save failed: ' + r.status));
      }
      var name = j.path.split('/').pop();
      return {
        path: j.path, name: name,
        dir: j.path.split('/').slice(0, -1).join('/'),
        kind: 'image', ext: '.' + (ext || 'png'),
        size: j.bytes, mtime: Date.now(),
      };
    },

    /* Autosave lane — separate from explicit disk saves. */
    draftGet(name) {
      try {
        var raw = localStorage.getItem(LS_PREFIX + name);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    draftSet(name, data) {
      try { localStorage.setItem(LS_PREFIX + name, JSON.stringify(data)); } catch (e) {}
    },
    lastBoard() {
      try { return localStorage.getItem(LS_PREFIX + '@last') || 'default'; } catch (e) { return 'default'; }
    },
    setLastBoard(name) {
      try { localStorage.setItem(LS_PREFIX + '@last', name); } catch (e) {}
    },

    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };

  window.Shell = Shell;
})();
