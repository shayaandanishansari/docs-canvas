# CONTEXT.md

Orientation for anyone — human or agent — picking this codebase up cold.
`README.md` is for people *using* the tool; this file is for people *changing*
it. Read the Invariants section before writing any code.

---

## What this is and why

A pan/zoom canvas where every window embeds a **live document** rather than a
screenshot of one. It replaces the workflow of screenshotting HTML reports into
a Canva whiteboard to narrate a story: those screenshots are dead, go stale, and
can't be scrolled. Here the windows are the actual files — they scroll, reflow,
Ctrl+F, and follow links, and they update when the file does.

Built for one person driving a live walkthrough for teammates, not for
teammates to open themselves. That assumption is why boards live on localhost
and nothing is shared or multiplayer.

## Running and poking at it

```
node server.js                              # serves the parent folder
DOCS_ROOT=/path/to/docs node server.js      # serves somewhere else
```

Opens `http://localhost:8765/`. Zero dependencies — no build, no install, no
bundler. Edit a file, hit refresh.

**A server is required.** Chromium refuses to load `file://` iframes from a
`file://` parent, so the canvas cannot embed anything as a plain double-clicked
HTML file. That constraint is the reason `server.js` exists at all.

## No framework, deliberately

Vanilla JS. Three reasons, all still true:

1. **Virtual DOM is hostile to iframes.** Reconciliation is free to move a DOM
   node, and moving an `<iframe>` reloads it — losing scroll position and page
   state, the exact thing this tool exists to preserve.
2. **Pan/zoom wants direct style writes.** Dragging is `el.style.transform` on
   pointermove; a render pass in between is strictly worse frame timing.
3. **The state is small.** One camera, an array of nodes, an array of edges.

If real chrome ever accumulates (properties panel, inspector, layer list), React
starts earning its keep. The DOM-level `Shell` boundary means that port wouldn't
have to touch the canvas engine.

---

## File map

| file | owns | notes |
|---|---|---|
| `server.js` | static serving + 3 JSON endpoints | ~155 lines, no deps |
| `index.html` | markup only | no logic whatsoever |
| `style.css` | the dark tool chrome | dark on purpose: docs are the bright objects |
| `shell.js` | **the platform boundary** | the only file a desktop port rewrites |
| `app.js` | the canvas engine | ~950 lines, one IIFE, sectioned by `// ----` banners |

### Server endpoints

- `GET /__api/files` → `[{ path, name, dir, kind, ext, size, mtime }]`, newest
  first. Walks `ROOT` to depth 8, skipping `node_modules`, `.git`, `.idea`,
  `_canvas`, `dist`, `.venv`, `__pycache__`. Only extensions in the `KINDS` map
  are surfaced.
- `GET /__api/board?name=x` → the board JSON, or `{}` if it doesn't exist yet.
  **Returns 200, not 404** — a missing board is a normal state, and a 404 would
  print a console error on every first run.
- `POST /__api/board?name=x` → writes `boards/<name>.json`.
- `GET /__api/boards` → `{ boards: [names] }`.
- Everything else is static from `ROOT`, with a `startsWith(ROOT)` traversal
  guard.

`kind` is the server's classification and drives which element `Shell.createEmbed`
builds: `html`, `pdf`, `image`, `text`, `video`. Adding a file type means adding
to `KINDS` and `MIME` in `server.js`, a `.dot.<kind>` colour in `style.css`, and
a case in `createEmbed` if it isn't frame-renderable.

---

## Data model

Board JSON. Paths are relative to the served root so boards survive the folder
moving.

```jsonc
{
  "v": 1,
  "savedAt": 1740000000000,           // used to pick disk vs localStorage draft
  "camera": { "x": -420, "y": -180, "z": 0.62 },
  "nodes": [
    { "id": "n1", "type": "doc", "x": 0, "y": 0, "w": 920, "h": 640,
      "tabs": [ { "id": "t1", "kind": "html", "path": "research/market-overview.html", "title": "market-overview" } ],
      "active": "t1" },
    { "id": "n2", "type": "web",  "x": 1000, "y": 0, "w": 900, "h": 640, "url": "https://…" },
    { "id": "n3", "type": "note", "x": -360, "y": 80, "w": 260, "h": 180, "text": "…" }
  ],
  "edges": [ { "id": "e1", "from": "n1", "to": "n2" } ]
}
```

Three node types: **doc** (tabbed; renders iframe/img/video by tab kind), **web**
(url bar + frame + refusal fallback), **note** (sticky, contenteditable).

`zi` also rides on node objects at runtime (z-order counter). Harmless in the
JSON; reassigned on load.

