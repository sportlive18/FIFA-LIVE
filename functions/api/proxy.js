// functions/api/proxy.js
// Cloudflare Pages Function — place this file at:
//   /functions/api/proxy.js
// It will be served at /api/proxy on your Pages site.

export async function onRequest(context) {
  const { request } = context;

  // ── CORS preflight ──────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('u');

  if (!target) {
    return cors(json({ error: 'Missing "u" parameter' }, 400));
  }

  // Validate target is a real URL
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return cors(json({ error: 'Invalid target URL' }, 400));
  }

  // Block requests back to ourselves (loop prevention)
  if (targetUrl.hostname === reqUrl.hostname) {
    return cors(json({ error: 'Loop detected' }, 400));
  }

  return proxy(targetUrl.href, reqUrl);
}

// ── Core proxy ──────────────────────────────────────────────────────────────
async function proxy(targetUrl, reqUrl) {
  const fetchHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer':         'https://www.plus.fifa.com/',
    'Origin':          'https://www.plus.fifa.com',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  let originResp;
  try {
    originResp = await fetch(targetUrl, {
      method:   'GET',
      headers:  fetchHeaders,
      redirect: 'follow',
    });
  } catch (err) {
    return cors(json({ error: 'Fetch failed', detail: err.message }, 502));
  }

  if (!originResp.ok && originResp.status !== 206) {
    // Pass through non-2xx (segment servers sometimes return 206)
    return cors(new Response(null, { status: originResp.status }));
  }

  let contentType = originResp.headers.get('Content-Type') || '';
  const bodyBuf   = await originResp.arrayBuffer();

  const isMPD  = targetUrl.includes('.mpd')  || contentType.includes('dash+xml') || contentType.includes('application/xml');
  const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl');

  // ── Rewrite MPD manifest ──────────────────────────────────────────────
  if (isMPD) {
    let text = new TextDecoder().decode(bodyBuf);

    const proxyBase = reqUrl.origin + reqUrl.pathname; // /api/proxy

    function p(u) {
      if (!u || u.startsWith('data:') || u.startsWith('blob:')) return u;
      try {
        const abs = new URL(u, targetUrl).href;
        return proxyBase + '?u=' + encodeURIComponent(abs);
      } catch { return u; }
    }

    // 1. Rewrite explicit <BaseURL> elements
    text = text.replace(/<BaseURL>([^<]*)<\/BaseURL>/g, (_, inner) =>
      `<BaseURL>${p(inner.trim())}</BaseURL>`
    );

    // 2. If no BaseURL found, inject one at Period level using the manifest's directory
    if (!text.includes('<BaseURL>')) {
      const dir = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      text = text.replace(
        /<Period(\b[^>]*)>/g,
        (_, attrs) => `<Period${attrs}>\n    <BaseURL>${p(dir)}</BaseURL>`
      );
    }

    // 3. Rewrite absolute URLs in SegmentTemplate / SegmentList attributes
    text = text.replace(
      /\b(initialization|media|sourceURL)="(https?:\/\/[^"]+)"/g,
      (_, attr, u) => `${attr}="${p(u)}"`
    );

    // 4. Remove Widevine and PlayReady ContentProtection — keep ClearKey only
    //    (Shaka will handle ClearKey itself; removing these stops it trying EME)
    text = text.replace(
      /<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*>[\s\S]*?<\/ContentProtection>/gi, ''
    );
    text = text.replace(
      /<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*\/>/gi, ''
    );
    text = text.replace(
      /<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[^>]*>[\s\S]*?<\/ContentProtection>/gi, ''
    );
    text = text.replace(
      /<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[^>]*\/>/gi, ''
    );

    return cors(new Response(text, {
      status: 200,
      headers: {
        'Content-Type':  'application/dash+xml; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    }));
  }

  // ── Rewrite HLS manifest ──────────────────────────────────────────────
  if (isM3U8) {
    const text     = new TextDecoder().decode(bodyBuf);
    const proxyBase = reqUrl.origin + reqUrl.pathname;

    const rewritten = text.split('\n').map(line => {
      const t = line.trim();
      if (!t) return line;

      // Rewrite URI= in tags (e.g. EXT-X-KEY)
      if (t.startsWith('#') && t.includes('URI="')) {
        return t.replace(/URI="([^"]+)"/g, (_, u) => {
          try {
            const abs = new URL(u, targetUrl).href;
            return `URI="${proxyBase}?u=${encodeURIComponent(abs)}"`;
          } catch { return _; }
        });
      }

      if (t.startsWith('#')) return line;

      // Segment URL
      try {
        const abs = new URL(t, targetUrl).href;
        return proxyBase + '?u=' + encodeURIComponent(abs);
      } catch { return line; }
    }).join('\n');

    return cors(new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type':  'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    }));
  }

  // ── Binary passthrough (segments, keys, etc.) ─────────────────────────
  return cors(new Response(bodyBuf, {
    status:  originResp.status,
    headers: {
      'Content-Type':  contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=10',
    },
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin',   '*');
  headers.set('Access-Control-Allow-Methods',  'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers',  '*');
  headers.set('Access-Control-Expose-Headers', '*');
  return new Response(response.body, { status: response.status, headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
