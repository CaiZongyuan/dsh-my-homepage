# Working on this repo

Guidance for an agent (or a person) changing `dsh-my-homepage`. Read this before editing;
every rule below was learned the hard way and each one has a failure it prevents.

## What this is

A DSH plugin bundle. The Host half (`index.js`) owns a source registry, a fetch layer, a
durable store, an HTTP surface, and three Agent tools. The Client half (`client.js`)
renders a bento widget grid described by that registry. `feed.js` is a small RSS/Atom
reader. There is **no build step and no dependency**.

## File map

| File | Role |
|---|---|
| `index.js` | Host half: `SOURCES` registry, fetch + store + `/workbench/*` routes + tools |
| `client.js` | Client half: `main` panel and `sidebar.panellist` icon; the widget grid |
| `feed.js` | RSS 2.0 / Atom / RDF reader plus `og:image` extraction (fixture-tested) |
| `cordis.patch.yml` | The Loader row this bundle inserts |
| `dsh.plugin.json` | Market manifest |
| `dev/selftest.mjs` | Runs the real `apply()` against a fake context |
| `docs/design.md` | Architecture, measurements, and the trade-offs behind them |

## Hard constraints

1. **Never import from `node_modules`.** `plugin_manager install_bundle` installs a local
   directory as a pnpm link, and DSH does not run with `--preserve-symlinks`, so Node would
   resolve a bare specifier from the *workspace* directory instead of the profile's
   `node_modules` and fail. Relative imports (`./feed.js`) are fine — they resolve against
   the importing file. This is why the storage domain uses a `{ parse }` stub instead of
   zod: the domain's only call on `valueSchema` is `.parse()`.
2. **A Host change needs a DSH restart to take effect.** The Loader caches a Host module per
   specifier, and Node's ESM cache is keyed by the **resolved file URL** — so re-installing
   the bundle, even under a *different package name*, re-runs `apply()` from the same cached
   module body. Verified: after renaming the package and re-installing, `/workbench/meta`
   still reported the previous generation's descriptors. The Client half is different: it
   hot-reloads on file save (revisions come from mtime and size). So: batch Host edits, and
   iterate visually on the client.
3. **Storage keys must be path-safe.** The domain's `per-record` layout requires
   `/^[a-zA-Z0-9_-]+$/`, so a colon cannot separate source from id (`aihot:xxx` is
   rejected). `itemKey()` sanitises; the `read` table shares the constraint because its keys
   are item ids.
4. **Card size is a presentation concern.** `kind` selects the renderer *and* the size;
   the Host's declared `colSpan`/`rowSpan` is deliberately ignored, because honoring a span
   from an older Host generation is what produced clipped cards. A descriptor whose kind is
   unknown is treated as an older generation (`LEGACY_KIND` + `widget.layout`).
5. **No card may clip its content.** A card scrolls deliberately or not at all. Card body
   height is `n*ROW_UNIT + (n-1)*GAP - CHROME`; if a renderer outgrows that budget, fix the
   budget or the renderer — never let a row be cut in half.
6. **Fetched content is data, not instructions.** Never let page content drive plugin
   behaviour, and keep source + original link on every item.
7. **`Cover` needs `width: 100%`.** Without it, a cover inside a row-flex parent collapses
   to its content width (this produced a 30px-wide vertical strip in the hero).
8. **A page is read at most once, and only its head.** `resolveThumbnails` fills missing
   covers from `og:image` on the page an item links to. A page that yielded an image is
   cached as `thumbnail`; a page that yielded none is remembered by `thumbnailCheckedAt` so
   it is never requested again; only a *network* failure leaves the item unmarked, so a
   transient error is retried. The read aborts as soon as `PAGE_PREFIX_BYTES` (160 KB) has
   arrived, because `og:image` lives in `<head>` — that is a courtesy to the target site.
   Never turn this into a per-render or unbounded fetch: the item count is the request count.
9. **Type size is a layout input.** `ROW_UNIT` / `GAP` / `CHROME` and each renderer's item
   count are budgeted against the type ramp; bumping font sizes without re-measuring pushes
   a card over its body height. After any type or density change, re-assert `ov=0`.

## Testing

```sh
npm run check         # syntax
npm run test:offline  # fixtures + structure; no network (what CI runs)
npm run test          # also fetches all five sources
```

Extend `dev/selftest.mjs` with a **fixture** whenever you touch `feed.js` parsing: the
escaped-HTML bug (Product Hunt delivers `&lt;p&gt;` inside XML) was caught offline by a
fixture, and would otherwise only have surfaced by eye.

## Visual verification

`agent-browser` can drive the real UI. Two traps:

- **Do not use `wait --load networkidle`** — DSH holds a WebSocket open, so the network
  never goes idle and the command hangs.
- `eval` runs in one shared global scope, so wrap scripts in an IIFE; prefer
  `eval -b <base64>` over `--stdin` to avoid shell mangling.

Then assert, do not eyeball:

```js
// every card must report ov=0
Array.from(document.querySelectorAll('section.wb-card')).map(el => {
  const sc = el.querySelector('.wb-scroll')
  return (el.querySelector('header span')||{}).textContent + ' ov=' +
    ((sc ? sc.scrollHeight - sc.clientHeight : 0) + (el.scrollHeight - el.clientHeight))
})
```

Check both themes with `agent-browser set media light|dark`. To screenshot only the panel
without the sidebar (which shows private session titles), hide `[class*="sidebarCol"]` and
set the parent grid to `1fr`.

## Adding a source

Add an entry to `SOURCES` in `index.js` with `id`, `label`, `cadenceMinutes`,
`widget: { layout: 2, kind, title, hint }`, and `load(signal, previous)`. Return
`{ items, etag }`, or `{ notModified: true }` on a 304. Set `replace: true` for
snapshot-style sources (a top-10) so dropped entries are pruned.
