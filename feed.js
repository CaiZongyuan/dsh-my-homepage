/**
 * A deliberately small feed reader: RSS 2.0, Atom, and the RDF shape these sources
 * actually publish. Zero dependencies, and it is a reader rather than a parser — it
 * extracts the handful of fields the workbench stores and ignores everything else.
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
