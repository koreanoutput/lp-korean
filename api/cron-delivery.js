import { sendScheduledAssignments } from './webhook.js';

const CRON_SECRET = process.env.CRON_SECRET;
const DELIVERY_HOURS_JST = new Set([8]);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function getCurrentJstHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    hour12: false
  });
  return Number(formatter.format(new Date()));
}

function isAuthorized(req) {
  if (!CRON_SECRET) return true;

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const querySecret = req.query?.secret || '';
  return bearer === CRON_SECRET || querySecret === CRON_SECRET;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const force = req.query?.force === '1';
  if (!force && !DELIVERY_HOURS_JST.has(getCurrentJstHour())) {
    return json(res, 200, { ok: true, skipped: true, reason: 'Not release hour in JST' });
  }

  try {
    const result = await sendScheduledAssignments();
    return json(res, 200, result);
  } catch (error) {
    console.error('cron-delivery failed:', error);
    return json(res, 500, { ok: false, error: String(error?.message || error) });
  }
}
