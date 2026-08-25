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
bundler. Edit a file, hit refresh. (`test/` has one dev dependency, Playwright.
The app itself has none, and that is worth keeping.)

**A server is required**, for two reasons that both come back to the same rule.
Chromium refuses to load `file://` iframes from a `file://` parent, so the
canvas cannot embed anything as a plain double-clicked HTML file. And **a
document in a window has to stay a real HTTP URL** — an HTML report saying
`<img src="chart.png">` only works if the server is serving the folder it lives
in. That second rule decides more of this design than anything else: it is why
the folder picker runs server-side, and why pasted screenshots are written to
disk instead of inlined.

## No framework, deliberately

Vanilla JS. Three reasons, all still true:

1. **Virtual DOM is hostile to iframes.** Reconciliation is free to move a DOM
   node, and moving an `<iframe>` reloads it — losing scroll position and page
   state, the exact thing this tool exists to preserve.
2. **Pan/zoom wants direct style writes.** Dragging is `el.style.transform` on
   pointermove; a render pass in between is strictly worse frame timing.
3. **The state is small.** One camera, a few arrays.

If real chrome ever accumulates (properties panel, inspector, layer list), React
starts earning its keep. The DOM-level `Shell` boundary means that port wouldn't
have to touch the canvas engine.

---

## File map

| file | owns | notes |
|---|---|---|
| `server.js` | static serving + the JSON API | ~470 lines, no deps |
| `pick-folder.ps1` | the native Windows folder dialog | spawned by the server |
| `index.html` | markup only | no logic whatsoever |
| `style.css` | the dark tool chrome | dark on purpose: docs are the bright objects |
| `shell.js` | **the platform boundary** | the only file a desktop port rewrites |
| `app.js` | the canvas engine | ~1900 lines, one IIFE, sectioned by `// ----` banners |
| `vendor/perfect-freehand.js` | pen geometry | vendored, one documented edit — see below |
| `test/` | Playwright suites | dev-only; `cd test && npm install` |

Gitignored because they record real paths into private work: `boards/`,
`assets/`, `roots.json`.

### Server endpoints

**Folders and files**

- `POST /__api/pick-folder` → opens the native dialog, registers the chosen
  folder, returns `{ ok, root }` or `{ ok, cancelled }`. Blocks until the user
  dismisses the dialog — there is no sane timeout for that, so the rail shows a
  pending state instead.
- `GET /__api/default-root` → the served folder, registered. Seeds new boards
  and is what a v1 board's bare paths get migrated onto.
- `GET /__api/tree?root=&dir=&all=` → **one level only**:
  `{ dirs:[{name}], files:[{name, kind, ext, size, mtime, renderable}] }`.
- `GET /__api/search?roots=&q=&all=` → recursive, capped at 300.
- `GET /__api/recent?roots=&all=` → newest-first across those roots, capped at 200.

**Boards and assets**

- `GET /__api/board?name=x` → the board JSON, or `{}` if it doesn't exist yet.
  **Returns 200, not 404** — a missing board is a normal state, and a 404 would
  print a console error on every first run.
- `POST /__api/board?name=x` → writes `boards/<name>.json`.
- `DELETE /__api/board?name=x` → removes it.
- `GET /__api/boards` → `[{ name, savedAt, nodes, folders, v }]`, newest first.
- `POST /__api/asset?board=&ext=&name=` → writes `assets/<board>/<name>-<id>.<ext>`,
  returns the path. Images only.

**Static**

- `/__root/<id>/<relpath>` — a file inside a registered folder.
- `/_canvas/…` — resolved against `CANVAS_DIR`, *not* `ROOT`. They only coincide
  by accident, and `DOCS_ROOT=/elsewhere` would otherwise 404 the app's own
  `index.html`.
- everything else — from `ROOT`.

`kind` is the server's classification and drives which element `Shell.createEmbed`
builds: `html`, `pdf`, `image`, `text`, `video`. Adding a file type means adding
to `KINDS` and `MIME` in `server.js`, a `.dot.<kind>` colour in `style.css`, and
a case in `createEmbed` if it isn't frame-renderable.

