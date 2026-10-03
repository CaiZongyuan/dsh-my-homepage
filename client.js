/**
 * Client half of the personal workbench — a widget workspace.
 *
 * The Host half's source registry declares each source's card (`kind`, `colSpan`,
 * `rowSpan`, `title`) through `/workbench/meta`; this file renders what it declares.
 * `WIDGET_KINDS` maps a kind to its renderer and to default dimensions, and a declared
 * span overrides the default. A descriptor whose `kind` this version does not know is
 * treated as an older generation and replaced wholesale by the preset — see
 * `resolveWidget`, which is what keeps a Host-half change from needing a restart.
 *
 * Every card's content budget is derived from the grid unit (ROW_UNIT) and asserted by
 * measurement in the browser; nothing may rely on being clipped. Cards overflow only as a
 * deliberate scroll, never as a cut-off row.
 *
 * Styling uses the `--dsw-alias-*` theme tokens. Two deliberate exceptions: cover art and
 * source monograms are generated artwork (seed-derived hues) — semi-transparent, so one
 * gradient reads correctly on both light and dark surfaces.
 */

window.__ModuleLoader__.load({
  id: 'dsh-my-homepage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const PANEL_ID = 'workbench'
    const API = '/workbench'

    /** Grid unit. Card body height for n rows is n*ROW_UNIT + (n-1)*GAP - CHROME. */
    const ROW_UNIT = 130
    const GAP = 14
    const CHROME = 74 // card padding + header + header margin

    // ---- theme tokens ------------------------------------------------------

    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const CARD_SHADOW = '0 1px 2px rgba(0,0,0,.04), 0 10px 26px -16px rgba(0,0,0,.20)'
    const CARD_SHADOW_HOVER = '0 2px 6px rgba(0,0,0,.06), 0 16px 36px -16px rgba(0,0,0,.26)'

    const CSS = `
.wb-root, .wb-root * { box-sizing: border-box; }
.wb-card { transition: box-shadow .16s ease, border-color .16s ease; }
.wb-card:hover { box-shadow: ${CARD_SHADOW_HOVER}; border-color: ${C.border2}; }
.wb-row { transition: background-color .12s ease; }
.wb-row:hover { background: ${C.layer2}; }
.wb-btn { transition: background-color .12s ease, border-color .12s ease, color .12s ease, opacity .12s ease; }
.wb-btn:hover { border-color: ${C.border2}; }
.wb-pill:hover { opacity: .88; }
.wb-link:hover { text-decoration: underline; }
.wb-cover img { transition: transform .35s ease; }
.wb-card:hover .wb-cover img { transform: scale(1.04); }
.wb-clamp1 { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.wb-clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wb-clamp3 { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.wb-scroll { overflow-y: auto; overscroll-behavior: contain; }
.wb-scroll::-webkit-scrollbar { width: 6px; }
.wb-scroll::-webkit-scrollbar-thumb { background: ${C.border2}; border-radius: 3px; }
.wb-scroll::-webkit-scrollbar-track { background: transparent; }
.wb-input { outline: none; transition: border-color .14s ease; font: inherit; }
.wb-input:focus { border-color: ${C.brand}; }
.wb-input::placeholder { color: ${C.idle}; }
`

    // ---- data --------------------------------------------------------------

    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
      return response.json()
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
      return response.json()
    }

    /**
     * Preview-only fallback: the harness caches a Host module per specifier, so a Host-side
     * change needs a DSH restart. Until then this reads AIHOT straight from the browser (it
     * sends `access-control-allow-origin: *`) so the design can still be judged with real
     * content. It runs only when the store returns nothing, and the UI says so.
     */
    const AIHOT_DIRECT = 'https://aihot.news/api/v1'

    function mapDirectItem(raw) {
      const source = raw?.source ?? {}
      const links = raw?.links ?? {}
      return {
        id: `aihot-${raw?.id ?? ''}`,
        sourceId: 'aihot',
        sourceLabel: 'AIHOT 精选',
        itemKind: 'article',
        title: typeof raw?.title === 'string' ? raw.title : '(无标题)',
        url: typeof links.original === 'string' ? links.original : (links.aihot ?? ''),
        altUrl: typeof links.aihot === 'string' ? links.aihot : null,
        thumbnail: null,
        publishedAt: typeof raw?.publishedAt === 'string' ? raw.publishedAt : null,
        discoveredAt: typeof raw?.discoveredAt === 'string' ? raw.discoveredAt : null,
        summary: typeof raw?.summary === 'string' ? raw.summary : '',
        reason: typeof raw?.reason === 'string' ? raw.reason : '',
        score: typeof raw?.score === 'number' ? raw.score : null,
        category: typeof raw?.category === 'string' ? raw.category : 'other',
        origin: typeof source.name === 'string' ? source.name : 'AIHOT',
        tags: [],
        metrics: null,
        attribution: raw?.attribution ?? { name: 'AIHOT', url: 'https://aihot.news' },
        state: { seen: false, starred: false, hidden: false },
      }
    }

    async function loadDirect() {
      const response = await fetch(`${AIHOT_DIRECT}/items?mode=selected&window=7d&by=timeline&limit=60`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`AIHOT 直连 HTTP ${response.status}`)
      const payload = await response.json()
      return (Array.isArray(payload?.items) ? payload.items : []).map(mapDirectItem)
    }

    /** Grid composition when the Host cannot describe it at all. Mirrors SOURCES. */
    const FALLBACK_SOURCES = [
      { id: 'aihot', label: 'AIHOT 精选', about: '中文 AI 资讯站的编辑精选', widget: { kind: 'feed', title: 'AIHOT 精选', hint: '编辑精选 · 推荐理由' } },
      { id: 'aihot-hot', label: 'AIHOT 热榜', about: '跨源热点 Top 10', widget: { kind: 'rank', title: '热榜 Top 10', hint: '多源热点' } },
      { id: 'hf-papers', label: 'HuggingFace 论文', about: '每日论文榜', widget: { kind: 'papers', title: 'HF 今日论文', hint: '每日论文榜' } },
      { id: 'producthunt', label: 'Product Hunt', about: '今日新产品', widget: { kind: 'products', title: 'Product Hunt 今日', hint: '新产品' } },
      { id: 'youtube', label: 'YouTube · Dwarkesh Patel', about: '最新视频与播客', widget: { kind: 'media', title: 'Dwarkesh Patel', hint: '最新视频 / 播客' } },
    ]

    function useWorkbench() {
      const [state, setState] = useState({ status: 'loading', items: [], meta: null, error: null, dataMode: 'host' })

      const load = async () => {
        try {
          const listed = await getJson(`${API}/items?limit=300&kind=all`)
          const meta = await getJson(`${API}/meta`)
          let items = listed.items ?? []
          let dataMode = 'host'
          let error = listed.error ?? meta.error ?? null
          if (items.length === 0) {
            try {
              items = await loadDirect()
              dataMode = 'direct'
            } catch (directError) {
              error = `${error ? `${error}；` : ''}直连兜底也失败：${String(directError?.message ?? directError)}`
            }
          }
          setState({ status: 'ready', items, meta, error, dataMode })
        } catch (error) {
          setState((current) => ({ ...current, status: 'failed', error: String(error?.message ?? error) }))
        }
      }

      useEffect(() => {
        void load()
      }, [])

      const refresh = async () => {
        setState((current) => ({ ...current, status: 'refreshing', error: null }))
        try {
          const result = await postJson(`${API}/refresh`, {})
          const failed = (result?.results ?? []).find((entry) => entry && entry.ok === false)
          await load()
          if (failed) setState((current) => ({ ...current, error: `${failed.sourceId}：${failed.error}` }))
        } catch (error) {
          setState((current) => ({ ...current, status: 'ready', error: String(error?.message ?? error) }))
        }
      }

      const setItemState = async (id, patch) => {
        setState((current) => ({
          ...current,
          items: current.items.map((item) => (item.id === id ? { ...item, state: { ...(item.state ?? {}), ...patch } } : item)),
        }))
        if (state.dataMode !== 'host') return
        try {
          await postJson(`${API}/state`, { ids: [id], ...patch })
        } catch {
          // The optimistic update stands; the next load reconciles it.
        }
      }

      return { ...state, refresh, setItemState, reload: load }
    }

    // ---- generated artwork -------------------------------------------------

    function hashOf(text) {
      let hash = 7
      const value = String(text ?? '')
      for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) >>> 0
      }
      return hash
    }

    /**
     * Cover tint is derived from the CATEGORY, not the item id: a fixed palette keeps the
     * grid coherent (every 行业 item reads the same blue) and avoids the muddy hues a hash
     * of an id produces. Alpha keeps one treatment working on light and dark alike, and it
     * stays faint on purpose — it stands in for a cover image the source does not provide,
     * so a loud block would read as a broken image rather than a surface.
     */
    const CATEGORY_HUE = {
      'ai-models': 262,
      'ai-products': 168,
      industry: 210,
      paper: 292,
      tip: 32,
      hot: 6,
      product: 168,
      podcast: 262,
      other: 220,
    }

    const hueOfCategory = (category) => CATEGORY_HUE[category] ?? CATEGORY_HUE.other

    const coverBackground = (item) => {
      const hue = hueOfCategory(item?.category)
      return [
        `linear-gradient(118deg, rgba(255,255,255,.07) 0%, rgba(255,255,255,0) 46%)`,
        `linear-gradient(140deg, hsla(${hue}, 34%, 48%, .26) 0%, hsla(${(hue + 24) % 360}, 30%, 34%, .20) 100%)`,
      ].join(', ')
    }

    function Monogram(props) {
      const name = String(props.name ?? '?').trim() || '?'
      const letter = Array.from(name)[0].toUpperCase()
      const hue = hashOf(name) % 360
      const size = props.size ?? 20
      const soft = props.tone === 'soft'
      return h(
        'span',
        {
          title: props.title ?? name,
          style: {
            flex: '0 0 auto',
            width: size,
            height: size,
            borderRadius: props.square ? Math.round(size * 0.28) : 999,
            background: soft ? C.layer2 : `hsla(${hue}, 42%, 46%, .85)`,
            color: soft ? C.text2 : 'rgba(255,255,255,.95)',
            border: soft ? `1px solid ${C.border1}` : '1px solid transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: Math.max(9, Math.round(size * 0.5)),
            lineHeight: 1,
            fontWeight: 600,
          },
        },
        letter,
      )
    }

    // ---- formatting --------------------------------------------------------

    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
    const pad = (value) => String(value).padStart(2, '0')

    function parseDate(item) {
      const raw = item?.publishedAt ?? item?.discoveredAt
      const time = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
      return Number.isFinite(time) ? new Date(time) : null
    }

    function relativeTime(item) {
      const date = parseDate(item)
      if (!date) return '时间未知'
      const diff = Date.now() - date.getTime()
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
      if (diff < 7 * 86400 * 1000) return `${Math.floor(diff / 86400000)} 天前`
      return `${date.getMonth() + 1}-${pad(date.getDate())}`
    }

    const greeting = (hour) => (hour < 6 ? '凌晨好' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好')

    const CATEGORY_LABELS = {
      'ai-models': '模型',
      'ai-products': '产品',
      industry: '行业',
      paper: '论文',
      tip: '技巧',
      product: '产品',
      podcast: '播客',
      hot: '热点',
      other: '其它',
    }
    const categoryLabel = (value) => CATEGORY_LABELS[value] ?? value ?? '其它'

    // ---- primitives --------------------------------------------------------

    function Chip(props) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            flex: '0 0 auto',
            padding: '2px 8px',
            borderRadius: 999,
            background: props.plain ? 'transparent' : C.layer2,
            border: props.plain ? `1px solid ${C.border1}` : '1px solid transparent',
            color: C.text2,
            fontSize: 12.5,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
          },
        },
        props.dot ? h('span', { style: { width: 5, height: 5, borderRadius: 999, background: props.dot } }) : null,
        props.children,
      )
    }

    function ScoreBadge(props) {
      const score = props.score
      if (typeof score !== 'number') return null
      const strong = score >= 75
      return h(
        'span',
        {
          title: `评分 ${score}`,
          style: {
            flex: '0 0 auto', minWidth: 23, textAlign: 'center',
            padding: '0 4px', borderRadius: 6,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12, lineHeight: '18px',
            color: strong ? C.brand : C.text2,
            background: strong ? C.layer2 : 'transparent',
            border: `1px solid ${strong ? C.brand : C.border1}`,
          },
        },
        String(Math.round(score)),
      )
    }

    function Button(props) {
      const primary = props.primary === true
      return h(
        'button',
        {
          type: 'button',
          className: primary ? 'wb-btn wb-pill' : 'wb-btn',
          onClick: props.onClick,
          disabled: props.disabled === true,
          style: {
            cursor: props.disabled ? 'default' : 'pointer',
            padding: '4px 11px', borderRadius: 999,
            fontSize: 13, lineHeight: '19px', font: 'inherit', flex: '0 0 auto',
            border: primary ? '1px solid transparent' : `1px solid ${C.border1}`,
            background: primary ? C.brand : C.layer1,
            color: primary ? C.base : C.text2,
            opacity: props.disabled ? 0.5 : 1,
          },
        },
        props.children,
      )
    }

    function MetaBar(props) {
      const parts = (props.parts ?? []).filter((part) => part !== null && part !== undefined && part !== '')
      return h(
        'div',
        { className: 'wb-clamp1', style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.text2, minWidth: 0, ...(props.style ?? {}) } },
        parts.map((part, index) =>
          h(
            'span',
            { key: index, style: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, flex: index === 0 ? '0 1 auto' : '0 0 auto' } },
            index > 0 ? h('span', { style: { color: C.idle } }, '·') : null,
            h('span', { className: index === 0 ? 'wb-clamp1' : null, style: { minWidth: 0 } }, part),
          ),
        ),
      )
    }

    function SourceLine(props) {
      const item = props.item
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        h(Monogram, { name: item.origin ?? item.sourceLabel, size: props.size ?? 15 }),
        h('span', { className: 'wb-clamp1', style: { fontSize: 12, color: C.text2, minWidth: 0 } }, item.origin ?? item.sourceLabel),
      )
    }

    /**
     * Real cover when the source provides one, otherwise generated artwork. `width: 100%`
     * matters: without it a cover inside a row-flex parent collapses to its content width.
     */
    function Cover(props) {
      const [failed, setFailed] = useState(false)
      const item = props.item ?? {}
      const showImage = Boolean(item.thumbnail) && !failed
      const numericHeight = typeof props.height === 'number' ? props.height : 80
      return h(
        'div',
        {
          className: 'wb-cover',
          style: {
            position: 'relative',
            flex: '0 0 auto',
            width: '100%',
            height: props.height ?? 80,
            borderRadius: props.radius ?? 12,
            overflow: 'hidden',
            border: `1px solid ${C.border1}`,
            background: showImage ? C.layer2 : coverBackground(item),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        showImage
          ? h('img', {
              src: item.thumbnail,
              alt: '',
              loading: 'lazy',
              onError: () => setFailed(true),
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            })
          : (props.center ?? h(Monogram, { name: item.origin ?? item.sourceLabel ?? 'AI', size: Math.round(numericHeight * 0.3), tone: 'soft' })),
        props.badge
          ? h('span', {
              style: {
                position: 'absolute', left: 7, top: 7,
                padding: '1px 7px', borderRadius: 999,
                background: showImage ? 'rgba(0,0,0,.42)' : `hsla(${hueOfCategory(item?.category)}, 42%, 24%, .62)`,
                color: 'rgba(255,255,255,.95)',
                fontSize: 11.5, lineHeight: '17px', backdropFilter: 'blur(4px)',
              },
            }, props.badge)
          : null,
        props.play
          ? h(
              'span',
              { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
              h(
                'span',
                {
                  style: {
                    width: 26, height: 26, borderRadius: 999, background: 'rgba(0,0,0,.44)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)',
                  },
                },
                h('span', {
                  style: {
                    width: 0, height: 0, marginLeft: 2,
                    borderTop: '5px solid transparent', borderBottom: '5px solid transparent',
                    borderLeft: '8px solid rgba(255,255,255,.95)',
                  },
                }),
              ),
            )
          : null,
      )
    }

    function Card(props) {
      const widget = props.widget ?? {}
      return h(
        'section',
        {
          className: 'wb-card',
          style: {
            gridColumn: `span ${widget.colSpan ?? 1}`,
            gridRow: `span ${widget.rowSpan ?? 1}`,
            minWidth: 0, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            background: C.layer1,
            border: `1px solid ${C.border1}`,
            borderRadius: 18,
            boxShadow: CARD_SHADOW,
            padding: 16,
            overflow: 'hidden',
          },
        },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flex: '0 0 auto', minWidth: 0 } },
          h(Chip, { dot: props.dot, plain: true }, widget.title ?? props.title ?? '组件'),
          props.hint ? h('span', { className: 'wb-clamp1', style: { fontSize: 12, color: C.idle, minWidth: 0 } }, props.hint) : null,
          h('span', { style: { flex: 1, minWidth: 0 } }),
          props.action ?? null,
        ),
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, props.children),
      )
    }

    function Empty(props) {
      return h(
        'div',
        {
          style: {
            flex: 1, minHeight: 44,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
            border: `1px dashed ${C.border1}`, borderRadius: 12,
            color: C.text2, fontSize: 12.5, lineHeight: '18px', textAlign: 'center', padding: 8,
          },
        },
        props.children,
      )
    }

    const emptyWidget = (source) =>
      h(Empty, null, h('span', null, '暂无数据'), h('span', { style: { color: C.idle } }, source.about || '等待宿主接入'))

    const scrollBody = (extra) => ({
      flex: 1, minHeight: 0, margin: '0 -4px', padding: '0 4px', ...extra,
    })

    // ---- widget kinds ------------------------------------------------------

    /** Image-led news: one lead card plus compact rows — the shape a curated feed deserves. */
    function FeedWidget(props) {
      const [openId, setOpenId] = useState(null)
      const items = props.items.slice(0, 9)
      if (items.length === 0) return emptyWidget(props.source)
      const lead = items[0]
      const rest = items.slice(1, 9)
      const open = openId === lead.id
      return h(
        'div',
        { className: 'wb-scroll', style: scrollBody({ display: 'flex', flexDirection: 'column' }) },
        h(
          'article',
          {
            className: 'wb-row',
            onClick: () => {
              setOpenId(open ? null : lead.id)
              if (!open && !lead.state?.seen) props.onState(lead.id, { seen: true })
            },
            style: { cursor: 'pointer', margin: '0 -6px', padding: 6, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 6 },
          },
          h(Cover, {
            item: lead,
            height: 58,
            badge: categoryLabel(lead.category),
            center: lead.score !== null
              ? h(
                  'span',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
                  h('span', { style: { fontSize: 27, lineHeight: '30px', fontWeight: 700, color: C.text } }, String(Math.round(lead.score))),
                  h('span', { style: { fontSize: 12, color: C.text2 } }, 'AIHOT 评分'),
                )
              : undefined,
          }),
          h(SourceLine, { item: lead }),
          h('h3', { className: open ? null : 'wb-clamp2', style: { margin: 0, fontSize: 14.5, lineHeight: '20px', fontWeight: lead.state?.seen ? 500 : 600, color: C.text } }, lead.title),
          open && (lead.reason || lead.summary)
            ? h('p', { className: 'wb-clamp3', style: { margin: 0, fontSize: 12.5, lineHeight: '18px', color: C.text2 } }, lead.reason || lead.summary)
            : null,
          open
            ? h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                lead.url ? h('a', { className: 'wb-link', href: lead.url, target: '_blank', rel: 'noreferrer', onClick: (event) => event.stopPropagation(), style: { color: C.brand, fontSize: 13, textDecoration: 'none' } }, '读原文 ↗') : null,
                h(Button, { onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); props.onState(lead.id, { starred: !lead.state?.starred }) } }, lead.state?.starred ? '★ 已星标' : '☆ 星标'),
              )
            : h(MetaBar, { parts: [relativeTime(lead), lead.score !== null ? `评分 ${lead.score}` : null] }),
        ),
        h(
          'div',
          { style: { borderTop: `1px solid ${C.border1}`, marginTop: 8, paddingTop: 4, display: 'flex', flexDirection: 'column' } },
          rest.map((item) =>
            h(
              'div',
              {
                key: item.id,
                className: 'wb-row',
                onClick: () => props.onState(item.id, { seen: true }),
                style: { cursor: 'pointer', margin: '0 -6px', padding: '5px 6px', borderRadius: 10, display: 'flex', gap: 7, alignItems: 'center' },
              },
              h('span', { style: { flex: '0 0 auto', width: 5, height: 5, borderRadius: 999, background: item.state?.seen ? C.border2 : C.brand } }),
              h('span', { className: 'wb-clamp1', style: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: '18px', color: C.text } }, item.title),
              h(ScoreBadge, { score: item.score }),
            ),
          ),
        ),
      )
    }

    /** Papers: the cover HuggingFace already renders, plus votes and comments. */
    function PapersWidget(props) {
      const items = props.items.slice(0, 2)
      if (items.length === 0) return emptyWidget(props.source)
      return h(
        'div',
        { style: scrollBody({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, alignContent: 'start' }) },
        items.map((item) =>
          h(
            'a',
            {
              key: item.id, className: 'wb-row',
              href: item.url || undefined, target: '_blank', rel: 'noreferrer',
              style: { textDecoration: 'none', padding: 5, margin: -5, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
            },
            h(Cover, { item, height: 84, radius: 10 }),
            h('h3', { className: 'wb-clamp2', style: { margin: 0, fontSize: 13, lineHeight: '18px', fontWeight: 600, color: C.text } }, item.title),
            item.tags?.length
              ? h('div', { className: 'wb-clamp1', style: { fontSize: 12, lineHeight: '17px', color: C.text2 } }, item.tags.join(' · '))
              : null,
            h(MetaBar, { parts: [`▲ ${item.metrics?.upvotes ?? 0}`, `${item.metrics?.comments ?? 0} 评论`] }),
          ),
        ),
      )
    }

    /** Video / podcast: a horizontal row with a 16:9 cover and a play badge. */
    function MediaWidget(props) {
      const items = props.items.slice(0, 2)
      if (items.length === 0) return emptyWidget(props.source)
      return h(
        'div',
        { className: 'wb-scroll', style: scrollBody({ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }) },
        items.map((item) =>
          h(
            'a',
            {
              key: item.id, className: 'wb-row',
              href: item.url || undefined, target: '_blank', rel: 'noreferrer',
              style: { textDecoration: 'none', margin: '0 -6px', padding: 5, borderRadius: 12, display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 },
            },
            h('div', { style: { flex: '0 0 122px' } }, h(Cover, { item, height: 74, radius: 10, play: true })),
            h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
              h('h3', { className: 'wb-clamp2', style: { margin: 0, fontSize: 13, lineHeight: '18px', fontWeight: 600, color: C.text } }, item.title),
              h(MetaBar, { parts: [relativeTime(item), item.metrics?.views ? `${item.metrics.views} 观看` : null] }),
            ),
          ),
        ),
      )
    }

    /** Products: a logo tile (generated) plus a one-line tagline. */
    function ProductsWidget(props) {
      const items = props.items.slice(0, 6)
      if (items.length === 0) return emptyWidget(props.source)
      return h(
        'div',
        { className: 'wb-scroll', style: scrollBody({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '4px 10px', alignContent: 'start' }) },
        items.map((item) =>
          h(
            'a',
            {
              key: item.id, className: 'wb-row',
              href: item.url || undefined, target: '_blank', rel: 'noreferrer',
              style: { textDecoration: 'none', margin: '0 -5px', padding: '5px', borderRadius: 10, display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 },
            },
            h(Monogram, { name: item.title, size: 24, square: true, title: item.title }),
            h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
              h('div', { className: 'wb-clamp1', style: { fontSize: 13, lineHeight: '18px', fontWeight: 600, color: C.text } }, item.title),
              h('div', { className: 'wb-clamp1', style: { fontSize: 12, lineHeight: '17px', color: C.text2 } }, item.summary || 'Product Hunt'),
            ),
          ),
        ),
      )
    }

    /** Hot topics: a numbered list — the number is the visual. */
    function RankWidget(props) {
      const items = props.items
        .filter((item) => item.itemKind === 'rank')
        .sort((a, b) => (a.metrics?.rank ?? 99) - (b.metrics?.rank ?? 99))
        .slice(0, 6)
      if (items.length === 0) return emptyWidget(props.source)
      return h(
        'div',
        { className: 'wb-scroll', style: scrollBody({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '2px 12px', alignContent: 'start' }) },
        items.map((item, index) =>
          h(
            'a',
            {
              key: item.id, className: 'wb-row',
              href: item.url || undefined, target: '_blank', rel: 'noreferrer',
              style: { textDecoration: 'none', margin: '0 -6px', padding: '5px 6px', borderRadius: 10, display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 },
            },
            h(
              'span',
              {
                style: {
                  flex: '0 0 auto', width: 20, textAlign: 'center',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 16.5, lineHeight: '20px', fontWeight: 700,
                  color: index < 3 ? C.brand : C.idle,
                },
              },
              pad(index + 1),
            ),
            h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
              h('div', { className: 'wb-clamp2', style: { fontSize: 13, lineHeight: '18px', color: C.text } }, item.title),
              h('div', { className: 'wb-clamp1', style: { fontSize: 11.5, color: C.text2 } }, item.origin),
            ),
          ),
        ),
      )
    }

    /** A number with a quiet label — sized for a single-row card. */
    function StatWidget(props) {
      return h(
        'div',
        { style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 } },
        h('div', { style: { fontSize: 31, lineHeight: '32px', fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums' } }, String(props.value ?? 0)),
        h('div', { className: 'wb-clamp1', style: { fontSize: 12, color: C.text2 } }, props.label),
      )
    }

    function ClockWidget() {
      const [now, setNow] = useState(new Date())
      useEffect(() => {
        const handle = setInterval(() => setNow(new Date()), 20000)
        return () => clearInterval(handle)
      }, [])
      return h(
        'div',
        { style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 } },
        h('div', { style: { fontSize: 31, lineHeight: '32px', fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums' } },
          `${pad(now.getHours())}:${pad(now.getMinutes())}`),
        h('div', { className: 'wb-clamp1', style: { fontSize: 12, color: C.text2 } }, `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${WEEKDAYS[now.getDay()]}`),
      )
    }

    /** Source health as bars, so it reads as a chart rather than a paragraph. */
    function HealthWidget(props) {
      const sources = props.sources
      if (sources.length === 0) return h(Empty, null, '尚无信息源')
      const max = Math.max(1, ...sources.map((source) => source.itemCount ?? 0))
      return h(
        'div',
        { className: 'wb-scroll', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' } },
        sources.map((source) =>
          h(
            'div',
            { key: source.id, style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
            h('span', {
              style: {
                flex: '0 0 auto', width: 6, height: 6, borderRadius: 999,
                background: source.lastError ? C.error : source.lastRunAt ? C.ok : C.idle,
              },
            }),
            h('span', { className: 'wb-clamp1', style: { flex: '0 0 40%', minWidth: 0, fontSize: 12, color: C.text2 } }, source.label),
            h(
              'span',
              { style: { flex: 1, height: 5, borderRadius: 999, background: C.layer2, overflow: 'hidden', minWidth: 0 } },
              h('span', {
                style: {
                  display: 'block',
                  width: `${Math.round(((source.itemCount ?? 0) / max) * 100)}%`,
                  height: '100%', borderRadius: 999,
                  background: source.lastError ? C.error : C.brand,
                  opacity: source.lastError ? 0.7 : 0.8,
                },
              }),
            ),
            h('span', { style: { flex: '0 0 auto', fontSize: 11.5, color: C.idle, fontVariantNumeric: 'tabular-nums' } }, String(source.itemCount ?? 0)),
          ),
        ),
      )
    }

    // ---- kind registry: renderer + default size ---------------------------

    const WIDGET_KINDS = {
      feed: { colSpan: 2, rowSpan: 4, render: FeedWidget },
      papers: { colSpan: 2, rowSpan: 2, render: PapersWidget },
      products: { colSpan: 2, rowSpan: 2, render: ProductsWidget },
      media: { colSpan: 1, rowSpan: 2, render: MediaWidget },
      rank: { colSpan: 2, rowSpan: 2, render: RankWidget },
    }

    /**
     * `kind` chooses the renderer AND the size; a declared span is deliberately ignored
     * because size is a presentation concern, and honoring a span from an older Host
     * generation is what produced clipped cards. `widget.layout` is the generation marker:
     * with it, the Host's kind is authoritative. Without it the descriptor predates this
     * vocabulary, so the source id decides — `LEGACY_KIND` exists only for that case and
     * can be deleted once every Host declares `layout: 2`.
     */
    const LAYOUT_GENERATION = 2

    const LEGACY_KIND = {
      aihot: 'feed',
      'aihot-hot': 'rank',
      'hf-papers': 'papers',
      producthunt: 'products',
      youtube: 'media',
    }

    function resolveWidget(source) {
      const declared = source.widget ?? {}
      const declaredKind = WIDGET_KINDS[declared.kind] ? declared.kind : null
      const current = declared.layout === LAYOUT_GENERATION
      const kind = current
        ? (declaredKind ?? 'feed')
        : (LEGACY_KIND[source.id] ?? declaredKind ?? 'feed')
      const preset = WIDGET_KINDS[kind] ?? WIDGET_KINDS.feed
      return {
        kind,
        title: declared.title ?? source.label,
        hint: declared.hint ?? '',
        colSpan: preset.colSpan,
        rowSpan: preset.rowSpan,
      }
    }

    // ---- featured + reader -------------------------------------------------

    function Featured(props) {
      const item = props.item
      if (!item) return h(Empty, null, '还没有可推荐的条目')
      return h(
        'article',
        { style: { flex: 1, display: 'flex', gap: 16, minHeight: 0, margin: -6, padding: 6, borderRadius: 14 } },
        h('div', { style: { flex: '0 0 42%', minWidth: 0, display: 'flex' } },
          h(Cover, {
            item,
            height: '100%',
            radius: 14,
            badge: categoryLabel(item.category),
            center: h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 } },
              h('div', { style: { fontSize: 46, lineHeight: '52px', fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' } },
                item.score !== null ? String(Math.round(item.score)) : '—'),
              h('div', { style: { fontSize: 12.5, color: C.text2 } }, 'AIHOT 评分'),
            ),
          })),
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 2 } },
          h(SourceLine, { item, size: 17 }),
          h('h2', { className: 'wb-clamp2', style: { margin: 0, fontSize: 22, lineHeight: '30px', fontWeight: 600, color: C.text } }, item.title),
          item.reason || item.summary
            ? h('p', { className: 'wb-clamp2', style: { margin: 0, fontSize: 13.5, lineHeight: '20px', color: C.text2 } }, item.reason || item.summary)
            : null,
          h('span', { style: { flex: 1 } }),
          h(MetaBar, { parts: [relativeTime(item), item.score !== null ? `评分 ${item.score}` : null] }),
          h(
            'div',
            { style: { display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' } },
            item.url ? h(Button, { primary: true, onClick: () => window.open(item.url, '_blank', 'noreferrer') }, '读原文 ↗') : null,
            h(Button, { onClick: () => props.onState(item.id, { seen: !item.state?.seen }) }, item.state?.seen ? '标为未读' : '标为已读'),
            h(Button, { onClick: () => props.onState(item.id, { starred: !item.state?.starred }) }, item.state?.starred ? '★ 已星标' : '☆ 星标'),
          ),
        ),
      )
    }

    function ReaderSheet(props) {
      const { source, items, onClose, onState } = props
      const [openId, setOpenId] = useState(null)
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      return h(
        'div',
        { onClick: onClose, style: { position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(0,0,0,.32)', display: 'flex', justifyContent: 'center', padding: 20 } },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              flex: '1 1 auto', maxWidth: 900, minWidth: 0, display: 'flex', flexDirection: 'column',
              background: C.layer1, border: `1px solid ${C.border1}`, borderRadius: 18,
              boxShadow: CARD_SHADOW_HOVER, overflow: 'hidden',
            },
          },
          h(
            'header',
            { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${C.border1}` } },
            h(Monogram, { name: source.widget?.title ?? source.label, size: 20 }),
            h('span', { style: { fontSize: 14.5, fontWeight: 600 } }, source.widget?.title ?? source.label),
            h('span', { style: { fontSize: 13, color: C.text2 } }, `${items.length} 条`),
            h('span', { style: { flex: 1 } }),
            h(Button, { onClick: onClose }, '关闭 Esc'),
          ),
          h(
            'div',
            { className: 'wb-scroll', style: { flex: 1, minHeight: 0, padding: '12px 18px 24px', display: 'flex', flexDirection: 'column', gap: 4 } },
            items.map((item) => {
              const open = openId === item.id
              return h(
                'div',
                {
                  key: item.id, className: 'wb-row',
                  onClick: () => {
                    setOpenId(open ? null : item.id)
                    if (!open && !item.state?.seen) onState(item.id, { seen: true })
                  },
                  style: { cursor: 'pointer', padding: '9px 10px', margin: '0 -10px', borderRadius: 12, display: 'flex', gap: 11, alignItems: 'flex-start' },
                },
                h('span', { style: { flex: '0 0 auto', width: 6, height: 6, marginTop: 7, borderRadius: 999, background: item.state?.seen ? C.border2 : C.brand } }),
                h('div', { style: { flex: '0 0 76px' } }, h(Cover, { item, height: 46, radius: 9 })),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
                  h('div', { className: open ? null : 'wb-clamp2', style: { fontSize: 14, lineHeight: '20px', fontWeight: item.state?.seen ? 500 : 600, color: C.text } }, item.title),
                  h(MetaBar, { parts: [item.origin, relativeTime(item), item.score !== null ? `评分 ${item.score}` : null] }),
                  open && item.reason
                    ? h('div', { style: { marginTop: 4, borderLeft: `2px solid ${C.brand}`, padding: '5px 9px', background: C.layer2, borderRadius: '0 6px 6px 0', fontSize: 13, lineHeight: '20px', color: C.text } },
                        h('span', { style: { color: C.brand, marginRight: 5 } }, '推荐理由'), item.reason)
                    : null,
                  open && item.summary ? h('div', { className: 'wb-clamp3', style: { fontSize: 13, lineHeight: '20px', color: C.text2 } }, item.summary) : null,
                  open
                    ? h(
                        'div',
                        { style: { marginTop: 6, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' } },
                        item.url ? h('a', { className: 'wb-link', href: item.url, target: '_blank', rel: 'noreferrer', onClick: (event) => event.stopPropagation(), style: { color: C.brand, fontSize: 13, textDecoration: 'none' } }, '原文 ↗') : null,
                        item.altUrl ? h('a', { className: 'wb-link', href: item.altUrl, target: '_blank', rel: 'noreferrer', onClick: (event) => event.stopPropagation(), style: { color: C.brand, fontSize: 13, textDecoration: 'none' } }, '相关 ↗') : null,
                        h(Button, { onClick: () => onState(item.id, { starred: !item.state?.starred }) }, item.state?.starred ? '★ 已星标' : '☆ 星标'),
                      )
                    : null,
                ),
                h(ScoreBadge, { score: item.score }),
              )
            }),
          ),
        ),
      )
    }

    // ---- panel -------------------------------------------------------------

    function WorkbenchPanel() {
      const workbench = useWorkbench()
      const [reader, setReader] = useState(null)
      const [category, setCategory] = useState('all')
      const [query, setQuery] = useState('')
      const [thumbPass, setThumbPass] = useState(0)

      /**
       * While items are still missing a cover, ask the Host for a pass (it reads `og:image`
       * off each linked page, a few per pass) and reload. Bounded, so a page that yields no
       * image cannot turn this into a loop.
       */
      useEffect(() => {
        if (workbench.dataMode !== 'host' || workbench.status !== 'ready') return undefined
        if (thumbPass >= 6 || document.visibilityState === 'hidden') return undefined
        const missing = workbench.items.filter((item) => !item.thumbnail && item.url).length
        if (missing === 0) return undefined
        const handle = setTimeout(async () => {
          try {
            await postJson(`${API}/thumbnails`, {})
          } catch {
            // the pass is best-effort
          }
          setThumbPass((count) => count + 1)
          await workbench.reload()
        }, 5000)
        return () => clearTimeout(handle)
      }, [workbench.items, workbench.status, workbench.dataMode, thumbPass])

      const meta = workbench.meta
      const sources = (meta && Array.isArray(meta.sources) && meta.sources.length > 0 ? meta.sources : FALLBACK_SOURCES)
      const items = workbench.items

      const bySource = new Map()
      for (const item of items) {
        if (!bySource.has(item.sourceId)) bySource.set(item.sourceId, [])
        bySource.get(item.sourceId).push(item)
      }

      const direct = workbench.dataMode === 'direct'
      const newsItems = bySource.get('aihot') ?? []
      const filteredNews = newsItems.filter((item) => {
        if (category !== 'all' && item.category !== category) return false
        if (query) {
          const haystack = `${item.title} ${item.summary} ${item.reason} ${item.origin}`.toLowerCase()
          if (!haystack.includes(query.toLowerCase())) return false
        }
        return true
      })

      const categories = [...new Set(newsItems.map((item) => item.category))].filter(Boolean)
      const isToday = (item) => {
        const date = parseDate(item)
        return Boolean(date) && date.toDateString() === new Date().toDateString()
      }
      const localToday = items.filter(isToday).length
      const localUnread = items.filter((item) => !item.state?.seen).length
      const todayCount = direct ? localToday : (meta?.todayCount ?? localToday)
      const unread = direct ? localUnread : (meta?.unreadCount ?? localUnread)
      const erroring = meta?.health?.erroring ?? sources.filter((source) => source.lastError).length
      const now = new Date()

      const featured = filteredNews
        .slice()
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (parseDate(b)?.getTime() ?? 0) - (parseDate(a)?.getTime() ?? 0))[0] ?? null

      const widgetFor = (source) => {
        const all = bySource.get(source.id) ?? []
        const widget = resolveWidget(source)
        const preset = WIDGET_KINDS[widget.kind]
        let shown = widget.kind === 'rank' ? all.filter((item) => item.itemKind === 'rank') : all.filter((item) => item.itemKind !== 'rank')
        if (source.id === 'aihot' && (category !== 'all' || query)) shown = filteredNews

        const common = { key: source.id, source, widget, items: shown, onState: workbench.setItemState }
        const action = shown.length > 4
          ? h('button', {
              type: 'button', className: 'wb-btn',
              onClick: () => setReader({ source: { ...source, widget }, items: shown }),
              style: { cursor: 'pointer', border: 'none', background: 'transparent', color: C.text2, fontSize: 12, font: 'inherit', padding: 0, flex: '0 0 auto' },
            }, '全部 →')
          : null

        return h(
          Card,
          { key: source.id, widget, hint: widget.hint, dot: widget.kind === 'rank' ? C.warn : C.brand, action },
          h(preset.render, common),
        )
      }

      const statusLine = workbench.status === 'refreshing' ? '正在刷新…'
        : direct ? '预览直连模式（宿主存储待重启生效）'
          : erroring > 0 ? `${erroring}/${sources.length} 个源异常` : '全部信息源正常'

      const chipRow = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 14 } },
        [['all', '全部'], ...categories.map((value) => [value, categoryLabel(value)])].map(([value, label]) =>
          h(
            'button',
            {
              key: value, type: 'button', className: 'wb-btn wb-pill',
              onClick: () => setCategory(value),
              style: {
                cursor: 'pointer', padding: '4px 12px', borderRadius: 999, font: 'inherit', fontSize: 13.5, lineHeight: '20px',
                border: `1px solid ${category === value ? 'transparent' : C.border1}`,
                background: category === value ? C.brand : C.layer1,
                color: category === value ? C.base : C.text2,
              },
            },
            value === 'all' ? label : `#${label}`,
          ),
        ),
        h('span', { style: { flex: 1 } }),
        h('input', {
          className: 'wb-input',
          value: query,
          placeholder: '搜索标题 / 摘要…',
          onChange: (event) => setQuery(event.target.value),
          style: { width: 190, padding: '5px 12px', borderRadius: 999, border: `1px solid ${C.border1}`, background: C.layer1, color: C.text, fontSize: 13.5, lineHeight: '20px' },
        }),
      )

      const tile = (key, title, dot, colSpan, rowSpan, body) =>
        h(Card, { key, widget: { colSpan, rowSpan, title }, dot }, body)

      return h(
        'div',
        {
          className: 'wb-root',
          style: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: C.base, color: C.text, fontFamily: 'inherit' },
        },
        h('style', null, CSS),
        h(
          'div',
          { className: 'wb-scroll', style: { flex: 1, minHeight: 0 } },
          h(
            'div',
            { style: { maxWidth: 1240, margin: '0 auto', padding: '20px 22px 36px' } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 15 } },
              h('div', {
                style: {
                  flex: '0 0 auto', width: 46, height: 46, borderRadius: 14,
                  background: C.brand, color: C.base,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 21, fontWeight: 600, boxShadow: CARD_SHADOW,
                },
              }, '工'),
              h(
                'div',
                { style: { flex: '1 1 240px', minWidth: 0 } },
                h('div', { style: { fontSize: 23, lineHeight: '32px', fontWeight: 600 } }, greeting(now.getHours())),
                h('div', { style: { fontSize: 14, color: C.text2, marginTop: 1 } },
                  `今天 ${todayCount} 条新内容 · ${unread} 条未读 · ${statusLine}`),
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(Chip, { dot: C.brand }, `今日 +${todayCount}`),
                h(Chip, { dot: unread > 0 ? C.warn : C.idle }, `未读 ${unread}`),
                h(Chip, { dot: erroring > 0 ? C.error : C.ok }, `源 ${sources.length - erroring}/${sources.length}`),
                h(Button, { primary: true, onClick: workbench.refresh, disabled: workbench.status === 'refreshing' || workbench.status === 'loading' },
                  workbench.status === 'refreshing' ? '刷新中…' : '刷新'),
              ),
            ),
            chipRow,
            workbench.error
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 12, padding: '8px 12px', borderRadius: 12, border: `1px solid ${C.warn}`, color: C.text2, fontSize: 13, lineHeight: '20px' } },
                  h('span', { style: { color: C.warn } }, '注意'),
                  h('span', { style: { minWidth: 0 } }, String(workbench.error).slice(0, 260)),
                )
              : null,
            h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gridAutoRows: `${ROW_UNIT}px`,
                  gridAutoFlow: 'dense',
                  gap: GAP,
                },
              },
              h(Card, { key: '__featured', widget: { colSpan: 4, rowSpan: 2, title: '今日焦点' }, hint: '按评分挑选', dot: C.brand },
                h(Featured, { item: featured, onState: workbench.setItemState })),
              sources.map(widgetFor),
              tile('__today', '今日新增', C.ok, 1, 1, h(StatWidget, { value: todayCount, label: '自 00:00 起' })),
              tile('__clock', '本地时间', C.idle, 1, 1, h(ClockWidget, null)),
              tile('__health', '信息源', erroring > 0 ? C.error : C.ok, 2, 2, h(HealthWidget, { sources })),
            ),
            h('div', { style: { marginTop: 14, fontSize: 12.5, color: C.idle, lineHeight: '19px' } },
              '数据来源：AIHOT（个人非商业使用）、HuggingFace、Product Hunt、YouTube。抓取到的内容一律视为资料，不作为指令执行。'),
          ),
        ),
        reader ? h(ReaderSheet, { source: reader.source, items: reader.items, onClose: () => setReader(null), onState: workbench.setItemState }) : null,
      )
    }

    // ---- sidebar icon ------------------------------------------------------

    function WorkbenchIcon(props) {
      const size = props && props.size ? props.size : 18
      const cells = [
        [3, 3, 8, 8],
        [13, 3, 8, 5],
        [13, 10, 8, 11],
        [3, 13, 8, 8],
      ]
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block', opacity: props && props.active ? 1 : 0.72 } },
        cells.map((box, index) =>
          h('rect', { key: index, x: box[0], y: box[1], width: box[2], height: box[3], rx: 2, fill: 'currentColor', opacity: 0.28 + index * 0.16 }),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // `id` addresses the matching `main` key: the sidebar owns the button and switches
        // the central panel, so no manual selectPanel call is needed.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '工作台' }, WorkbenchIcon),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, WorkbenchPanel),
        )
      },
    }
  },
})
