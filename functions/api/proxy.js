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
    const extraHeaders = {};
    const rawH = requestUrl.searchParams.get('headers');
    if (rawH) {
      try {
        const parsed = JSON.parse(rawH);
        if (Array.isArray(parsed)) {
          parsed.forEach(h => {
            const i = h.indexOf(': ');
            if (i > -1) extraHeaders[h.slice(0,i).toLowerCase()] = h.slice(i+2);
          });
        }
      } catch(_) {}
    }

    const fetchHeaders = {
      'User-Agent': extraHeaders['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
      'Referer':    extraHeaders['referer'] || 'https://www.plus.fifa.com/',
      'Origin':     extraHeaders['origin']  || 'https://www.plus.fifa.com',
      'Accept':     '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    const originResp = await fetch(targetUrl, { 
      method: 'GET', 
      headers: fetchHeaders, 
      redirect: 'follow' 
    });

    let contentType = originResp.headers.get('Content-Type') || '';
    let body = await originResp.arrayBuffer();

    const isMPD  = targetUrl.includes('.mpd')  || contentType.includes('dash+xml') || contentType.includes('application/xml');
    const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl');

    if (isMPD) {
      let text = new TextDecoder().decode(body);
      const proxyBase = requestUrl.origin + requestUrl.pathname;
      const hParam = requestUrl.searchParams.get('headers') ? '&headers=' + encodeURIComponent(requestUrl.searchParams.get('headers')) : '';

      function proxyUrl(u) {
        if (!u || u.startsWith('data:') || u.startsWith('blob:')) return u;
        try {
          const abs = new URL(u, targetUrl).href;
          return proxyBase + '?u=' + encodeURIComponent(abs) + hParam;
        } catch(e) { return u; }
      }

      // 1. Rewrite <BaseURL>
      text = text.replace(/<BaseURL>([^<]*)<\/BaseURL>/g, (_, inner) => {
        return `<BaseURL>${proxyUrl(inner.trim())}</BaseURL>`;
      });

      // 2. Period Level BaseURL injection if missing
      if (!text.includes('<BaseURL>')) {
        const baseDir = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        text = text.replace(/<Period\b([^>]*)>/g, `<Period$1>\n    <BaseURL>${proxyUrl(baseDir)}</BaseURL>`);
      }

      // 3. Absolute URLs in templates
      text = text.replace(/\b(initialization|media)="(https?:\/\/[^"]+)"/g, (_, attr, u) => {
        return `${attr}="${proxyUrl(u)}"`;
      });

      // 4. Remove DRM other than ClearKey
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*\/>/g, '');
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(/<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*\/>/g, '');

      body = new TextEncoder().encode(text);
      contentType = 'application/dash+xml';

    } else if (isM3U8) {
      const text = new TextDecoder().decode(body);
      const proxyBase = requestUrl.origin + requestUrl.pathname;
      const hParam = requestUrl.searchParams.get('headers') ? '&headers=' + encodeURIComponent(requestUrl.searchParams.get('headers')) : '';

      const rewritten = text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) {
          if (t.includes('URI="')) {
            return t.replace(/URI="([^"]+)"/g, (_, u) => {
              try {
                const abs = new URL(u, targetUrl).href;
                return `URI="${proxyBase}?u=${encodeURIComponent(abs)}${hParam}"`;
              } catch(e) { return _; }
            });
          }
          return line;
        }
        try {
          const abs = new URL(t, targetUrl).href;
          return `${proxyBase}?u=${encodeURIComponent(abs)}${hParam}`;
        } catch(e) { return line; }
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
