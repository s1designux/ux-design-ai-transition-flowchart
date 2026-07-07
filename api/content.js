import { Redis } from '@upstash/redis';

// 본문(#doc innerHTML) 공유 저장. `content:html` 문자열 + `content:ver` 변경 카운터.
// 저장 시 이전 버전을 `content:history` 리스트에 백업(최근 30개 유지).
const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const HTML = 'content:html';
const VER = 'content:ver';
const HIST = 'content:history';
const KEEP = 30;
const MAX_HTML = 5 * 1024 * 1024;

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}
function sanitize(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (req.query?.meta !== undefined || (req.url || '').includes('meta=')) {
        const ver = (await redis.get(VER)) || 0;
        return res.status(200).json({ ver });
      }
      const [html, ver] = await redis.mget(HTML, VER);
      return res.status(200).json({ html: html ?? null, ver: ver || 0 });
    }

    if (req.method === 'PUT') {
      const body = parseBody(req);
      let html = body?.html;
      if (typeof html !== 'string' || !html.length) return res.status(400).json({ error: 'html required' });
      if (html.length > MAX_HTML) return res.status(413).json({ error: 'too large' });

      const curVer = (await redis.get(VER)) || 0;
      // 낙관적 동시성: 편집 시작 이후 남이 저장했으면 충돌 (force면 무시).
      if (curVer !== 0 && !body?.force && Number(body?.baseVer) !== curVer) {
        return res.status(409).json({ error: 'conflict', ver: curVer });
      }

      const oldHtml = curVer !== 0 ? await redis.get(HTML) : null;
      html = sanitize(html);

      const p = redis.pipeline();
      if (oldHtml) {
        p.lpush(HIST, { ver: curVer, html: oldHtml, ts: Date.now() });
        p.ltrim(HIST, 0, KEEP - 1);
      }
      p.set(HTML, html);
      p.incr(VER);
      const results = await p.exec();
      const newVer = results[results.length - 1];
      return res.status(200).json({ ok: true, ver: newVer });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('content api error', err);
    return res.status(500).json({ error: 'server error' });
  }
}
