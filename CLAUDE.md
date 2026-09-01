# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`CONTEXT.md` is the authoritative guide for changing this codebase — file map, server
endpoints, board schema, rendering model, event routing, undo, the nine invariants, and
per-task recipes. Read the relevant section before editing; this file is only the
orientation on top of it. `README.md` is the user-facing doc.

## Commands

```
node server.js                            # serve the parent folder, open http://localhost:8765/
DOCS_ROOT=/path/to/docs node server.js    # serve somewhere else
PORT=9000 node server.js                  # different port
NO_OPEN=1 node server.js                  # don't launch a browser (what the test runner uses)

cd test && npm install                    # once — Playwright, dev-only
node test/run.js                          # all suites, against a server it starts itself
node test/run.js 03                       # one suite, by filename prefix
```

There is no build step, no bundler, no linter, and no package.json at the root — the app
itself has zero dependencies and that is worth keeping. Edit a file and refresh.

A second `node server.js` detects the first via `/__api/ping`, opens a tab at it and exits
rather than taking the next free port; two servers sharing one `boards/` overwrite each
other's saves.

`test/run.js` starts its own server, wipes `boards/` and `assets/` between suites, and
backs up and restores both, so running tests is not destructive. Assets are stashed on
disk in `assets.testbackup/` rather than in memory, so a run killed with Ctrl-C leaves
the screenshots recoverable — the next run restores them.

## Architecture

Vanilla JS, four files, one hard boundary:

- `server.js` — static serving plus the `/__api/*` JSON API. Serves `/_canvas/…` from
  `CANVAS_DIR` and everything else from `ROOT`; those only coincide by accident.
- `shell.js` — **the platform boundary**. Files, folders, embeds, persistence, external
  links. The only file a Tauri/Electron port rewrites.
- `app.js` — the canvas engine: state, camera, nodes, tabs, ink, input. One IIFE,
  sectioned by `// ----` banners.
- `index.html` markup only, `style.css` the dark tool chrome, `vendor/` one vendored
  library (perfect-freehand, with a single documented edit — see CONTEXT.md).

Why a server at all: Chromium refuses `file://` iframes from a `file://` parent, and a
document in a window has to stay a real HTTP URL so its own relative `<img src>` resolves.
That second rule decides more of the design than anything else — it is why the folder
picker runs server-side and why pasted screenshots are written to disk rather than inlined.

`roots.json` maps root id → absolute path and is append-only; which folders a *board*
shows is board state. That split is why removing a folder from a board can't break a
window still pointing into it.

## Rules that bite

All nine invariants are in `CONTEXT.md`; these are the ones most likely to be tripped by a
routine-looking change:

1. **Never reorder `.node` elements in the DOM.** Moving an `<iframe>` reloads it, losing
   the scroll position this tool exists to preserve. Append only; restack with `z-index`
   via `zTop`. This is also why undo restores through `render()`, not `adopt()`.
2. **Never `preventDefault()` on `pointerdown`** — it kills `dblclick`, which is how
   webpage mode opens.
3. **No `click` handlers inside `#world`**, and pointer capture goes on the handle, not the
   node root. `startPan` captures on pointerdown, so a `click` on an edge or stroke never
   fires; selection is claimed on pointerdown off `data-stroke` / `data-edge`.
4. **`hidden` loses to a `display` rule** — anything toggled with `.hidden = true` needs an
   explicit `[hidden] { display: none }`.
5. **Everything inside `#world` scales with the camera, including SVG stroke widths.**
   `vector-effect: non-scaling-stroke` does not help; widths are `calc(N / var(--ez))`,
   and `--ez` is an inline style on each SVG, not inherited.
6. **`app.js` never calls `fetch`, constructs an `<iframe>`, or touches `localStorage`** —
   it all goes through `Shell`.

Two update paths, kept separate on purpose: `render()` for structural sync, direct
`style.left/top/width/height` writes during drag and resize (never `render()` in a
pointermove path). Ink is rebuilt incrementally by `renderInk()` — do not give it the
wholesale `renderEdges()` treatment.

A new top-level board key does not round-trip on its own: add it to both `serialize()` and
`adopt()`.

## Testing

Every bug found while building this was an interaction bug invisible to reading the source,
so verify in a real browser. The suites encode the rules that were learned the hard way —
drive with `page.mouse` and never `dispatchEvent`, call the suite's idempotent
`openRail(page)` after each `goto`/`reload` because the sidebar starts shut, seed
`boards/default.json` empty rather than deleting it, assert an image's `naturalWidth`, and
assert zero `console`/`pageerror` at the end. See the Verifying changes section of
`CONTEXT.md` before writing a new suite.

A green suite is not proof the UI looks right — take a screenshot and look at it.

## Not in git

`boards/`, `assets/` and `roots.json` are gitignored: they record real absolute paths and
pictures of whatever private documents the canvas was pointed at.