### Runtime state (module-level in `app.js`)

| var | meaning |
|---|---|
| `state` | the serializable board: `camera`, `nodes`, `edges` |
| `files` | the rail's file list from `/__api/files` |
| `els` | `Map<nodeId, { root, tabsEl, bodyEl, shield, panes:Map }>` — DOM cache |
| `selected` / `selectedEdge` | current selection (one at a time, by design) |
| `liveId` | the one node whose frame currently accepts pointer events |
| `focus` | `null`, or `{ id, geom, cam }` saved for restore on Esc |
| `linking` | `null`, or `{ from: id\|null }` during arrow mode |
| `zTop` | monotonic z-index counter — **never** reorder DOM to restack |

---

## Rendering model

`#world` carries `translate(cam.x, cam.y) scale(cam.z)`; nodes are absolutely
positioned in world coordinates inside it. Screen→world is
`(screen - cam.offset) / cam.z` (`screenToWorld`). Zoom-to-cursor keeps the
point under the pointer fixed (`zoomAt`).

Two update paths, deliberately:

- **`render()`** — structural sync. Drops elements whose nodes are gone, calls
  `syncNode` on the rest, redraws edges. Call after add/remove/tab changes.
- **direct style writes** — during drag and resize, `startDrag`/`startResize`
  write `style.left/top/width/height` and call `renderEdges()` only. No
  `render()` in a pointermove path.

`ensurePane` creates a tab's content element on **first activation** and then
hides rather than destroys it, so scroll position survives tab switching. Panes
are never created at board-load time.

Edges live in an SVG inside `#world`, offset by a `viewBox` of
`-50000 -50000 100000 100000` so negative world coordinates aren't clipped.
Strokes use `vector-effect="non-scaling-stroke"`; the arrowhead is drawn by hand
rather than as a marker so it doesn't shrink with the camera.

## Event routing

| surface | handler | does |
|---|---|---|
| `#viewport` empty space | pointerdown | deselect, re-shield everything, start pan |
| `#viewport` | wheel | Ctrl/Cmd → `zoomAt`; otherwise pan. Non-passive listener |
| `.shield` | click | wake that node (`setLive`) |
| `.chrome` | pointerdown | `startDrag`, unless the target is a button or `.tab` |
| `.chrome` | dblclick | `enterFocus` / `exitFocus` |
| `.node` root | pointerdown **capture** | link mode interception, else `select` |
| `.grip` | pointerdown | `startResize` |

Frames are **shielded by default** — a transparent overlay over every iframe —
so dragging a window isn't swallowed by the page inside it. One click wakes a
node; clicking empty canvas re-shields all. Notes are never shielded.

**Webpage mode** (`enterFocus`) resizes the node to the viewport and sets the
camera to identity, so the document genuinely *reflows* at full width rather
than being magnified. Nothing is reparented, so no reload and scroll position
survives the round trip. `exitFocus` restores the saved `geom` and `cam`.

---

## Invariants — break these and it breaks subtly

**1. Never reorder `.node` elements in the DOM.** Moving an `<iframe>` reloads
it. `buildNode` appends only; stacking is `z-index` via `zTop`. This is the
single most important rule in the codebase.

**2. Never `preventDefault()` on `pointerdown`.** It suppresses the
compatibility mouse events, which kills `dblclick` — and `dblclick` is how
webpage mode opens. Text selection is already handled by `user-select: none`.
*(This was a real bug; the symptom was webpage mode silently doing nothing.)*

**3. Capture the pointer on the handle, not the node root.** `setPointerCapture`
retargets `mousedown`/`mouseup` to the capture element. Capturing on the root
makes the click land on the root, and `.chrome` — a *child*, not an ancestor —
never sees the `dblclick` at all. `startDrag`/`startResize` capture on
`e.currentTarget`. *(Also a real bug, same silent symptom.)*

**4. The `hidden` attribute loses to a `display` rule.** Any element you toggle
with `.hidden = true` needs an explicit `[hidden] { display: none }` if its CSS
sets `display`. `.pane` has one. *(Real bug: an invisible help overlay was
eating every click on the canvas — which is also why the shortcut sheet is now
a view of the rail, `#rail.help`, rather than anything that floats.)*

**5. Anything drawn inside `#world` scales with the camera — including SVG
stroke widths.** `vector-effect: non-scaling-stroke` does *not* rescue you:
it ignores transforms inside the SVG, and ours is the CSS `scale()` on `#world`,
outside it. Edge widths are `calc(N / var(--ez))` with `--ez` written by
`applyCamera`, and arrowheads get a matching `scale(1/z)` from `sizeHeads`.