### The roots registry

`roots.json` maps a root id to an absolute path, and **nothing else**. Which
folders a board *shows* is board state; the registry decides only what is
*resolvable*, and entries are appended and never pruned.

That split is the whole reason removing a folder from a board cannot break a
window still pointing into it. It is true by construction rather than by care —
worth preserving if you touch this.

---

## Data model

Board JSON. Paths are relative to their root, so boards survive folders moving.

```jsonc
{
  "v": 2,
  "savedAt": 1740000000000,
  "roots": [ { "id": "r_9f21c", "label": "B2B Research", "path": "C:/…/B2B Research" } ],
  "open":  { "r_9f21c": ["", "drafts", "drafts/old"] },
  "camera": { "x": -420, "y": -180, "z": 0.62 },
  "nodes": [
    { "id": "n1", "type": "doc", "x": 0, "y": 0, "w": 920, "h": 640,
      "tabs": [ { "id": "t1", "kind": "html", "root": "r_9f21c",
                  "path": "market-overview.html", "title": "market-overview" } ],
      "active": "t1" },
    { "id": "n2", "type": "web",   "x": 1000, "y": 0, "w": 900, "h": 640, "url": "https://…" },
    { "id": "n3", "type": "note",  "x": -360, "y": 80, "w": 260, "h": 180, "text": "…" },
    { "id": "n4", "type": "text",  "x": -360, "y": 300, "w": 300, "h": 80, "text": "…" },
    { "id": "n5", "type": "shape", "x": 40, "y": 700, "w": 240, "h": 160,
      "kind": "ellipse", "stroke": "#5b8cff", "fill": "none", "width": 2 }
  ],
  "edges":   [ { "id": "e1", "from": "n1", "to": "n2" } ],
  "strokes": [ { "id": "s1", "pts": [[x,y,pressure], …], "color": "#ffd166", "size": 4 } ]
}
```

`roots` carries the **full record**, not just ids, so a board opened where
`roots.json` doesn't know those folders can re-register rather than dangle.

A tab's `root` is `null` for a pasted screenshot — assets live under
`_canvas/assets/`, outside every root — and for tabs migrated from a v1 board.
`Shell.urlFor` handles both shapes, so **the bare-path branch is not legacy
cruft waiting to be deleted.**

**v1 → v2 migration** happens in `migrate()` on load: qualify every bare tab
path with the default root id, except paths starting `_canvas/assets/`.

### Six node types

**doc** (tabbed; renders iframe/img/video by tab kind), **web** (url bar + frame
+ refusal fallback), **note** (yellow sticky), **text** (the same editor without
the sticky styling), **shape** (rect/ellipse/line/arrow drawn as SVG inside the
node).

`note`, `text` and `shape` are listed in `PLAIN`. That predicate is how a type
opts out of all four of: webpage mode, the ↗ button, the click-shield, and
dblclick-to-focus.

### Runtime state (module-level in `app.js`)

| var | meaning |
|---|---|
| `state` | the serializable board: `camera`, `nodes`, `edges`, `strokes`, `roots`, `open` |
| `els` | `Map<nodeId, { root, tabsEl, bodyEl, shield, focusBtn, panes:Map }>` — DOM cache |
| `inkEls` | `Map<strokeId, <g>>` — the ink layer's DOM cache |
| `dirCache` | `Map<'rootId::dir', listing>` so reopening a folder is instant |
| `selected` / `selectedEdge` / `selectedStroke` | current selection (one at a time, by design) |
| `liveId` | the one node whose frame currently accepts pointer events |
| `focus` | `null`, or `{ id, geom, cam }` saved for restore on Esc |
| `linking` / `penOn` / `eraseOn` | the three modes; mutually exclusive |
| `railMode` / `railView` / `showAll` | rail state, not board state |
| `undoStack` / `redoStack` | JSON snapshots; see Undo below |
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

### Three layers inside `#world`

| layer | z | rebuilt |
|---|---|---|
| `#edges` | 1 | wholesale, every `renderEdges()` |
| `#nodes` | 2 | diffed by `render()` |
| `#ink` | 3 | **incrementally**, one `<g>` per stroke |

