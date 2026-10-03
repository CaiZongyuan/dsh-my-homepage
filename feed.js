/**
 * Deliberately small readers: RSS 2.0 / Atom / RDF for syndication, plus `og:image`
 * extraction for pages a source links to but publishes no image for (AIHOT and Product
 * Hunt both do this). Zero dependencies, and readers rather than parsers — they extract
 * the handful of fields the workbench stores and ignore everything else.
 *
 * Relative imports are safe here even though the bundle is installed as a pnpm link
 * (which breaks bare specifiers); a relative specifier resolves against this file.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Reduce a feed field to plain text.
 *
 * Entities are decoded FIRST, then tags are stripped. Feeds very commonly deliver
 * escaped HTML inside XML (`&lt;p&gt;…`), which is what Product Hunt's `<content>` does;
 * stripping tags before decoding leaves that markup in the summary verbatim.
 */
export const stripTags = (value) =>
  decodeEntities(String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  return match ? match[1] : null
}

function tagAttr(block, tag, attribute) {
  const match = block.match(new RegExp(`<${tag}[^>]*\\s${attribute}="([^"]*)"`, 'i'))
  return match ? match[1] : null
}

export function readFeed(xml) {
  const text = String(xml)
  const blocks = text.match(/<entry[\s>][\s\S]*?<\/entry>/gi)
    ?? text.match(/<item[\s>][\s\S]*?<\/item>/gi)
    ?? []

  return blocks.map((block) => {
    const rawLink = tagText(block, 'link')
    const link = tagAttr(block, 'link', 'href')
      ?? (rawLink ? decodeEntities(rawLink.trim()) : null)
    const id = tagText(block, 'id') ?? tagText(block, 'guid') ?? link ?? ''
    const summary = tagText(block, 'summary') ?? tagText(block, 'content') ?? tagText(block, 'description')
    const views = tagAttr(block, 'media:statistics', 'views')
    return {
      nativeId: stripTags(id) || link || '',
      title: stripTags(tagText(block, 'title') ?? ''),
      url: link ?? '',
      publishedAt: (tagText(block, 'published') ?? tagText(block, 'pubDate') ?? tagText(block, 'updated') ?? '').trim() || null,
      summary: summary ? stripTags(summary).slice(0, 1200) : '',
      thumbnail: tagAttr(block, 'media:thumbnail', 'url') ?? tagAttr(block, 'media:content', 'url') ?? null,
      metrics: views && Number.isFinite(Number(views)) ? { views: Number(views) } : undefined,
    }
  })
}

// ---- page metadata (for sources that publish no image) ---------------------

/** Resolve a possibly relative URL against the page it came from. */
export function absoluteUrl(value, base) {
  if (typeof value !== 'string') return null
  const trimmed = decodeEntities(value).trim()
  if (!trimmed || /^data:/i.test(trimmed)) return null
  try {
    return new URL(trimmed, base).href
  } catch {
    return null
  }
}

/**
 * Pull the social preview image out of an HTML document.
 *
 * Attribute order varies in the wild (`property` before or after `content`), so each
 * pattern matches the whole tag and then reads `content` out of it. JSON-LD is the
 * fallback because a fair number of news sites only advertise the image there.
 */
export function extractOgImage(html, baseUrl) {
  const text = String(html ?? '')
  const metaPatterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]*>/i,
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]*>/i,
    /<meta[^>]+name=["']og:image["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
    /<meta[^>]+property=["']twitter:image(?::src)?["'][^>]*>/i,
  ]
  for (const pattern of metaPatterns) {
    const tag = text.match(pattern)
    if (!tag) continue
    const content = tag[0].match(/content\s*=\s*["']([^"']+)["']/i)
    const url = content ? absoluteUrl(content[1], baseUrl) : null
    if (url) return url
  }

  const ld = text.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i)
  if (ld) {
    try {
      const parsed = JSON.parse(decodeEntities(ld[1]).trim())
      const node = Array.isArray(parsed) ? parsed[0] : parsed
      const image = node?.image ?? node?.thumbnailUrl ?? node?.primaryImageOfPage?.url
      const candidate = typeof image === 'string' ? image : (Array.isArray(image) ? image[0] : image?.url)
      const url = absoluteUrl(candidate, baseUrl)
      if (url) return url
    } catch {
      // malformed JSON-LD is common; it simply yields no image
    }
  }
  return null
}
