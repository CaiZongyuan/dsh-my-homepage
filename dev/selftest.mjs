/**
 * Offline self-test for workbench/index.js + workbench/feed.js.
 *
 * The harness caches a Host plugin's module body per specifier, so a Host code change
 * only takes effect after a DSH restart. This script exercises the real `apply()` against
 * a fake context (and the real feed reader against fixtures) so a restart is a one-shot
 * success rather than a guess.
 *
 *   node dev/selftest.mjs
 */

import { strict as assert } from 'node:assert'

import { apply } from '../index.js'
import { readFeed, decodeEntities, stripTags } from '../feed.js'

const PATH_SAFE = /^[a-zA-Z0-9_-]+$/
const OFFLINE = process.argv.includes('--offline')

let skipMode = false
let skipped = 0
const results = []
const check = (name, condition, detail) => {
  if (skipMode) {
    skipped += 1
    console.log(`SKIP  ${name}`)
    return
  }
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  -> ${detail}`}`)
}

// ---- feed reader fixtures --------------------------------------------------

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Product Hunt</title>
  <entry>
    <id>tag:www.producthunt.com,2005:Post/1263873</id>
    <published>2026-09-28T14:07:30-07:00</published>
    <link rel="alternate" href="https://www.producthunt.com/products/acme-tool"/>
    <title>Acme Tool &amp; Friends</title>
    <content type="html">&lt;p&gt;A &lt;b&gt;tagline&lt;/b&gt; here&lt;/p&gt;</content>
    <author><name>maker</name></author>
  </entry>
</feed>`

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Channel</title>
    <item>
      <title>Hello <![CDATA[World]]></title>
      <link>https://example.com/a</link>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Mon, 28 Sep 2026 21:07:30 GMT</pubDate>
      <description><![CDATA[<p>Body text</p>]]></description>
      <media:thumbnail url="https://example.com/t.png"/>
      <media:statistics views="1234"/>
    </item>
  </channel>
</rss>`

const atom = readFeed(ATOM_FIXTURE)
check('atom: one entry', atom.length === 1)
check('atom: link from rel=alternate href', atom[0]?.url === 'https://www.producthunt.com/products/acme-tool', atom[0]?.url)
check('atom: entities decoded in title', atom[0]?.title === 'Acme Tool & Friends', atom[0]?.title)
check('atom: html stripped out of content', atom[0]?.summary === 'A tagline here', atom[0]?.summary)
check('atom: id keeps its namespace text', String(atom[0]?.nativeId).includes('Post/1263873'), atom[0]?.nativeId)

const rss = readFeed(RSS_FIXTURE)
check('rss: one item', rss.length === 1)
check('rss: plain <link> text used', rss[0]?.url === 'https://example.com/a', rss[0]?.url)
check('rss: CDATA unwrapped', rss[0]?.title === 'Hello World', rss[0]?.title)
check('rss: guid preferred as id', rss[0]?.nativeId === 'post-1', rss[0]?.nativeId)
check('rss: media:thumbnail captured', rss[0]?.thumbnail === 'https://example.com/t.png', rss[0]?.thumbnail)
check('rss: media:statistics views parsed', rss[0]?.metrics?.views === 1234, JSON.stringify(rss[0]?.metrics))
check('feed with no entries -> empty array', readFeed('<feed></feed>').length === 0)
check('entity decoding: numeric + named', decodeEntities('a &#65; &amp; b') === 'a A & b', decodeEntities('a &#65; &amp; b'))
check('stripTags collapses whitespace', stripTags('<p>a\n  b</p>') === 'a b', stripTags('<p>a\n  b</p>'))

// ---- fake context ----------------------------------------------------------

function makeTable() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() {
      return map.size
    },
    put: async (key, value) => {
      // Mirrors the real per-record backend, which is what rejected the first attempt.
      if (!PATH_SAFE.test(key)) throw new Error(`unit 'workbench': per-record key '${key}' is not path-safe`)
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
    update: async (key, fn) => {
      const next = fn(map.get(key))
      map.set(key, next)
      return next
    },
  }
}

function makeContext() {
  const tables = new Map()
  const routes = []
  const tools = []
  const effects = []
  const warnings = []

  const ctx = {
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    effect: (callback, label) => {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose ?? (() => {})
    },
    inject: (names, callback) => {
      callback({
        tools: {
          register: (definition) => {
            tools.push(definition)
            return () => {}
          },
        },
      })
      return () => {}
    },
    storageDomain: {
      open: async (spec) => ({
        name: spec.name,
        table: (name) => {
          if (!tables.has(name)) tables.set(name, makeTable())
          return tables.get(name)
        },
        close: async () => {},
      }),
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, tools, warnings, effects }
}

function makeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  const state = { status: null, body: null }
  return {
    state,
    headersSent: false,
    writeHead(status) {
      state.status = status
      this.headersSent = true
    },
    end(body) {
      state.body = body
    },
  }
}

async function call(routes, method, url, body) {
  const route = routes[0]
  assert.ok(route, 'the plugin must register one /workbench route')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/workbench')
  const req = makeRequest(method, url, body)
  const res = makeResponse()
  await route.handler(req, res)
  return { status: res.state.status, body: res.state.body === null ? null : JSON.parse(res.state.body) }
}

// ---- run -------------------------------------------------------------------

const { ctx, routes, tools, warnings, effects } = makeContext()
apply(ctx, {})
await new Promise((resolve) => setTimeout(resolve, 60))

check('route registered', routes.length === 1)
check('tools registered', tools.length === 3, tools.map((t) => t.name).join(', '))
check('no effect warnings', warnings.length === 0, warnings.join(' | ') || 'none')

