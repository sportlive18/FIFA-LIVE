// functions/api/proxy.js  — Cloudflare Pages Function
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ─── /api/m3u  ── generate M3U from icc.json ───────────────────────────────
  if (url.pathname.endsWith('/m3u')) {
    return handleM3U(url);
  }

  // ─── /api/proxy?u=<url> ── stream proxy ────────────────────────────────────
  const targetUrl = url.searchParams.get('u');
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing "u" parameter' }), {
      status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  return handleProxy(targetUrl, url);
}

// ── M3U Generator ─────────────────────────────────────────────────────────────
async function handleM3U(requestUrl) {
  const DATA_URL = 'https://raw.githubusercontent.com/doctor-8trange/nexphi0/refs/heads/main/data/icc.json';
  const origin   = requestUrl.origin;
  // Where your player lives — change if different
  const PLAYER   = `${origin}/icc-play.html`;

  let data;
  try {
    const r = await fetch(DATA_URL, { cf: { cacheEverything: false } });
    data = await r.json();
  } catch (e) {
    return new Response(`#EXTM3U\n# Failed to fetch data: ${e.message}`, {
      status: 502, headers: { ...corsHeaders(), 'Content-Type': 'application/x-mpegurl' },
    });
  }

  const lines = ['#EXTM3U'];
  const allMatches = [...(data.live || []), ...(data.upcoming || [])];

  for (const match of allMatches) {
    const pb = match.playback;
    if (!pb?.playbackUrl) continue;   // upcoming entries have no playback yet

    const title     = match.title || 'ICC Match';
    const thumb     = match.thumbnail?.thumbnailUrl || '';
    const isLive    = match.fields?.videoStatus === 'Live';
    const group     = isLive ? 'ICC LIVE' : 'ICC UPCOMING';
    const streamUrl = pb.playbackUrl;

    // Build key param — prefer hex over jwk for simplicity
    let keyParam = '';
    if (pb.keys?.hex) {
      keyParam = `&hexKeys=${encodeURIComponent(pb.keys.hex)}`;
    } else if (pb.keys?.jwk) {
      keyParam = `&keys=${encodeURIComponent(JSON.stringify(pb.keys.jwk))}`;
    }

    // The "stream URL" for M3U is the proxied MPD so Shaka-based players work,
    // OR we output a player deep-link for apps that support http-uri channels.
    // Most IPTV apps can't handle ClearKey DRM, so we provide BOTH:
    //   - tvg-url  = proxied MPD  (for Shaka/ExoPlayer-based apps)
    //   - actual stream line = proxied MPD
    const proxiedMpd = `${requestUrl.origin}/api/proxy?u=${encodeURIComponent(streamUrl)}`;
    const playerLink = `${PLAYER}?url=${encodeURIComponent(streamUrl)}${keyParam}`;

    lines.push(
      `#EXTINF:-1 tvg-name="${title}" tvg-logo="${thumb}" group-title="${group}" ` +
      `icc-player="${encodeURIComponent(playerLink)}" ` +
      `icc-keys="${pb.keys?.hex || ''}", ${title}`,
      proxiedMpd
    );
  }

  return new Response(lines.join('\n'), {
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/x-mpegurl',
      'Content-Disposition': 'attachment; filename="icc.m3u"',
      'Cache-Control': 'no-cache, no-store',
    },
  });
}

// ── Stream Proxy ──────────────────────────────────────────────────────────────
async function handleProxy(targetUrl, requestUrl) {
  try {
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    // Pull per-stream headers from JSON if caller passes ?headers=<encoded>
    // Otherwise fall back to sensible defaults
    const extraHeaders = {};
    const rawHeaders = requestUrl.searchParams.get('headers');
    if (rawHeaders) {
      try {
        const parsed = JSON.parse(decodeURIComponent(rawHeaders));
        for (const h of parsed) {
          const idx = h.indexOf(': ');
          if (idx > -1) extraHeaders[h.substring(0, idx)] = h.substring(idx + 2);
        }
      } catch (_) { /* ignore malformed */ }
    }

    const fetchHeaders = {
      'User-Agent': extraHeaders['User-Agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
      'Referer':    extraHeaders['Referer']    || 'https://www.icc-cricket.com/',
      'Origin':     extraHeaders['Origin']     || 'https://www.icc-cricket.com',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    const originResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: fetchHeaders,
      redirect: 'follow',
    });

    let contentType = originResponse.headers.get('Content-Type') || 'application/octet-stream';
    let body = await originResponse.arrayBuffer();

    const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl');
    const isMPD  = targetUrl.includes('.mpd')  ||
                   contentType.includes('dash+xml') ||
                   contentType.includes('application/xml');

    if (isM3U8) {
      const text = new TextDecoder().decode(body);
      const proxyBase = requestUrl.origin + requestUrl.pathname;
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

      // Inject BaseURL so relative segment paths resolve correctly
      if (!text.includes('<BaseURL>') || text.includes('<BaseURL>./</BaseURL>')) {
        text = text.replace(/<Period\b([^>]*)>/g,
          `<Period$1>\n      <BaseURL>${baseUrl}</BaseURL>`);
      }

      // Remove Widevine ContentProtection
      text = text.replace(
        /<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(
        /<ContentProtection[^>]+schemeIdUri="urn:uuid:edef8ba9[^"]*"[^>]*\/>/g, '');
      // Remove PlayReady ContentProtection
      text = text.replace(
        /<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/g, '');
      text = text.replace(
        /<ContentProtection[^>]+schemeIdUri="urn:uuid:9a04f079[^"]*"[^>]*\/>/g, '');

      // Proxy all segment template base URLs inside the MPD
      const proxyBase = requestUrl.origin + requestUrl.pathname;
      text = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, innerUrl) => {
        if (innerUrl.startsWith('http')) {
          return `<BaseURL>${proxyBase}?u=${encodeURIComponent(innerUrl)}</BaseURL>`;
        }
        return match;
      });

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
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}
