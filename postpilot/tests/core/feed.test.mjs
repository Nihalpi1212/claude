import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  clipText,
  decodeEntities,
  DOWNLOAD_RETRY_BASE_MS,
  downloadRetryAt,
  feedCaption,
  FEED_TEMPLATE,
  fitsFeed,
  isHttpUrl,
  jpegInfo,
  kindFromUrl,
  nameFromUrl,
  newestFirst,
  nonJpegFormat,
  ogImage,
  parseFeed,
  parseFeedDate,
  parseXml,
  resolveUrl,
  sniffMedia,
  stripHtml,
  stripJpegMetadata,
} from '../../core/feed.js';
import { mp4Info } from '../../core/mp4.js';
import { LIMITS } from '../../core/model.js';

const fixture = (name) => readFile(new URL(`../../dev/fixtures/${name}`, import.meta.url));
const text = async (name) => String(await fixture(name));

// ---------------------------------------------------------------------------
// Text helpers

test('decodeEntities: named, decimal, hex; unknown and invalid references stay', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &lt;3 &quot;hi&quot; &apos;x&apos;'), 'Tom & Jerry <3 "hi" \'x\'');
  assert.equal(decodeEntities('&#8211; &#x2014; &#X41; &hellip; &eacute;'), '– — A … é');
  assert.equal(decodeEntities('&nosuch; &#xD800; &#0; & alone'), '&nosuch; &#xD800; &#0; & alone');
  assert.equal(decodeEntities(null), '');
});

test('stripHtml: drops scripts and tags, keeps paragraphs, no stray spaces around inline tags', () => {
  const html = '<p>Keep your <em>elbows</em> <strong>tucked</strong>.</p><script>alert(1)</script><style>p{}</style><p>Line one<br>line two &amp; more</p><!-- c --><ul><li>A</li><li>B</li></ul>';
  assert.equal(stripHtml(html), 'Keep your elbows tucked.\n\nLine one line two & more\n\nA\n\nB');
  assert.equal(stripHtml('<p>The post <a href="x">Hi</a> appeared first on <a href="y">Site</a>.</p><p>Body</p>'), 'Body');
  assert.equal(stripHtml('5 < 6 and 7 > 3'), '5 < 6 and 7 > 3');
});

test('stripHtml: unclosed comments, scripts and tags; one pass over hostile input', () => {
  assert.equal(stripHtml('<p>Before</p><!-- never closed <p>hidden</p>'), 'Before', 'an unclosed comment hides the rest, like in a browser');
  assert.equal(stripHtml('<p>A</p><script>if (a < b) x()</script><p>B</p>'), 'A\n\nB');
  assert.equal(stripHtml('Text <a href="x" never closed'), 'Text <a href="x" never closed', 'a tag without > is text');
  assert.equal(stripHtml('<svg viewBox="0 0 1 1"/>Icon text<br class="x">next'), 'Icon text next', 'a self-closed svg hides nothing; a line break in a paragraph is a space');
  assert.equal(stripHtml('one&nbsp;&nbsp;two \t three'), 'one two three');
  const t0 = performance.now();
  for (const hostile of ['<!--'.repeat(50000), '<a '.repeat(70000), '<script>'.repeat(25000), '<1'.repeat(100000) + '>', `a${' '.repeat(200000)}\nb`, '<img '.repeat(40000)]) stripHtml(hostile);
  assert.ok(performance.now() - t0 < 2000, `took ${Math.round(performance.now() - t0)} ms`);
});

test('clipText: word boundary with an ellipsis, untouched when short', () => {
  assert.equal(clipText('short', 10), 'short');
  const out = clipText('The quick brown fox jumps over the lazy dog', 20);
  assert.ok(out.length <= 20);
  assert.equal(out, 'The quick brown fox…');
});

