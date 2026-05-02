export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('u');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing "u" parameter' }), {
      status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  try {
    const fetchUrl = targetUrl;
    const baseUrl = fetchUrl.substring(0, fetchUrl.lastIndexOf('/') + 1);

    const originResponse = await fetch(fetchUrl, {
      method: request.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.icc-cricket.com',
        'Referer': 'https://www.icc-cricket.com/',
      },
      redirect: 'follow',
    });

    let contentType = originResponse.headers.get('Content-Type') || 'application/octet-stream';
    let body = await originResponse.arrayBuffer();

    const isM3U8 = fetchUrl.includes('.m3u8') || contentType.includes('mpegurl');
    const isMPD = fetchUrl.includes('.mpd') || contentType.includes('dash+xml');

    if (isM3U8) {
      const text = new TextDecoder().decode(body);
      const proxyBase = url.origin + url.pathname;
      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (m, uri) => {
              const abs = uri.startsWith('http') ? uri : baseUrl + uri;
              return `URI="${proxyBase}?u=${encodeURIComponent(abs)}"`;
            });
          }
          return line;
        }
        const abs = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
        return `${proxyBase}?u=${encodeURIComponent(abs)}`;
      }).join('\n');
      body = new TextEncoder().encode(rewritten);
      contentType = 'application/vnd.apple.mpegurl';

    } else if (isMPD) {
      let text = new TextDecoder().decode(body);

      // Inject BaseURL for correct segment URL resolution
      if (!text.includes('<BaseURL>')) {
        text = text.replace(/<Period\b([^>]*)>/, `<Period$1>\n        <BaseURL>${baseUrl}</BaseURL>`);
      }

      // Strip Widevine and PlayReady ContentProtection to force ClearKey
      text = text.replace(/<ContentProtection\s+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(/<ContentProtection\s+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*\/>/g, '');
      text = text.replace(/<ContentProtection\s+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(/<ContentProtection\s+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*\/>/g, '');

      body = new TextEncoder().encode(text);
      contentType = 'application/dash+xml';
    }

    return new Response(body, {
      status: originResponse.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy error', details: err.message }), {
      status: 502, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}
