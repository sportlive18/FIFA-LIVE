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
    // Decode the target URL
    const decodedUrl = decodeURIComponent(targetUrl);

    // Fetch from origin with ICC-specific headers
    const originResponse = await fetch(decodedUrl, {
      method: request.method,
      headers: {
        'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.icc-cricket.com',
        'Referer': 'https://www.icc-cricket.com/',
      },
      redirect: 'follow',
    });

    // Get response body
    const contentType = originResponse.headers.get('Content-Type') || 'application/octet-stream';
    let body = await originResponse.arrayBuffer();

    // For HLS/DASH manifests, rewrite URLs to also go through proxy
    const isM3U8 = decodedUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');
    const isMPD = decodedUrl.includes('.mpd') || contentType.includes('dash+xml');

    if (isM3U8 || isMPD) {
      const text = new TextDecoder().decode(body);
      const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);
      const proxyBase = url.origin + url.pathname;

      let rewritten = "";

      if (isM3U8) {
        rewritten = text.split('\n').map(line => {
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
          const absoluteUrl = baseUrl + trimmed;
          return `${proxyBase}?u=${encodeURIComponent(absoluteUrl)}`;
        }).join('\n');
      } else if (isMPD) {
        // Simple regex based rewrite for DASH BaseURLs and common patterns
        // More robust would be XML parsing, but this is usually enough for proxying
        rewritten = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, content) => {
          const absoluteUrl = content.startsWith('http') ? content : baseUrl + content;
          return `<BaseURL>${proxyBase}?u=${encodeURIComponent(absoluteUrl)}</BaseURL>`;
        });
        
        // Also catch URLs in attributes like 'media', 'initialization'
        rewritten = rewritten.replace(/(media|initialization|sourceURL)="([^"]+)"/g, (match, attr, val) => {
          if (val.startsWith('http')) {
            return `${attr}="${proxyBase}?u=${encodeURIComponent(val)}"`;
          }
          // If it's a relative URL, we might need a BaseURL rewrite instead, 
          // but if no BaseURL is present, we should prepend baseUrl.
          // However, DASH often uses segment templates which shouldn't be fully proxied here if they contain variables like $Number$.
          // Let's stick to BaseURL rewriting for now as it's cleaner for DASH.
          return match;
        });
      }

      body = new TextEncoder().encode(rewritten || text);
    }

    // Build response
    const responseHeaders = {
      ...corsHeaders(),
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    // Preserve content length for segments
    if (!decodedUrl.includes('.m3u8') && !contentType.includes('mpegurl')) {
      responseHeaders['Content-Length'] = body.byteLength.toString();
    }

    return new Response(body, {
      status: originResponse.status,
      headers: responseHeaders,
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy fetch failed', details: err.message }), {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
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