test('URLs: resolve, http(s) only, kind and name from the path', () => {
  assert.equal(resolveUrl('img/a.jpg?x=1&amp;y=2', 'https://ex.com/blog/post/'), 'https://ex.com/blog/post/img/a.jpg?x=1&y=2');
  assert.equal(resolveUrl('//cdn.ex.com/a.jpg', 'https://ex.com/'), 'https://cdn.ex.com/a.jpg');
  assert.equal(resolveUrl('javascript:alert(1)', 'https://ex.com/'), '');
  assert.equal(resolveUrl('data:image/png;base64,AAAA'), '');
  assert.equal(resolveUrl('https://ok.example/a.jpg', 'not a url'), 'https://ok.example/a.jpg');
  assert.equal(isHttpUrl('https://ex.com/feed'), true);
  assert.equal(isHttpUrl('ftp://ex.com/feed'), false);
  assert.equal(isHttpUrl('ex.com/feed'), false);
  assert.equal(kindFromUrl('https://ex.com/a/photo.JPG?w=2'), 'image');
  assert.equal(kindFromUrl('https://ex.com/clip.mov'), 'video');
  assert.equal(kindFromUrl('https://ex.com/download?id=3'), null);
  assert.equal(nameFromUrl('https://ex.com/a/My%20Photo.jpg?x=1'), 'My Photo.jpg');
  assert.equal(nameFromUrl('https://www.ex.com/'), 'ex.com');
  assert.equal(nameFromUrl('not a url'), 'Linked file');
});

test('parseFeedDate: RFC 822, ISO 8601 with offsets, comments, garbage', () => {
  assert.equal(parseFeedDate('Sat, 10 Oct 2026 12:00:00 +0200'), '2026-10-10T10:00:00.000Z');
  assert.equal(parseFeedDate('2026-10-11T18:30:00+02:00'), '2026-10-11T16:30:00.000Z');
  assert.equal(parseFeedDate('Mon, 12 Oct 2026 10:00:00 +0200 (CEST)'), '2026-10-12T08:00:00.000Z');
  assert.equal(parseFeedDate('not a date'), null);
  assert.equal(parseFeedDate(''), null);
});

// ---------------------------------------------------------------------------
// XML scanner

test('parseXml: tolerant of stray end tags, unclosed elements, unquoted attributes and DOCTYPE subsets', () => {
  const { root } = parseXml('<!DOCTYPE x [ <!ENTITY a "b"> ]><a x=1 y=\'2\' z="&amp;"><b>one</b></c><b/>two<![CDATA[<raw>]]></a><d>open');
  const a = root.children[0];
  assert.equal(a.name, 'a');
  assert.deepEqual(a.attrs, { x: '1', y: '2', z: '&' });
  assert.equal(a.children.length, 2);
  assert.equal(a.children[0].text, 'one');
  assert.match(a.text + a.children.map((c) => c.text).join(''), /two<raw>/);
  assert.equal(root.children[1].name, 'd');
  assert.equal(root.children[1].text, 'open');
});

test('parseXml and parseFeed: deep nesting and many stray end tags neither throw nor take long', () => {
  const t0 = performance.now();
  const deep = parseFeed(`<rss><channel><title>T</title><item><title>${'<b>'.repeat(20000)}x</title><guid>1</guid></item></channel></rss>`);
  assert.equal(deep.items.length, 1);
  assert.equal(deep.items[0].guid, '1');
  assert.equal(deep.items[0].title, 'x');
  const stray = parseFeed(`<rss><channel><item><title>${'<b>'.repeat(300)}${'</x>'.repeat(100000)}y</title><guid>2</guid></item></channel></rss>`);
  assert.equal(stray.items.length, 1);
  const comments = parseFeed(`<rss><channel><item><title>a</title><guid>1</guid><description><![CDATA[${'<!--'.repeat(60000)}]]></description></item></channel></rss>`);
  assert.equal(comments.items[0].summary, '');
  assert.ok(performance.now() - t0 < 3000, `took ${Math.round(performance.now() - t0)} ms`);
});

test('parseXml: resolves namespace prefixes for elements', () => {
  const { root } = parseXml('<rss xmlns:m="http://search.yahoo.com/mrss/"><m:content url="u"/><content:encoded>x</content:encoded></rss>');
  const [m, c] = root.children[0].children;
  assert.equal(m.local, 'content');
  assert.equal(m.ns, 'http://search.yahoo.com/mrss/');
  assert.equal(c.prefix, 'content');
  assert.equal(c.ns, '');
});

