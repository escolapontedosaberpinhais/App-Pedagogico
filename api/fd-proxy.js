export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
  if (req.method === 'OPTIONS') { return res.status(204).end(); }
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) { return res.status(401).json({ error: 'Missing X-API-Key header' }); }
  const params = new URLSearchParams();
  if (req.query.desde) params.set('desde', req.query.desde);
  const qs = params.toString();
  const upstream = `https://financedesk-tan.vercel.app/api/public/alunos${qs ? '?' + qs : ''}`;
  try {
    const resp = await fetch(upstream, { headers: { 'X-API-Key': apiKey } });
    const body = await resp.json();
    return res.status(resp.status).json(body);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
}
