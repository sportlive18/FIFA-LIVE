// functions/api/proxy.js — Cloudflare Pages Function
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const targetUrl = url.searchParams.get('u');
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing "u" parameter' }), {
      status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
  return handleProxy(targetUrl, url);
}

// ── Stream Proxy ───────────────────────────────────────────────────────────
async function handleProxy(targetUrl, requestUrl) {
  try {
    // Parse caller-supplied headers
    const extraHeaders = {};
    const rawH = requestUrl.searchParams.get('headers');
    if (rawH) {
      try {
        JSON.parse(decodeURIComponent(rawH)).forEach(h => {
          const i = h.indexOf(': ');
          if (i > -1) extraHeaders[h.slice(0,i)] = h.slice(i+2);
        });
      } catch(_) {}
    }

    const fetchHeaders = {
      'User-Agent': extraHeaders['User-Agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
      'Referer':    extraHeaders['Referer'] || 'https://www.icc-cricket.com/',
      'Origin':     extraHeaders['Origin']  || 'https://www.icc-cricket.com',
      'Accept':     '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    // Forward other common headers if present in extraHeaders
    ['Authorization', 'Cookie', 'X-Forwarded-For'].forEach(h => {
      if (extraHeaders[h]) fetchHeaders[h] = extraHeaders[h];
    });

    const originResp = await fetch(targetUrl, { 
      method: 'GET', 
      headers: fetchHeaders, 
      redirect: 'follow' 
    });

    let contentType = originResp.headers.get('Content-Type') || 'application/octet-stream';
    let body = await originResp.arrayBuffer();

    const isMPD  = targetUrl.includes('.mpd')  || contentType.includes('dash+xml') || contentType.includes('application/xml');
    const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl');

    if (isMPD) {
      let text = new TextDecoder().decode(body);

      // ── Rewrite all URLs inside MPD to go through this proxy ──────
      const proxyBase = requestUrl.origin + requestUrl.pathname;
      const hParam = requestUrl.searchParams.get('headers')
        ? '&headers=' + requestUrl.searchParams.get('headers')
        : '';

      function proxyUrl(u) {
        if (!u || u.startsWith('data:')) return u;
        return proxyBase + '?u=' + encodeURIComponent(u) + hParam;
      }

      const mpdBase = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      function toAbsolute(u) {
        if (!u) return u;
        if (u.startsWith('http')) return u;
        return mpdBase + u;
      }

      // 1. Rewrite <BaseURL> elements
      text = text.replace(/<BaseURL>([^<]*)<\/BaseURL>/g, (_, inner) => {
        const abs = toAbsolute(inner.trim());
        return `<BaseURL>${proxyUrl(abs)}</BaseURL>`;
      });

      // 2. If NO BaseURL exists at all, inject one at Period level
      if (!text.includes('<BaseURL>')) {
        const proxiedBase = proxyUrl(mpdBase);
        text = text.replace(/<Period\b([^>]*)>/g, `<Period$1>\n    <BaseURL>${proxiedBase}</BaseURL>`);
      }

      // 3. Rewrite initialization / media template absolute URLs in SegmentTemplate
      text = text.replace(/\b(initialization|media)="(https?:\/\/[^"]+)"/g, (_, attr, u) => {
        return `${attr}="${proxyUrl(u)}"`;
      });

      // 4. Remove Widevine + PlayReady (keep ClearKey)
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*\/>/g, '');
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*\/>/g, '');

      body = new TextEncoder().encode(text);
      contentType = 'application/dash+xml';

    } else if (isM3U8) {
      const text    = new TextDecoder().decode(body);
      const mpdBase = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const proxyBase = requestUrl.origin + requestUrl.pathname;
      const hParam  = requestUrl.searchParams.get('headers')
        ? '&headers=' + requestUrl.searchParams.get('headers') : '';

      const rewritten = text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) {
          if (t.includes('URI="')) {
            return t.replace(/URI="([^"]+)"/g, (_, u) => {
              const abs = u.startsWith('http') ? u : mpdBase + u;
              return `URI="${proxyBase}?u=${encodeURIComponent(abs)}${hParam}"`;
            });
          }
          return line;
        }
        const abs = t.startsWith('http') ? t : mpdBase + t;
        return `${proxyBase}?u=${encodeURIComponent(abs)}${hParam}`;
      }).join('\n');

      body = new TextEncoder().encode(rewritten);
      contentType = 'application/vnd.apple.mpegurl';
    }

    return new Response(body, {
      status: originResp.status,
      headers: { ...corsHeaders(), 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store' },
    });

  } catch(err) {
    return new Response(JSON.stringify({ error: 'Proxy error', details: err.message }), {
      status: 502, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers':  '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age':        '86400',
  };
}