**6. `app.js` never calls `fetch`, constructs an `<iframe>`, or touches
`localStorage`.** All of it goes through `Shell`. This is what keeps the desktop
port to one file.

---

## The Shell boundary

```js
Shell = {
  kind: 'browser',
  canEmbedWeb: false,          // browser: unreliable. desktop: true
  listFiles(),                 // → [{ path, name, dir, kind, ext, size, mtime }]
  urlFor(relPath),             // → served URL (encodes each segment; paths have spaces/parens)
  createEmbed(spec),           // → DOM element. spec = { kind, path? , url? }
  probeEmbed(el),              // → 'ok' | 'blocked' | 'timeout'
  loadBoard(n) / saveBoard(n, data) / listBoards(),
  draftGet(n) / draftSet(n, data),   // localStorage autosave lane
  lastBoard() / setLastBoard(n),
  openExternal(url),
}
```

`probeEmbed` exists because a refused frame still fires `load` in Chromium — it
just lands on an empty `about:blank`. A *real* cross-origin page throws on
`contentDocument` access, and that throw is the success signal.

### Porting to desktop (Tauri/Electron)

The open door for real web pages. Most large sites (Google, LinkedIn, Notion)
send `X-Frame-Options` / `frame-ancestors` and cannot be embedded in a browser —
not a bug and not fixable from inside one. A desktop webview isn't bound by that.

The port is: rewrite `shell.js` so `createEmbed` returns a `<webview>` for
`kind: 'web'`, `listFiles` calls a Tauri command instead of `fetch`, boards go
through the filesystem API, and `canEmbedWeb: true`. `app.js` should not need to
change. Keep `probeEmbed` returning `'ok'` and the blocked-state UI simply never
appears.

---

## Recipes

**Add a node type.** Add a `type-<x>` branch in `buildNode` (chrome buttons,
optional extra bar), a case in `ensurePane`, a `syncTabs` branch for its chip,
and CSS under `.node.type-<x>`. `syncNode` and `render` need no changes.

**Add a file kind.** `KINDS` + `MIME` in `server.js`, a `.dot.<kind>` colour in
`style.css`, a `createEmbed` case if it isn't frame-renderable, and optionally a
`defaultSize` entry.

**Add a toolbar action.** Put `data-act="thing"` on the button in `index.html`
and a case in the `wireTopbar` delegated click handler. Keyboard shortcuts go in
`onKey`, which already guards against firing while typing in inputs or
contenteditable.

**Change persistence.** `serialize()` is the single source of the save shape;
`markDirty()` debounces the localStorage draft at 700ms; `saveToDisk()` writes
through `Shell` and must `clearTimeout(saveTimer)` first so a queued draft
doesn't land afterwards and relabel the status.

---

## Verifying changes

There is no test suite. Every bug found during the build was an *interaction*
bug invisible to reading the source, so verify in a real browser rather than by
inspection. The recipe that caught all four:

Drive it with Playwright — load `http://127.0.0.1:8765/` (use `127.0.0.1`, not
`localhost`, and `waitUntil: 'load'`, not `networkidle`), collect `console` and
`pageerror` events, then exercise: click a rail file → drag one onto a tab bar →
drag one onto empty canvas → `f` to fit → `l` + two clicks for an arrow → click
a shield → dblclick a title bar → check the focused node's `boundingBox()`
equals the viewport → Esc → check geometry restored → `Ctrl+S`. Assert zero
console errors at the end, and screenshot each stage.

Two traps when writing such a test: it must **delete `boards/*.json` first**,
because a board saved by a previous run gets loaded by the next one and the
layout drifts; and nodes it creates can land on top of each other, which reads
as a Playwright "intercepts pointer events" timeout rather than an app bug.

That script is not currently committed. If interaction bugs start recurring,
making it a permanent `test/smoke.js` is the obvious next step.

---

## Known limits and likely next work

- **Live frames at every zoom.** Fine for the ~10-window boards this targets. A
  40-window board would want frames swapped for static cards below ~35% zoom and
  rehydrated on the way in. Designing this in later is harder than it sounds —
  it interacts with invariant #1.
- **Single selection.** No marquee, no groups. Adding it roughly doubles the
  input-handling code.
- **A window dragged under the top bar** can't be clicked where the bar covers it.
- **The board-name field switches boards rather than "save as."** Type a name,
  press Enter, get that board (created if new). Defensible but surprising.
- **No presentation sequence.** Freeform was the explicit ask. If ordered
  storytelling is ever wanted, the shape is a per-node step number plus arrow
  keys flying the camera through them — `fly()` and `enterFocus()` are already
  the primitives.
