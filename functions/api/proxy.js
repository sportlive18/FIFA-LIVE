export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('u');

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing "u" query parameter' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  try {
    const decodedUrl = decodeURIComponent(targetUrl);
    const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);

    // Fetch from origin with ICC headers
    const originResponse = await fetch(decodedUrl, {
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

    // Detect manifest types
    const isM3U8 = decodedUrl.includes('.m3u8') || contentType.includes('mpegurl');
    const isMPD = decodedUrl.includes('.mpd') || contentType.includes('dash+xml');

    if (isM3U8) {
      // HLS: rewrite all URLs to go through proxy
      const text = new TextDecoder().decode(body);
      const proxyBase = url.origin + url.pathname;

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
              const absoluteUri = uri.startsWith('http') ? uri : baseUrl + uri;
              return `URI="${proxyBase}?u=${encodeURIComponent(absoluteUri)}"`;
            });
          }
          return line;
        }
        if (trimmed.startsWith('http')) {
          return `${proxyBase}?u=${encodeURIComponent(trimmed)}`;
        }
        return `${proxyBase}?u=${encodeURIComponent(baseUrl + trimmed)}`;
      }).join('\n');

      body = new TextEncoder().encode(rewritten);
      contentType = 'application/vnd.apple.mpegurl';

    } else if (isMPD) {
      // DASH: Inject <BaseURL> so Shaka resolves relative segment URLs
      // against the original CDN path, NOT the proxy path
      let text = new TextDecoder().decode(body);

      // Only inject BaseURL if one doesn't already exist at the top level
      if (!text.includes('<BaseURL>')) {
        // Insert BaseURL right after the first <Period tag
        text = text.replace(/<Period\b([^>]*)>/, `<Period$1>\n        <BaseURL>${escapeXml(baseUrl)}</BaseURL>`);
      }

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
    return new Response(JSON.stringify({ error: 'Proxy fetch failed', details: err.message }), {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