// ---------------------------------------------------------------------------
// Feeds

test('parseFeed: WordPress-style RSS 2.0 with CDATA, entities and a non-standard Media RSS prefix', async () => {
  const feed = parseFeed(await text('feed-rss.xml'), { url: 'https://studionorth.example/feed/' });
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, 'Studio North – Journal');
  assert.equal(feed.link, 'https://studionorth.example/');
  assert.equal(feed.items.length, 6);
  const [glaze, kiln, workshop, video, note, bare] = feed.items;

  assert.equal(glaze.guid, 'https://studionorth.example/?p=412');
  assert.equal(glaze.title, 'Glaze day: ocean & sand');
  assert.equal(glaze.link, 'https://studionorth.example/2026/10/glaze-day/');
  assert.equal(glaze.published, '2026-10-12T08:30:00.000Z');
  // The widest media:content wins over the smaller rendition and the inline <img>.
  assert.equal(glaze.imageUrl, 'https://cdn.studionorth.example/glaze-large.jpg');
  // Description preferred over content:encoded; WordPress footer removed.
  assert.equal(glaze.summary, 'We mixed two new glazes this week — one deep ocean blue, one warm sand.\n\nThe read more link is below.');

  // Escaped HTML description, image only inside content:encoded (relative, &amp; in the URL).
  assert.equal(kiln.title, 'Kiln opening — 5 things we learned');
  assert.equal(kiln.summary, 'Every firing teaches us something. Here are five lessons & one mistake.');
  assert.equal(kiln.imageUrl, 'https://studionorth.example/2026/10/kiln-opening/kiln.jpg?w=1200&q=80');

  assert.equal(workshop.guid, 'workshops-nov-2026');
  assert.equal(workshop.imageUrl, 'https://cdn.studionorth.example/workshop.jpg');
  assert.equal(workshop.published, '2026-10-10T10:00:00.000Z');

  // media:group with a video: its thumbnail is the image.
  assert.equal(video.imageUrl, 'https://cdn.studionorth.example/wheel-poster.jpg');
  assert.equal(video.summary, '');

  assert.equal(note.imageUrl, '');
  assert.equal(note.guid, 'https://studionorth.example/2026/10/note/', 'link used when there is no guid');

  assert.equal(bare.title, '');
  assert.equal(bare.link, '');
  assert.equal(bare.published, null);
  assert.match(bare.guid, /^h:[0-9a-z]+$/, 'hash guid when nothing else identifies the item');
  assert.equal(parseFeed(await text('feed-rss.xml')).items[5].guid, bare.guid, 'stable across reads');
});

test('parseFeed: Atom with xml:base, XHTML content, html and text titles, enclosures and media thumbnails', async () => {
  const feed = parseFeed(await text('feed-atom.xml'), { url: 'https://blog.example.org/atom.xml' });
  assert.equal(feed.format, 'atom');
  assert.equal(feed.title, 'Clay & Fire');
  assert.equal(feed.link, 'https://blog.example.org/');
  const [cyl, firing, cat] = feed.items;
  assert.equal(cyl.guid, 'tag:blog.example.org,2026:tall-cylinders');
  assert.equal(cyl.link, 'https://blog.example.org/posts/tall-cylinders');
  assert.equal(cyl.summary, 'Keep your elbows tucked.');
  assert.equal(cyl.published, '2026-10-11T16:30:00.000Z', 'published wins over updated');
  assert.equal(cyl.imageUrl, 'https://blog.example.org/posts/images/cylinder.jpg', 'XHTML <img> resolved against the entry link');
  assert.equal(firing.title, 'Firing schedule <draft>', 'type="text" titles are never parsed as HTML');
  assert.equal(firing.imageUrl, 'https://img.example.org/firing.jpg');
  assert.equal(firing.published, '2026-10-10T07:00:00.000Z');
  assert.equal(cat.imageUrl, 'https://img.example.org/cat-thumb.jpg');
  assert.equal(cat.summary, 'Meet Pip.');
});

