import { Redis } from '@upstash/redis';

// 코멘트와 본문의 변경 카운터를 한 번의 명령(MGET)으로 반환.
// 클라이언트가 2~3초마다 폴링하므로 명령 수를 최소화한다.
const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [cver, cntver] = await redis.mget('c:ver', 'content:ver');
    return res.status(200).json({ cver: cver || 0, cntver: cntver || 0 });
  } catch (err) {
    console.error('meta api error', err);
    return res.status(500).json({ error: 'server error' });
  }
}
