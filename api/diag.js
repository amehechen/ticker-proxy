export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  const hasTD = !!process.env.TWELVE_DATA_TOKEN && process.env.TWELVE_DATA_TOKEN.length > 5;
  res.status(200).end(JSON.stringify({
    ok: true,
    ts: Date.now(),
    env: { TWELVE_DATA_TOKEN_PRESENT: hasTD }
  }));
}
