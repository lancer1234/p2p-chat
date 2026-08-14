const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function isAllowedOrigin(request, env) {
  const allowed = normalizeOrigin(env.ALLOWED_ORIGIN);
  const incoming = normalizeOrigin(request.headers.get('Origin'));
  return Boolean(allowed && incoming && incoming === allowed);
}

async function createTemporaryIceServers(env) {
  const domain = String(env.METERED_DOMAIN || 'makoto.metered.live').trim();
  const secret = String(env.METERED_SECRET_KEY || '').trim();
  const ttl = Math.max(300, Math.min(14400, Number(env.TURN_TTL_SECONDS || 14400)));

  if (!secret) throw new Error('METERED_SECRET_KEY is not configured');

  const createUrl = `https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(secret)}`;
  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expiryInSeconds: ttl,
      label: 'p2p-chat-github-pages'
    })
  });

  if (!createResponse.ok) {
    const body = await createResponse.text();
    throw new Error(`Metered create failed ${createResponse.status}: ${body.slice(0, 200)}`);
  }

  const credential = await createResponse.json();
  if (!credential?.apiKey) throw new Error('Metered did not return apiKey');

  const iceResponse = await fetch(
    `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(credential.apiKey)}`,
    { headers: { 'Accept': 'application/json' } }
  );

  if (!iceResponse.ok) {
    const body = await iceResponse.text();
    throw new Error(`Metered ICE fetch failed ${iceResponse.status}: ${body.slice(0, 200)}`);
  }

  const iceServers = await iceResponse.json();
  if (!Array.isArray(iceServers)) throw new Error('Metered ICE response is not an array');

  return { iceServers, expiresIn: ttl };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'p2p-chat-turn-worker' });
    }

    if (url.pathname !== '/api/turn-credentials') {
      return json({ error: 'Not found' }, 404);
    }

    const allowedOrigin = normalizeOrigin(env.ALLOWED_ORIGIN);

    if (!isAllowedOrigin(request, env)) {
      return json({ error: 'Origin not allowed' }, 403);
    }

    const cors = corsHeaders(allowedOrigin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    try {
      const result = await createTemporaryIceServers(env);
      return json(result, 200, cors);
    } catch (error) {
      console.error('TURN credential error:', error);
      return json({ error: 'Unable to create temporary TURN credentials' }, 502, cors);
    }
  }
};