Both SVGs use the same trick: a `viewBox` of `-50000 -50000 100000 100000` with
the width/height attributes stripped at boot, so world coordinates go straight
into path data with no transform.

**Ink is above the nodes and edges are below, and that asymmetry is deliberate.**
An arrow between two windows belongs behind them; a circle drawn round a
paragraph has to sit on top of the document it is marking up.

**Do not give `#ink` the `renderEdges` treatment.** `renderEdges` clears its
whole subtree on every call and runs on every pointermove during a drag — fine
for a handful of edges, ruinous for hundreds of strokes. `renderInk()` adds and
removes only what changed; `rebuildInk()` is the wholesale path and is called
only from `adopt()`.

`perfect-freehand` returns a filled **outline**, not a stroked line, so ink
thickness is geometry in world units and scales with the world like a node's
size does. The pen's *feel* is kept constant instead: `penSize / camera.z` at
stroke time, so drawing at 25% and at 250% both lay down the same screen width.

---

## Event routing

| surface | handler | does |
|---|---|---|
| `#viewport` empty space | pointerdown | pick a stroke/arrow, else deselect + `startPan` |
| `#viewport` | wheel | Ctrl/Cmd → `zoomAt`; otherwise pan. Non-passive listener |
| `#drawSurface` | pointerdown | `startStroke` or `startErase` |
| `.shield` | click | wake that node (`setLive`) |
| `.chrome` | pointerdown | `startDrag`, unless the target is a button or `.tab` |
| `.chrome` | dblclick | `enterFocus` / `exitFocus` |
| `.node` root | pointerdown **capture** | link mode interception, else `select` |
| `.node.type-shape .body` | pointerdown | `startDrag` — a shape is dragged by its ink |
| `.grip` | pointerdown | `startResize` |

Frames are **shielded by default** — a transparent overlay over every iframe —
so dragging a window isn't swallowed by the page inside it. One click wakes a
node; clicking empty canvas re-shields all. `PLAIN` types are never shielded.

**Webpage mode** (`enterFocus`) resizes the node to the viewport and sets the
camera to identity, so the document genuinely *reflows* at full width rather
than being magnified. Nothing is reparented, so no reload and scroll position
survives the round trip.

`#drawSurface` exists because documents are shielded and the viewport's own
handler ignores anything over a `.node` — without a surface of its own, neither
pen nor eraser could reach a window, which is the main thing anyone wants to
draw on. It is present **only while a tool is active**, which is what stops it
being the click-eating overlay of invariant 4.

---

## Undo

Snapshots of `{nodes, edges, strokes, roots, open}` as JSON. Affordable because
the board is small.

The subtle part is putting one back. `adopt()` drops every element and rebuilds,
which reloads every iframe — so `restore()` writes the state arrays and calls
`render()` instead, which diffs. Untouched frames keep their scroll position;
only a node that genuinely returned from deletion is rebuilt, and that one has
to reload because its element is gone.

Two things that are easy to get wrong:

- **Coalescing.** `markDirty` fires per keystroke and per drag. `pushUndo` holds
  the pre-change snapshot and banks it after 450ms of quiet, so a burst of
  typing is one entry rather than one per character.
- **`syncTextPanes`.** Note and text content is bound one way — `ensurePane`
  writes `n.text` on input and never reads it back. That is fine until undo
  changes `n.text` under a live editor, so `restore()` pushes it back into the
  DOM, and only when it actually differs so the caret is left alone.

Camera changes are not in the snapshot, so panning and zooming create no undo
entries — they compare equal and get dropped. Switching boards calls
`resetHistory()`; another board's history would undo into ids that don't exist.

---

## Invariants — break these and it breaks subtly

**1. Never reorder `.node` elements in the DOM.** Moving an `<iframe>` reloads
it. `buildNode` appends only; stacking is `z-index` via `zTop`. This is the
single most important rule in the codebase, and it is also why undo restores
through `render()` rather than `adopt()`.