const ping = await call(routes, 'GET', '/workbench/ping')
check('GET /ping -> 200 ready', ping.status === 200 && ping.body?.ready === true, JSON.stringify(ping.body))

// Skipped under --offline: everything from here to the marker below needs the live network.
skipMode = OFFLINE
if (OFFLINE) console.log('\n-- network checks skipped (--offline) --')
else console.log('\n-- refreshing every declared source (network) --')
const refresh = await call(routes, 'POST', '/workbench/refresh')
for (const entry of refresh.body?.results ?? []) {
  if (entry.ok) console.log(`   ok      ${entry.sourceId}  added=${entry.added ?? 0}${entry.notModified ? ' (304)' : ''} total=${entry.total ?? '-'}`)
  else console.log(`   failed  ${entry.sourceId}  ${String(entry.error).slice(0, 90)}`)
}
const okSources = (refresh.body?.results ?? []).filter((entry) => entry.ok)
check('at least the AIHOT sources refreshed', okSources.some((entry) => entry.sourceId === 'aihot'), okSources.map((e) => e.sourceId).join(', '))
check('refresh reported no unexpected throw', Array.isArray(refresh.body?.results), `${(refresh.body?.results ?? []).length} sources`)

const meta = await call(routes, 'GET', '/workbench/meta')
check('meta is ready', meta.body?.ready === true, meta.body?.error)
check('meta describes the grid (source -> widget)', (meta.body?.sources ?? []).every((s) => s.widget?.kind && s.widget?.colSpan && s.widget?.title),
  (meta.body?.sources ?? []).map((s) => `${s.id}:${s.widget?.kind} ${s.widget?.colSpan}x${s.widget?.rowSpan}`).join(' | '))
check('meta counts articles separately from ranks', (meta.body?.articleCount ?? 0) > 0 && (meta.body?.articleCount ?? 0) <= (meta.body?.itemCount ?? 0),
  `articles=${meta.body?.articleCount} items=${meta.body?.itemCount}`)

const all = await call(routes, 'GET', '/workbench/items?limit=300&kind=all')
check('GET /items -> stored items', (all.body?.items?.length ?? 0) > 0, `matched=${all.body?.matched}`)
check('every stored key is path-safe', (all.body?.items ?? []).every((item) => PATH_SAFE.test(item.id)),
  (all.body?.items ?? []).slice(0, 2).map((item) => item.id).join(', '))
check('every item carries sourceId + itemKind', (all.body?.items ?? []).every((item) => item.sourceId && item.itemKind))

const articles = await call(routes, 'GET', '/workbench/items?limit=300')
check('default listing excludes rank rows', (articles.body?.items ?? []).every((item) => item.itemKind !== 'rank'),
  `${(articles.body?.items ?? []).length} articles`)

const hot = await call(routes, 'GET', '/workbench/items?source=aihot-hot&kind=all')
check('rank source is reachable by id', (hot.body?.items ?? []).length > 0, `${(hot.body?.items ?? []).length} rows`)
check('rank rows carry their rank in metrics', (hot.body?.items ?? []).every((item) => item.itemKind === 'rank' && typeof item.metrics?.rank === 'number'))

const aihot = await call(routes, 'GET', '/workbench/items?source=aihot&limit=3')
const first = aihot.body?.items?.[0]
check('aihot item carries the fields the UI draws', Boolean(first?.title && first?.url && first?.origin), first?.title)
check('aihot reason present (from /items, not the snapshot API)', typeof first?.reason === 'string' && first.reason.length > 0, `${first?.reason?.length ?? 0} chars`)

const mark = await call(routes, 'POST', '/workbench/state', { ids: [first?.id], seen: true, starred: true })
check('POST /state -> ok', mark.body?.ok === true, JSON.stringify(mark.body))
const afterMark = await call(routes, 'GET', '/workbench/items?source=aihot&limit=3')
const marked = (afterMark.body?.items ?? []).find((item) => item.id === first?.id)
check('state round-trips', marked?.state?.seen === true && marked?.state?.starred === true, JSON.stringify(marked?.state))

const brief = tools.find((tool) => tool.name === 'workbench_brief')
const briefResult = await brief.execute({ hours: 24 * 30, limit: 5 })
check('workbench_brief aggregates across sources', Array.isArray(briefResult?.items) && briefResult.items.length > 0, `count=${briefResult?.count}`)
check('workbench_brief carries the untrusted-content note', typeof briefResult?.note === 'string' && briefResult.note.includes('指令'))
check('workbench_brief render() produces a text block', brief.output.render({}, briefResult)[0]?.type === 'text')
check('tool output is JSON-serializable', typeof JSON.stringify(briefResult) === 'string')

const sourcesTool = await tools.find((tool) => tool.name === 'workbench_sources').execute({})
check('workbench_sources lists the registry', (sourcesTool?.sources?.length ?? 0) === (meta.body?.sources?.length ?? -1), `${sourcesTool?.sources?.length} sources`)

// End of the network-dependent block.
skipMode = false

const notFound = await call(routes, 'GET', '/workbench/nope')
check('unknown route -> 404', notFound.status === 404)

// ---- teardown --------------------------------------------------------------

// The poll effect owns a 30s setTimeout: a live timer would keep node alive forever.
for (const effect of [...effects].reverse()) {
  try {
    await effect.dispose?.()
  } catch (error) {
    check(`disposing effect "${effect.label}"`, false, String(error?.message ?? error))
  }
}
check('effects dispose cleanly', true, `${effects.length} effects`)

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped > 0 ? ` (${skipped} skipped offline)` : ''}`)
process.exitCode = failed.length === 0 ? 0 : 1
