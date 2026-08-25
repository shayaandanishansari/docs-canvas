# Docs Canvas

An infinite canvas for your HTML docs. Unlike Canva screenshots, the docs on it
are **live** — they scroll, they reflow, Ctrl+F works, links work, and they're
never out of date because they *are* the file.

## Running it

```
node _canvas/server.js
```

or double-click `start.cmd`. It opens `http://localhost:8765/`. Ctrl+C in the
terminal stops it.

By default it serves the folder this one sits in. To start somewhere else:

```
DOCS_ROOT=/path/to/your/docs node server.js
```

Why a server at all: Chromium refuses to load `file://` iframes from a `file://`
page, so the canvas can't embed anything unless the docs are served over http.
No dependencies, no install — it's plain Node.

## Folders

The left rail is a folder tree. **+ Add folder** opens the normal Windows folder
picker, and that folder becomes a branch you can expand.

- Folders belong to the **board**, not the app. Each board carries its own set,
  so a board about outreach isn't cluttered with infrastructure folders.
- The **×** on a branch removes it from that board. Windows already on the
  canvas that came from it keep working — removing a folder never breaks
  anything you've already opened.
- You can't navigate above a folder you picked. It's the ceiling of its branch.
- **Tree / Recent** switches between the folder tree and a flat newest-first
  list. **All files** additionally shows files the canvas can't display, greyed
  out, so the tree looks like the real folder.
- The search box searches every folder on the board, not just what's expanded.

## Using it

- **Drag a doc from the rail onto the canvas** for a new window, or onto an
  existing window's **tab bar** to add it as a tab. Clicking a file drops it in
  the middle of the current view.
- **Click a page once to wake it.** Frames are shielded by default so dragging a
  window doesn't get swallowed by the page inside it. Once woken it behaves like
  a normal page. Clicking empty canvas re-shields everything.
- **Double-click a title bar for webpage mode** — the window fills the screen and
  the doc genuinely reflows at full width (it's a resize, not a zoom). Esc puts
  it back exactly where it was, scroll position intact.
- **Ctrl+Z / Ctrl+Y** undo and redo. Undoing does *not* reload your documents —
  they keep their scroll position. Inside a note or text box, Ctrl+Z stays the
  normal text undo.

## Marking things up

- **Paste a screenshot.** `Win+Shift+S`, then `Ctrl+V` on the canvas. Dragging an
  image in from Explorer works too. Screenshots are saved next to the board in
  `_canvas/assets/`, not stuffed into the board file.
- **Pen** (`P`) draws freehand, in four colours — including straight over a
  document, which is the point. **Eraser** (`E`) drags across strokes to remove
  them. Esc leaves either mode.
- **Click a stroke or an arrow** to select it, then Del to remove it.
- **Text, rectangle, ellipse, line, arrow** from the Add row at the bottom of the
  rail. Shapes are dragged by their outline, so an empty rectangle drawn around a
  window doesn't block the window.
- **Notes and arrows** for the story around the docs.

Shortcuts live in the left sidebar — the `?` at the bottom of it, or just press
`?`.

## Boards

`Ctrl+S` writes the current layout to `_canvas/boards/<name>.json`.

- **Open** lists your boards with their window count, folders and when you last
  saved, and opens one in place.
- **Save as** makes a copy under a new name.
- The name field **renames** the board you're on. It used to switch boards, which
  was a good way to lose your place.

A board remembers its folders, which ones were expanded, every window's position
and size, your arrows, notes, shapes and pen strokes.

Boards store paths relative to the folder they came from, so they survive that
folder moving. `boards/`, `assets/` and `roots.json` are gitignored — they record
real paths out of whatever documents you pointed this at, which isn't something
to publish.

## Web pages

`+ Web` adds a URL window. **Most large sites will refuse to load** — Google,
LinkedIn, Notion and friends send `X-Frame-Options` / `frame-ancestors` headers
that forbid embedding. When that happens the window says so and offers to open
the page in a real browser tab instead. This is the site refusing, not a bug, and
it can't be worked around from inside a browser.

The fix, if web pages become important: rebuild the shell as a desktop app
(Tauri/Electron), where a webview isn't bound by that rule. That's why
`shell.js` exists — see `CONTEXT.md`.

## The files

| file | what it owns |
|---|---|
| `server.js` | static file serving + the JSON API |
| `pick-folder.ps1` | the native Windows folder dialog |
| `index.html` | markup only, no logic |
| `style.css` | the dark tool chrome (dark so the light docs read as the bright objects) |
| `shell.js` | **the platform boundary** — files, folders, embeds, persistence |
| `app.js` | the canvas engine: state, camera, nodes, tabs, ink, input |
| `vendor/` | perfect-freehand, vendored (no build step here) |
| `test/` | Playwright suites — dev only, `cd test && npm install` |

`app.js` never calls `fetch`, never constructs an `<iframe>`, and never touches
`localStorage` — it all goes through `Shell`. Porting to a desktop shell means
rewriting `shell.js` and nothing else.

## Before changing anything

Read `CONTEXT.md`. It has the eight invariants that this thing breaks subtly
without, every one of which is there because it already went wrong once.

## Known limits

- Live frames render at every zoom level. Fine for the ~10-window boards this is
  built for; a 40-window board would want static cards below ~35% zoom.
- One thing selected at a time — no marquee, no groups.
- A window dragged under the top bar can't be clicked where the bar covers it.
- The eraser removes whole strokes, not parts of one.
