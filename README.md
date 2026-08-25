# Docs Canvas

An infinite canvas for the HTML docs in this folder. Unlike Canva screenshots,
the docs on it are **live** — they scroll, they reflow, Ctrl+F works, links work,
and they're never out of date because they *are* the file.

## Running it

```
node _canvas/server.js
```

or double-click `start.cmd`. It opens `http://localhost:8765/` in your browser.
Ctrl+C in the terminal stops it.

By default it serves the folder this one sits in. To point it somewhere else:

```
DOCS_ROOT=/path/to/your/docs node server.js
```

Why a server at all: Chromium refuses to load `file://` iframes from a `file://`
page, so the canvas can't embed anything unless the docs are served over http.
No dependencies, no install — it's plain Node.

## Using it

- **Drag a doc from the left rail onto the canvas** for a new window, or onto an
  existing window's **tab bar** to add it as a tab. Clicking a file drops it in
  the middle of the current view.
- **Click a page once to wake it.** Frames are shielded by default so dragging a
  window doesn't get swallowed by the page inside it. Once woken it behaves like
  a normal page. Clicking empty canvas re-shields everything.
- **Double-click a title bar for webpage mode** — the window fills the screen and
  the doc genuinely reflows at full width (it's a resize, not a zoom). Esc — or
  the same button in the title bar, now showing arrows pointing in — puts it
  back exactly where it was, scroll position intact.
- **Arrows and sticky notes** for the story around the docs.

Shortcuts live in the left sidebar — the `?` at the bottom of it, or just press
`?`, and the file list swaps for the full list.

## Boards

`Ctrl+S` writes the current layout to `_canvas/boards/<name>.json` — the name in
the top bar. Typing a different name and pressing Enter switches to that board
(creating it if new), so you can keep one board per story. Layout is also
autosaved to browser localStorage between explicit saves.

Boards store paths relative to the served root, so they survive the folder
moving. `boards/` is gitignored — saved boards record real paths out of whatever
document folder you pointed this at, which is not something to publish.

## Web pages

`+ Web` adds a URL window. **Most large sites will refuse to load** — Google,
LinkedIn, Notion and friends send `X-Frame-Options` / `frame-ancestors` headers
that forbid embedding. When that happens the window says so and offers to open
the page in a real browser tab instead. This is the site refusing, not a bug, and
it can't be worked around from inside a browser.

The fix, if web pages become important: rebuild the shell as a desktop app
(Tauri/Electron), where a webview isn't bound by that rule. That's why
`shell.js` exists — see below.

## The files

| file | what it owns |
|---|---|
| `server.js` | static file serving + `/__api/files`, `/__api/board`, `/__api/boards` |
| `index.html` | markup only, no logic |
| `style.css` | the dark tool chrome (deliberately dark, so the light docs read as the bright objects) |
| `shell.js` | **the platform boundary** — file listing, embed creation, persistence, external links |
| `app.js` | the canvas engine: state, camera, nodes, tabs, arrows, input |

`app.js` never calls `fetch`, never constructs an `<iframe>`, and never touches
`localStorage` directly — it all goes through `Shell`. Porting to a desktop
shell means rewriting `shell.js` and nothing else.

## Two things worth knowing before changing anything

**Never reorder `.node` elements in the DOM.** Moving an `<iframe>` reloads it,
which throws away scroll position and page state — the exact thing this tool
exists to preserve. Stacking is done with `z-index` only, and tabs are hidden
rather than destroyed.

**Don't `preventDefault()` on `pointerdown`, and capture the pointer on the
handle rather than the node root.** The first suppresses the compatibility mouse
events and kills `dblclick` (webpage mode); the second retargets `mousedown`/
`mouseup` to the root, so `.chrome` — a child, not an ancestor — never sees the
`dblclick` either. Both were real bugs during the build.

## Known limits

- Live frames render at every zoom level. Fine for the ~10-window boards this is
  built for; a 40-window board would want frames swapped for static cards below
  ~35% zoom.
- One node selected at a time — no marquee, no groups.
- A window dragged under the top bar can't be clicked where the bar covers it.
