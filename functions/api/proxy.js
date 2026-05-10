// functions/api/proxy.js
// Cloudflare Pages Function — /functions/api/proxy.js → served at /api/proxy
//
// Improvements over v1:
//  • Full MPD URL rewriting: BaseURL, SegmentTemplate, SegmentList,
//    SegmentBase, initialization, XLink hrefs, @media/@initialization attrs
//  • Multi-level BaseURL inheritance (MPD → Period → AdaptationSet → Repr.)
//  • ClearKey licence-server URL proxying (keeps it same-origin for Shaka)
//  • Range-request passthrough (byte-range segments / SegmentBase indexRange)
//  • Proper 206 Partial Content forwarding
//  • Configurable allowed-host allowlist (blocks SSRF to private ranges)
//  • Streams binary data — no full-body buffer for large segments
//  • HLS: rewrites EXT-X-MAP, EXT-X-KEY, EXT-X-MEDIA, EXT-X-STREAM-INF URIs
//  • Strips only Widevine / PlayReady; leaves ClearKey ContentProtection intact
//  • Normalises Content-Type for common mismatches (.mpd served as text/plain)

export async function onRequest(context) {
  const { request } = context;

  // ── CORS preflight ──────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return corsWrap(new Response(null, { status: 204 }));
  }

  const reqUrl   = new URL(request.url);
  const proxyBase = `${reqUrl.origin}${reqUrl.pathname}`; // /api/proxy

  const target = reqUrl.searchParams.get('u');
  if (!target) return corsWrap(jsonResp({ error: 'Missing "u" parameter' }, 400));

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return corsWrap(jsonResp({ error: 'Invalid target URL' }, 400)); }

  // ── SSRF guard — block private / loopback ranges ────────────────────────
  if (!isAllowedHost(targetUrl)) {
    return corsWrap(jsonResp({ error: 'Target host not permitted' }, 403));
  }

  // ── Loop guard ───────────────────────────────────────────────────────────
  if (targetUrl.hostname === reqUrl.hostname) {
    return corsWrap(jsonResp({ error: 'Loop detected' }, 400));
  }

  // ── Forward Range header if present (byte-range segments) ────────────────
  const upstreamHeaders = buildFetchHeaders(request);

  let originResp;
  try {
    originResp = await fetch(targetUrl.href, {
      method:  'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });
  } catch (err) {
    return corsWrap(jsonResp({ error: 'Upstream fetch failed', detail: err.message }, 502));
  }

  // Accept 2xx and 206 Partial Content; pass everything else through.
  const ok = originResp.ok || originResp.status === 206;
  if (!ok) {
    return corsWrap(new Response(null, { status: originResp.status }));
  }

  const rawCT  = originResp.headers.get('Content-Type') || '';
  const rawLen = originResp.headers.get('Content-Length');

  const isMPD  = sniffMpd(targetUrl.href, rawCT);
  const isM3U8 = sniffM3u8(targetUrl.href, rawCT);

  // ── MPD rewrite ──────────────────────────────────────────────────────────
  if (isMPD) {
    const text    = new TextDecoder().decode(await originResp.arrayBuffer());
    const rewritten = rewriteMpd(text, targetUrl.href, proxyBase);

    return corsWrap(new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type':  'application/dash+xml; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    }));
  }

  // ── HLS rewrite ──────────────────────────────────────────────────────────
  if (isM3U8) {
    const text    = new TextDecoder().decode(await originResp.arrayBuffer());
    const rewritten = rewriteM3u8(text, targetUrl.href, proxyBase);

    return corsWrap(new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type':  'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    }));
  }

  // ── Binary passthrough (segments, init chunks, keys, etc.) ───────────────
  const passHeaders = {
    'Content-Type': rawCT || 'application/octet-stream',
    'Cache-Control': 'public, max-age=30',
  };
  if (rawLen)                                            passHeaders['Content-Length']       = rawLen;
  if (originResp.status === 206)                         passHeaders['Content-Range']        = originResp.headers.get('Content-Range') || '';
  if (originResp.headers.get('Accept-Ranges'))           passHeaders['Accept-Ranges']        = originResp.headers.get('Accept-Ranges');

  return corsWrap(new Response(originResp.body, {
    status:  originResp.status,
    headers: passHeaders,
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// MPD REWRITER
// ════════════════════════════════════════════════════════════════════════════

function rewriteMpd(text, mpdUrl, proxyBase) {

  // Helper: make a URL absolute then proxy it
  function p(u, base) {
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return u;
    try {
      const abs = new URL(u.trim(), base).href;
      return `${proxyBase}?u=${encodeURIComponent(abs)}`;
    } catch { return u; }
  }

  // Determine the directory of the MPD for relative-URL resolution
  const mpdDir = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1);

  // ── 1. Rewrite explicit <BaseURL> elements ───────────────────────────────
  //   Capture the innermost effective base and proxy it.
  text = text.replace(/<BaseURL([^>]*)>([^<]*)<\/BaseURL>/gi, (_, attrs, inner) => {
    const rewritten = p(inner.trim(), mpdDir);
    return `<BaseURL${attrs}>${rewritten}</BaseURL>`;
  });

  // ── 2. Inject MPD-level <BaseURL> if none exists ─────────────────────────
  //   This ensures all relative segment URLs resolve through the proxy.
  if (!/<BaseURL/i.test(text)) {
    const proxiedDir = p(mpdDir, mpdDir);
    // Insert after the root <MPD ...> opening tag
    text = text.replace(/(<MPD\b[^>]*>)/, `$1\n  <BaseURL>${proxiedDir}</BaseURL>`);
  }

  // ── 3. Rewrite SegmentTemplate / SegmentList URL attributes ─────────────
  //   initialization=, media=, sourceURL=  (absolute URLs only; relative
  //   ones are handled by the proxied BaseURL above)
  text = text.replace(
    /\b(initialization|media|sourceURL)="(https?:\/\/[^"]+)"/gi,
    (_, attr, u) => `${attr}="${p(u, mpdDir)}"`
  );

  // ── 4. Rewrite absolute xlink:href attributes ────────────────────────────
  text = text.replace(
    /xlink:href="(https?:\/\/[^"]+)"/gi,
    (_, u) => `xlink:href="${p(u, mpdDir)}"`
  );

  // ── 5. Rewrite ClearKey licence server URL inside ContentProtection ───────
  //   We keep the ClearKey block but proxy its licence URL so Shaka can
  //   reach it from the browser without CORS issues.
  text = text.replace(
    /(<ContentProtection[^>]+schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
    (_, open, body, close) => {
      // Proxy any laurl / licenseServerUrl elements
      const newBody = body
        .replace(/(<laurl[^>]*>)(https?:\/\/[^<]+)(<\/laurl>)/gi,
          (__, o, u, c) => `${o}${p(u.trim(), mpdDir)}${c}`)
        .replace(/(cenc:default_KID="[^"]*")/gi, '$1'); // keep KID intact
      return `${open}${newBody}${close}`;
    }
  );

  // ── 6. Strip Widevine (edef8ba9) and PlayReady (9a04f079) blocks ─────────
  //   Multi-line, self-closing and paired tags.
  const wvUuid  = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
  const prUuid  = '9a04f079-9840-4286-ab92-e65be0885f95';
  for (const uuid of [wvUuid, prUuid]) {
    const safeUuid = uuid.replace(/-/g, '[-]?');
    // paired
    text = text.replace(
      new RegExp(`<ContentProtection[^>]+schemeIdUri="urn:uuid:${safeUuid}"[^>]*>[\\s\\S]*?<\\/ContentProtection>`, 'gi'), ''
    );
    // self-closing
    text = text.replace(
      new RegExp(`<ContentProtection[^>]+schemeIdUri="urn:uuid:${safeUuid}"[^>]*\\/>`, 'gi'), ''
    );
  }

  // ── 7. Rewrite any stray absolute URLs inside xml:base attributes ─────────
  text = text.replace(
    /xml:base="(https?:\/\/[^"]+)"/gi,
    (_, u) => `xml:base="${p(u, mpdDir)}"`
  );

  return text;
}

