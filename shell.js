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

  function urlFor(rel) {
    // Paths carry spaces and parens ("2026-03-30 B2B Research/..."), so encode
    // each segment but keep the separators.
    return '/' + String(rel).split('/').map(encodeURIComponent).join('/');
  }

  function frame(src) {
    var f = document.createElement('iframe');
    f.setAttribute('loading', 'lazy');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.src = src;
    return f;
  }

  var Shell = {
    kind: 'browser',

    // Browser frames are at the mercy of X-Frame-Options / frame-ancestors,
    // so web nodes must be prepared to fall back. A desktop webview isn't.
    canEmbedWeb: false,

    async listFiles() {
      var r = await fetch('/__api/files');
      if (!r.ok) throw new Error('file list failed: ' + r.status);
      var j = await r.json();
      return j.files || [];
    },

    urlFor: urlFor,

    /* spec: { kind: 'html'|'pdf'|'text'|'image'|'video'|'web', path?, url? } */
    createEmbed(spec) {
      switch (spec.kind) {
        case 'image': {
          var img = document.createElement('img');
          img.src = urlFor(spec.path);
          img.alt = spec.path;
          return img;
        }
        case 'video': {
          var v = document.createElement('video');
          v.src = urlFor(spec.path);
          v.controls = true;
          return v;
        }
        case 'web':
          return frame(spec.url);
        default:
          // html, pdf, text — the browser renders all three in a frame, and
          // the PDF viewer scrolls inside it just fine.
          return frame(urlFor(spec.path));
      }
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

    async listBoards() {
      try {
        var r = await fetch('/__api/boards');
        var j = await r.json();
        return j.boards || [];
      } catch (e) { return []; }
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