test('parseFeed: RSS 1.0 (RDF) items outside the channel, dc:date, single-quoted img', async () => {
  const feed = parseFeed(await text('feed-rdf.xml'));
  assert.equal(feed.format, 'rdf');
  assert.equal(feed.title, 'Maker News');
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0].guid, 'https://news.example.net/a');
  assert.equal(feed.items[0].summary, 'A short report.');
  assert.equal(feed.items[0].published, '2026-10-12T06:00:00.000Z');
  assert.equal(feed.items[0].imageUrl, 'https://news.example.net/img/kiln.jpg');
  assert.equal(feed.items[1].imageUrl, '');
});

test('parseFeed: web pages, empty and broken input give an error instead of throwing', () => {
  assert.match(parseFeed('<!doctype html><html><head><title>x</title></head><body></body></html>').error, /web page, not a feed/);
  assert.match(parseFeed('').error, /did not return an RSS or Atom feed/);
  assert.match(parseFeed('{"items": []}').error, /RSS or Atom/);
  const broken = parseFeed('<rss><channel><title>T</title><item><title>One<item><title>Two</title></item>');
  assert.equal(broken.format, 'rss');
  assert.ok(broken.items.length >= 1);
  assert.doesNotThrow(() => parseFeed('<rss><channel><item><description><![CDATA[never closed'));
  assert.doesNotThrow(() => parseFeed('<<<>>>&&&;;<rss <item'));
});