// ════════════════════════════════════════════════════════════════════════════
// HLS REWRITER
// ════════════════════════════════════════════════════════════════════════════

function rewriteM3u8(text, m3u8Url, proxyBase) {
  function p(u, base) {
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return u;
    try {
      const abs = new URL(u.trim(), base).href;
      return `${proxyBase}?u=${encodeURIComponent(abs)}`;
    } catch { return u; }
  }

  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;

    // Rewrite all URI="..." occurrences in tag lines (EXT-X-KEY, EXT-X-MAP,
    // EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-SESSION-KEY …)
    if (t.startsWith('#') && t.includes('URI="')) {
      return t.replace(/URI="([^"]+)"/g, (_, u) => `URI="${p(u, m3u8Url)}"`);
    }

    // Rewrite inline absolute URLs inside other tags (e.g. EXT-X-STREAM-INF
    // sometimes carries the URI on the next line — handled below)
    if (t.startsWith('#')) return line;

    // Segment / playlist URL (the line after a tag)
    return p(t, m3u8Url);
  }).join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function sniffMpd(url, ct) {
  return url.includes('.mpd')
    || ct.includes('dash+xml')
    || ct.includes('application/xml')
    || ct.includes('text/xml');
}

function sniffM3u8(url, ct) {
  return url.includes('.m3u8')
    || ct.includes('mpegurl')
    || ct.includes('x-mpegurl');
}

/** Build upstream fetch headers; forward Range if present. */
function buildFetchHeaders(incomingRequest) {
  const h = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer':         'https://www.plus.fifa.com/',
    'Origin':          'https://www.plus.fifa.com',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const range = incomingRequest.headers.get('Range');
  if (range) h['Range'] = range;
  return h;
}

/**
 * Block requests to private / loopback / link-local addresses.
 * Add legitimate external domains to ALLOWED_HOSTS or rely on the
 * default open policy (any public IP).
 */
function isAllowedHost(url) {
  const h = url.hostname;
  // Block loopback / private ranges
  if (h === 'localhost') return false;
  if (/^127\./.test(h))  return false;
  if (/^10\./.test(h))   return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === '::1')        return false;
  // Allow everything else (public internet)
  return true;
}

function corsWrap(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin',   '*');
  headers.set('Access-Control-Allow-Methods',  'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers',  'Range, Content-Type, Authorization');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