**2. Never `preventDefault()` on `pointerdown`.** It suppresses the
compatibility mouse events, which kills `dblclick` — and `dblclick` is how
webpage mode opens. Text selection is already handled by `user-select: none`.
*(Real bug; the symptom was webpage mode silently doing nothing.)*

**3. Nothing inside `#world` may rely on a `click` handler, and pointer capture
goes on the handle, not the node root.** `setPointerCapture` retargets
`mousedown`/`mouseup` to the capture element. Two consequences, both of which
have already bitten:

- Capturing on the root makes the click land on the root, and `.chrome` — a
  *child*, not an ancestor — never sees the `dblclick`. `startDrag`/`startResize`
  capture on `e.currentTarget`.
- `startPan` captures the pointer on pointerdown, so a `click` listener on an
  edge or a stroke **never fires**. Arrows were unselectable this way for a long
  time. Selection is claimed on **pointerdown** in the viewport handler, keyed
  off `data-stroke` / `data-edge` attributes.

**4. The `hidden` attribute loses to a `display` rule.** Any element you toggle
with `.hidden = true` needs an explicit `[hidden] { display: none }` if its CSS
sets `display`. `.pane`, `#drawSurface` and `#eraseRing` all have one. *(Real
bug: an invisible help overlay was eating every click on the canvas — which is
also why panels are views of the rail, `#rail.help` / `#rail.boards`, rather
than anything that floats.)*

**5. Anything drawn inside `#world` scales with the camera — including SVG
stroke widths.** `vector-effect: non-scaling-stroke` does *not* rescue you: it
ignores transforms inside the SVG, and ours is the CSS `scale()` on `#world`,
outside it. Widths are `calc(N / var(--ez))` with `--ez` written by
`applyCamera`, and arrowheads get a matching `scale(1/z)` from `sizeHeads`.
`--ez` is an inline style on **each** SVG and is not inherited, so `#ink` gets
its own write.

**6. `app.js` never calls `fetch`, constructs an `<iframe>`, or touches
`localStorage`.** All of it goes through `Shell`. This is what keeps the desktop
port to one file.

**7. A transparent element still eats clicks.** A shape node is a transparent
rectangle; as first built it swallowed everything in its bounding box, so a
rectangle drawn around a window made that window unusable. Shapes hit-test on
their ink only — an unfilled one on its stroke, a filled one on its fill — with
a fat invisible twin so a 2px line stays grabbable. Same trick as `path.hit` on
edges. Chrome and grips activate only once the shape is selected.

**8. Rows carrying tree guide lines cannot have vertical padding.** A `.gd`
spacer stretches to the row's content box, so padding clips the guide and the
vertical lines render as dashes with gaps. Height comes from `min-height`.
*(Every DOM assertion passed while this was visibly broken.)*

---

## The Shell boundary

