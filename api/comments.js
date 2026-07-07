import { Redis } from '@upstash/redis';

// Upstash Redis 백엔드. 코멘트는 해시 `comments`(id→객체)에 저장.
// `c:ver`는 변경 카운터 — 추가/수정/삭제/이동 때마다 INCR 하여 클라이언트 변경 감지에 사용.
const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const HKEY = 'comments';
const VKEY = 'c:ver';
const MAX_TEXT = 4000;
const MAX_TOTAL = 2000;

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}
function newId() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
}

// 앵커: 핀이 붙을 문서 요소 경로(path)와 요소 내 상대 위치(fx,fy). 화면 크기·폰트가 달라도 같은 내용에 붙게 한다.
function cleanAnchor(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.path) || a.path.length === 0) return null;
  const path = a.path.map(Number);
  if (path.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const fx = Number(a.fx), fy = Number(a.fy);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  return { path, fx: Math.max(0, Math.min(1, fx)), fy: Math.max(0, Math.min(1, fy)) };
}

async function readAll() {
  const map = await redis.hgetall(HKEY);
  if (!map) return [];
  return Object.values(map)
    .filter((c) => c && typeof c === 'object' && c.id)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (req.query?.meta !== undefined || (req.url || '').includes('meta=')) {
        const ver = (await redis.get(VKEY)) || 0;
        return res.status(200).json({ sig: String(ver) });
      }
      return res.status(200).json(await readAll());
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const text = String(body?.text ?? '').trim();
      const x = Number(body?.x);
      const y = Number(body?.y);
      if (!text || text.length > MAX_TEXT) return res.status(400).json({ error: 'invalid text' });
      if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'invalid position' });
      if ((await redis.hlen(HKEY)) >= MAX_TOTAL) return res.status(429).json({ error: 'too many comments' });

      const comment = { id: newId(), x: Math.round(x), y: Math.round(y), text, ts: Date.now() };
      const anchor = cleanAnchor(body?.anchor);
      if (anchor) comment.anchor = anchor;
      const p = redis.pipeline();
      p.hset(HKEY, { [comment.id]: comment });
      p.incr(VKEY);
      await p.exec();
      return res.status(200).json(comment);
    }

    if (req.method === 'PATCH') {
      const body = parseBody(req);
      const id = String(body?.id ?? '').trim();
      if (!id) return res.status(400).json({ error: 'id required' });
      const existing = await redis.hget(HKEY, id);
      if (!existing) return res.status(404).json({ error: 'not found' });

      const comment = { ...existing, id };
      let changed = false;
      if (body?.text !== undefined) {
        const text = String(body.text).trim();
        if (!text || text.length > MAX_TEXT) return res.status(400).json({ error: 'invalid text' });
        comment.text = text; changed = true;
      }
      if (body?.x !== undefined || body?.y !== undefined) {
        const x = Number(body?.x), y = Number(body?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'invalid position' });
        comment.x = Math.round(x); comment.y = Math.round(y); changed = true;
      }
      if (body?.anchor !== undefined) {
        const anchor = cleanAnchor(body.anchor);
        if (anchor) comment.anchor = anchor; else delete comment.anchor;
        changed = true;
      }
      if (!changed) return res.status(400).json({ error: 'nothing to update' });
      comment.ts = Date.now();
      const p = redis.pipeline();
      p.hset(HKEY, { [id]: comment });
      p.incr(VKEY);
      await p.exec();
      return res.status(200).json(comment);
    }

    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const id = String(body?.id ?? '').trim();
      if (!id) return res.status(400).json({ error: 'id required' });
      const p = redis.pipeline();
      p.hdel(HKEY, id);
      p.incr(VKEY);
      await p.exec();
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('comments api error', err);
    return res.status(500).json({ error: 'server error' });
  }
}