test('parseFeed: picks the post picture, not a thumbnail, avatar or emoji, and prefers a JPEG', () => {
  // Blogger: a 72 px media:thumbnail plus the full-size image in the content.
  const blogger = `<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:media='http://search.yahoo.com/mrss/'>
<title type='text'>My Blog</title><link rel='alternate' type='text/html' href='https://myblog.blogspot.com/'/>
<entry><id>tag:blogger.com,1999:blog-1.post-2</id><published>2026-10-01T10:00:00.000-07:00</published><title type='text'>New glaze</title>
<content type='html'>&lt;div&gt;&lt;a href="https://blogger.googleusercontent.com/img/b/R29v/s1600/glaze.jpg"&gt;&lt;img border="0" src="https://blogger.googleusercontent.com/img/b/R29v/s1600/glaze.jpg" width="640" height="480" /&gt;&lt;/a&gt;Text&lt;/div&gt;</content>
<link rel='alternate' type='text/html' href='https://myblog.blogspot.com/2026/10/new-glaze.html' title='New glaze'/>
<media:thumbnail xmlns:media='http://search.yahoo.com/mrss/' url='https://blogger.googleusercontent.com/img/b/R29v/s72-c/glaze.jpg' height='72' width='72'/></entry></feed>`;
  assert.equal(parseFeed(blogger).items[0].imageUrl, 'https://blogger.googleusercontent.com/img/b/R29v/s1600/glaze.jpg');
  // WordPress.com: the author's avatar is the first media:content.
  const wpcom = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Studio</title><link>https://studio.wordpress.com</link>
<item><title>Kiln day</title><link>https://studio.wordpress.com/2026/10/01/kiln-day/</link><guid isPermaLink="false">http://studio.wordpress.com/?p=12</guid>
<description><![CDATA[Kiln day text]]></description>
<content:encoded><![CDATA[<p><img src="https://s.w.org/images/core/emoji/15.0.3/72x72/1f525.png" class="wp-smiley" /><img src="https://studio.files.wordpress.com/2026/10/kiln.jpg?w=1024" /></p>]]></content:encoded>
<media:content url="https://0.gravatar.com/avatar/abc123?s=96&#38;d=identicon&#38;r=G" medium="image"><media:title type="html">potter</media:title></media:content>
<media:content url="https://studio.files.wordpress.com/2026/10/kiln.jpg" medium="image"><media:title type="html">kiln</media:title></media:content>
</item>
<item><title>Emoji first</title><guid>e1</guid><content:encoded><![CDATA[<img src="https://s.w.org/images/core/emoji/15.0.3/72x72/1f525.png" alt="🔥" class="wp-smiley" /><img loading="lazy" src="data:image/gif;base64,R0lGOD" data-src="https://studio.files.wordpress.com/lazy.jpg" />]]></content:encoded></item>
<item><title>PNG and JPEG</title><guid>p1</guid><enclosure url="https://cdn.example/chart.png" type="image/png" length="1"/><content:encoded><![CDATA[<img src="https://cdn.example/photo.jpg" />]]></content:encoded></item>
<item><title>Only a PNG</title><guid>p2</guid><media:content url="https://cdn.example/only" type="image/png"/></item>
</channel></rss>`;
  const [kiln, emoji, both, png] = parseFeed(wpcom).items;
  assert.equal(kiln.imageUrl, 'https://studio.files.wordpress.com/2026/10/kiln.jpg');
  assert.equal(kiln.imageFormat, '');
  assert.equal(emoji.imageUrl, 'https://studio.files.wordpress.com/lazy.jpg', 'emoji skipped, lazy-loaded data-src used');
  assert.equal(both.imageUrl, 'https://cdn.example/photo.jpg', 'a possible JPEG wins over a declared PNG');
  assert.equal(png.imageUrl, 'https://cdn.example/only');
  assert.equal(png.imageFormat, 'PNG', 'known not to be a JPEG');
});

test('nonJpegFormat, fitsFeed and downloadRetryAt', () => {
  assert.equal(nonJpegFormat('https://a.example/x.png'), 'PNG');
  assert.equal(nonJpegFormat('https://a.example/x.webp?w=1200'), 'WebP');
  assert.equal(nonJpegFormat('https://a.example/x.png', 'image/jpeg'), '', 'a declared type wins over the extension');
  assert.equal(nonJpegFormat('https://a.example/x', 'image/gif; charset=binary'), 'GIF');
  assert.equal(nonJpegFormat('https://a.example/photo.jpg'), '');
  assert.equal(nonJpegFormat('https://a.example/image'), '');
  assert.equal(fitsFeed(1080, 1350), true);
  assert.equal(fitsFeed(1200, 630), true, '1.905:1, the usual share-image size');
  assert.equal(fitsFeed(1080, 1920), false);
  assert.equal(fitsFeed(1200, 600), false);
  assert.equal(fitsFeed(0, 0), true, 'unknown size passes');
  assert.equal(downloadRetryAt({}), null);
  const at = Date.parse('2026-10-12T08:00:00Z');
  assert.equal(downloadRetryAt({ importAttempts: 1, importTriedAt: '2026-10-12T08:00:00Z' }), at + DOWNLOAD_RETRY_BASE_MS);
  assert.equal(downloadRetryAt({ importAttempts: 3, importTriedAt: '2026-10-12T08:00:00Z' }), at + 4 * DOWNLOAD_RETRY_BASE_MS);
});

test('newestFirst: sorts by date when every item has one, else keeps feed order', () => {
  const a = { guid: 'a', published: '2026-10-01T00:00:00Z' };
  const b = { guid: 'b', published: '2026-10-03T00:00:00Z' };
  const c = { guid: 'c', published: null };
  assert.deepEqual(newestFirst([a, b]).map((x) => x.guid), ['b', 'a']);
  assert.deepEqual(newestFirst([a, c, b]).map((x) => x.guid), ['a', 'c', 'b']);
});

test('ogImage: og:image in any attribute order, relative URLs, twitter and image_src fallbacks', async () => {
  const page = await text('page-og.html');
  assert.equal(ogImage(page, 'https://studionorth.example/2026/10/kiln-opening/'), 'https://studionorth.example/wp-content/uploads/2026/10/kiln-share.jpg?ver=2&crop=1');
  assert.equal(ogImage('<meta name="twitter:image" content="https://t.example/x.jpg">', 'https://a.example/'), 'https://t.example/x.jpg');
  assert.equal(ogImage("<link rel='image_src' href='/legacy.jpg'>", 'https://a.example/p'), 'https://a.example/legacy.jpg');
  assert.equal(ogImage('<meta property="og:image" content="javascript:alert(1)"><body><img src="/x.jpg">', 'https://a.example/'), '');
  assert.equal(ogImage('', 'https://a.example/'), '');
});

test('feedCaption: default template, {link}, and clipping the summary to the caption limit', () => {
  const item = { title: 'Glaze day', summary: 'Two new glazes.', link: 'https://ex.com/glaze' };
  assert.equal(feedCaption(item), 'Glaze day\n\nTwo new glazes.');
  assert.equal(feedCaption(item, '{title}\n\nRead more: {link}\n\n{summary}'), 'Glaze day\n\nRead more: https://ex.com/glaze\n\nTwo new glazes.');
  assert.equal(feedCaption({ title: 'Only a title', summary: '' }, FEED_TEMPLATE), 'Only a title');
  const long = feedCaption({ title: 'Long read', summary: 'word '.repeat(1000) }, FEED_TEMPLATE);
  assert.ok(long.length <= LIMITS.captionChars, `${long.length} chars`);
  assert.ok(long.startsWith('Long read\n\nword word'));
  assert.ok(long.endsWith('…'));
  const tiny = feedCaption({ title: 'x'.repeat(3000), summary: '' }, '{title}', 100);
  assert.ok(tiny.length <= 100);
});

// ---------------------------------------------------------------------------
// Downloaded bytes

/** A minimal JPEG: SOI, optional segments, SOF (frame), SOS, scan data, EOI. */
function jpeg({ width = 1080, height = 1350, orientation = null, sof = 0xc0, extra = [] } = {}) {
  const seg = (marker, body) => [0xff, marker, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const parts = [[0xff, 0xd8], seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])];
  if (orientation != null) {
    // Big-endian TIFF with one IFD entry: 0x0112 (orientation), SHORT, count 1, value.
    const tiff = [...ascii('MM'), 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    parts.push(seg(0xe1, [...ascii('Exif'), 0, 0, ...tiff, ...ascii('GPS 40.7128 N 74.0060 W')]));
  }
  parts.push(...extra);
  parts.push(seg(sof, [8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  parts.push(seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), [0x12, 0x34, 0xff, 0x00, 0x56], [0xff, 0xd9]);
  return new Uint8Array(parts.flat());
}

test('sniffMedia: JPEG, PNG, WebP, GIF, HEIC, AVIF, MP4, MOV, HTML and unknown bytes', async () => {
  const b = (...x) => new Uint8Array(x.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])));
  assert.equal(sniffMedia(jpeg()).format, 'jpeg');
  assert.equal(sniffMedia(b(0x89, 'PNG', 13, 10, 26, 10)).format, 'png');
  assert.equal(sniffMedia(b('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')).format, 'webp');
  assert.equal(sniffMedia(b('GIF89a', 1, 0)).format, 'gif');
  assert.equal(sniffMedia(b(0, 0, 0, 24, 'ftyp', 'heic', 0, 0)).format, 'heic');
  assert.equal(sniffMedia(b(0, 0, 0, 24, 'ftyp', 'avif', 0, 0)).format, 'avif');
  assert.deepEqual(sniffMedia(b(0, 0, 0, 24, 'ftyp', 'qt  ', 0, 0)), { format: 'mov', kind: 'video', mime: 'video/quicktime' });
  assert.deepEqual(sniffMedia(new Uint8Array(await fixture('clip.mp4'))), { format: 'mp4', kind: 'video', mime: 'video/mp4' });
  assert.equal(sniffMedia(b('\n  <!DOCTYPE html><html>')).format, 'html');
  assert.equal(sniffMedia(b('hello world')).format, null);
  assert.equal(sniffMedia(new Uint8Array(0)).format, null);
});

test('jpegInfo: size from the SOF marker, EXIF orientation swaps the displayed size', async () => {
  const real = jpegInfo(new Uint8Array(await fixture('f01.jpg')));
  assert.deepEqual(real, { width: 1080, height: 1350, orientation: 1, displayWidth: 1080, displayHeight: 1350 });
  assert.deepEqual(jpegInfo(jpeg({ width: 1200, height: 900, sof: 0xc2 })), { width: 1200, height: 900, orientation: 1, displayWidth: 1200, displayHeight: 900 });
  const turned = jpegInfo(jpeg({ width: 1600, height: 1200, orientation: 6 }));
  assert.equal(turned.orientation, 6);
  assert.equal(turned.displayWidth, 1200);
  assert.equal(turned.displayHeight, 1600);
  assert.equal(jpegInfo(jpeg({ orientation: 1 })).orientation, 1);
  assert.equal(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(jpegInfo(jpeg().slice(0, 30)), null, 'truncated before the frame header');
});

test('stripJpegMetadata: removes EXIF (with GPS), IPTC and comments, keeps JFIF, ICC and the image', () => {
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const icc = [0xff, 0xe2, 0, 7, ...ascii('ICC_P')];
  const iptc = [0xff, 0xed, 0, 6, 1, 2, 3, 4];
  const comment = [0xff, 0xfe, 0, 7, ...ascii('hello')];
  const src = jpeg({ width: 800, height: 1000, orientation: 1, extra: [icc, iptc, comment] });
  const out = stripJpegMetadata(src);
  const s = String.fromCharCode(...out);
  assert.ok(String.fromCharCode(...src).includes('GPS 40.7128'));
  assert.ok(!s.includes('GPS') && !s.includes('Exif') && !s.includes('hello'));
  assert.ok(s.includes('JFIF') && s.includes('ICC'));
  assert.deepEqual([...out.subarray(-7)], [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9], 'scan data untouched');
  assert.equal(jpegInfo(out).width, 800);
  const clean = jpeg();
  assert.equal(stripJpegMetadata(clean), clean, 'nothing to strip: same bytes');
  const notJpeg = new Uint8Array([1, 2, 3, 4]);
  assert.equal(stripJpegMetadata(notJpeg), notJpeg);
});

/** MP4 boxes for mp4Info tests. */
function box(type, ...children) {
  const body = children.length ? Buffer.concat(children.map((c) => Buffer.from(c))) : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function tkhd(width, height, rotate = false) {
  const b = Buffer.alloc(84);
  const matrix = rotate ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  matrix.forEach((v, i) => b.writeInt32BE(v, 40 + i * 4));
  b.writeUInt32BE(width * 65536, 76);
  b.writeUInt32BE(height * 65536, 80);
  return box('tkhd', b);
}

function mvhd(timescale, duration) {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(timescale, 12);
  b.writeUInt32BE(duration, 16);
  return box('mvhd', b);
}

const hdlr = (type) => box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(type, 'latin1'), Buffer.alloc(12)]));

test('mp4Info: duration from mvhd, size from the video track, rotation swaps width and height', async () => {
  assert.deepEqual(mp4Info(new Uint8Array(await fixture('clip.mp4'))), { width: 720, height: 1280, durationSec: 5 });
  const file = (rotate) =>
    new Uint8Array(
      Buffer.concat([
        box('ftyp', Buffer.from('isom0000')),
        box('moov', mvhd(1000, 12500), box('trak', tkhd(0, 0), box('mdia', hdlr('soun'))), box('trak', tkhd(1920, 1080, rotate), box('mdia', hdlr('vide')))),
        box('mdat', Buffer.alloc(16)),
      ]),
    );
  assert.deepEqual(mp4Info(file(false)), { width: 1920, height: 1080, durationSec: 12.5 });
  assert.deepEqual(mp4Info(file(true)), { width: 1080, height: 1920, durationSec: 12.5 });
  assert.deepEqual(mp4Info(new Uint8Array([1, 2, 3])), { width: null, height: null, durationSec: null });
  assert.deepEqual(mp4Info(new Uint8Array(box('ftyp', Buffer.from('isom0000')))), { width: null, height: null, durationSec: null });
});