```js
Shell = {
  kind: 'browser',
  canEmbedWeb: false,          // browser: unreliable. desktop: true

  pickFolder(),                // → { id, label, path } | null   (native dialog)
  defaultRoot(),
  listDir(rootId, dir, all),   // one level
  search(rootIds, q, all),
  recent(rootIds, all),

  urlFor(refOrPath),           // { root, path } → /__root/…  |  string → /…
  createEmbed(spec),           // → DOM element. spec doubles as the file ref
  probeEmbed(el),              // → 'ok' | 'blocked' | 'timeout'

  loadBoard(n) / saveBoard(n, data) / listBoards() / deleteBoard(n),
  saveAsset(blob, board, ext, name),
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
`kind: 'web'`, the folder methods call Tauri commands, `pickFolder` becomes
`dialog.open({ directory: true })`, boards go through the filesystem API, and
`canEmbedWeb: true`. `app.js` should not need to change.

### The vendored library

`vendor/perfect-freehand.js` is perfect-freehand 1.2.3 (MIT), vendored rather
than installed because this project has no build step and the package ships ESM
and CJS but no UMD. **The only edit** is the final line: upstream's
`export{…}` is replaced with a `window.PerfectFreehand = {…}` assignment, and
the sourcemap comment after it is dropped. Repeat exactly that when upgrading.

---

## Recipes

**Add a node type.** Six seams, and `syncTabs` is the trap — with no branch it
falls through to `n.tabs.forEach` and throws on undefined:

1. `buildNode` chrome buttons — join the `isPlain` guard if it shouldn't get
   focus/↗ buttons
2. `buildNode` dblclick — return early for plain types
3. `syncTabs` — **required branch**
4. `ensurePane` — build the body
5. `syncNode` shield — skip for plain types
6. `setLive` — skip for plain types

Adding the type to `PLAIN` covers 1, 2, 5 and 6 at once. `buildNode` generates
`div.node.type-<x>` automatically, so CSS needs no JS change, and `serialize`
embeds nodes wholesale so new fields round-trip for free.

**Add a file kind.** `KINDS` + `MIME` in `server.js`, a `.dot.<kind>` colour in
`style.css`, a `createEmbed` case if it isn't frame-renderable, and optionally a
`defaultSize` entry.

**Add a toolbar action.** Put `data-act="thing"` on the button in `index.html`
and a case in the `wireTopbar` delegated click handler — the listener is on
`document`, so placement is free. Keyboard shortcuts go in `onKey`, which
already guards against firing while typing.

**Add a rail panel.** Add a class to `VIEW_TITLE`, a `#rail.<name>` CSS block
hiding the other views, and call `setRailView('<name>')`. Follow the pattern —
do not float a layer over the canvas (invariant 4).

**Change persistence.** `serialize()` is the single source of the save shape;
`markDirty()` debounces the localStorage draft at 700ms and feeds the undo
stack; `saveToDisk()` writes through `Shell` and must `clearTimeout(saveTimer)`
first so a queued draft doesn't land afterwards and relabel the status. **A new
top-level key does not round-trip on its own** — add it to `serialize` and
`adopt` both.

---

## Verifying changes

Every bug found while building this was an *interaction* bug invisible to
reading the source, so verify in a real browser rather than by inspection.

```
cd test && npm install     # once: Playwright, dev-only
node test/run.js           # all suites, against a server it starts itself
node test/run.js 03        # just one
```

The runner backs up and restores `boards/` so running tests is not destructive.

Rules the suites encode, all learned the hard way:

- Use `127.0.0.1`, not `localhost`, and `waitUntil:'load'`, not `networkidle`.
- **Seed `boards/default.json` empty rather than deleting it.** With no board on
  disk the app creates a welcome note, which silently offsets every node count.
- Nodes are added at screen centre and stack; spread them by really dragging,
  and keep them clear of the 286px rail or they land underneath it.
- Shapes are grabbed by their ink, not a chrome bar.
- **Drive with `page.mouse`, never `dispatchEvent`.** A dispatched click bypasses
  hit-testing and pointer capture. That is exactly how "clicking a stroke selects
  it" passed against code where it did nothing at all.
- **Assert an image's `naturalWidth`**, never just that an `<img>` exists — a
  corrupted PNG still produces a perfectly happy-looking element.
- Collect `console` and `pageerror`; assert zero at the end.

A green suite is not proof the UI looks right. The dashed guide lines and the
mis-specified eraser colour both passed every assertion. Take a screenshot and
look at it.

---

## Known limits and likely next work

- **Live frames at every zoom.** Fine for the ~10-window boards this targets. A
  40-window board would want frames swapped for static cards below ~35% zoom and
  rehydrated on the way in. Harder than it sounds — it interacts with invariant 1.
- **Single selection.** No marquee, no groups. Adding it roughly doubles the
  input-handling code.
- **A window dragged under the top bar** can't be clicked where the bar covers it.
- **The eraser takes whole strokes.** Partial rub-out means splitting a stroke's
  point array and re-deriving two outlines.
- **Pen width is fixed** at 4px; only colour is exposed.
- **No presentation sequence.** Freeform was the explicit ask. If ordered
  storytelling is ever wanted, the shape is a per-node step number plus arrow
  keys flying the camera through them — `fly()` and `enterFocus()` are already
  the primitives.
