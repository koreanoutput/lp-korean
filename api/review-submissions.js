const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REVIEW_SECRET = process.env.REVIEW_SECRET || process.env.CRON_SECRET;
const PROGRESS_TABLE = 'trial_user_progress';
const REVIEW_TABLE = 'trial_feedback_reviews';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function isAuthorized(req) {
  if (!REVIEW_SECRET) return true;

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const querySecret = req.query?.secret || '';
  return bearer === REVIEW_SECRET || querySecret === REVIEW_SECRET;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function supabaseRequest(pathWithQuery, { method = 'GET', body, prefer } = {}) {
  if (!hasSupabaseConfig()) return null;

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };
  if (prefer) {
    headers.Prefer = prefer;
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithQuery}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${await response.text()}`);
  }

  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function pushMessage(userId, messages) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      to: userId,
      messages: Array.isArray(messages) ? messages : [messages]
    })
  });

  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${await response.text()}`);
  }
}

function normalizeProgress(progress, userId) {
  if (!progress) return null;
  return {
    userId,
    startedAt: progress.startedAt || new Date().toISOString(),
    completedDays: Array.isArray(progress.completedDays) ? progress.completedDays : [],
    selectedDayIndex:
      progress.selectedDayIndex === null || Number.isInteger(progress.selectedDayIndex) ? progress.selectedDayIndex : null,
    deliveredDays: Array.isArray(progress.deliveredDays) ? progress.deliveredDays : [0]
  };
}

async function loadProgress(userId) {
  const encodedUserId = encodeURIComponent(userId);
  const rows = await supabaseRequest(
    `${PROGRESS_TABLE}?user_id=eq.${encodedUserId}&select=user_id,started_at,completed_days,selected_day_index,delivered_days&limit=1`
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const row = rows[0];
  return normalizeProgress(
    {
      startedAt: row.started_at,
      completedDays: Array.isArray(row.completed_days) ? row.completed_days : [],
      selectedDayIndex: Number.isInteger(row.selected_day_index) ? row.selected_day_index : null,
      deliveredDays: Array.isArray(row.delivered_days) ? row.delivered_days : [0]
    },
    row.user_id || userId
  );
}

async function saveProgress(progress) {
  const normalized = normalizeProgress(progress, progress.userId);
  await supabaseRequest(`${PROGRESS_TABLE}?on_conflict=user_id`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [
      {
        user_id: normalized.userId,
        started_at: normalized.startedAt,
        completed_days: normalized.completedDays,
        selected_day_index: normalized.selectedDayIndex,
        delivered_days: normalized.deliveredDays
      }
    ]
  });
}

async function loadSubmission(id) {
  const encodedId = encodeURIComponent(id);
  const rows = await supabaseRequest(`${REVIEW_TABLE}?id=eq.${encodedId}&select=*&limit=1`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

async function updateSubmission(id, patch) {
  const encodedId = encodeURIComponent(id);
  const rows = await supabaseRequest(`${REVIEW_TABLE}?id=eq.${encodedId}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: patch
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

function buildLineMessages(submission) {
  const messages = [];
  const followupText = typeof submission.followup_text === 'string' ? submission.followup_text.trim() : '';

  if (submission.feedback_text) {
    messages.push({ type: 'text', text: submission.feedback_text });
  }

  if (
    followupText &&
    followupText !== '内容を確認してからフィードバックをお送りします。' &&
    followupText !== '内容を確認してからフィードバックをお送りします。次回以降は先に「2日目」または「3日目」と送ってから録音してください。'
  ) {
    messages.push({ type: 'text', text: followupText });
  }

  return messages;
}

async function markProgressCompleted(submission) {
  const progress = await loadProgress(submission.user_id);
  if (!progress) {
    throw new Error(`Progress not found for user ${submission.user_id}`);
  }

  if (!progress.completedDays.includes(submission.day_index)) {
    progress.completedDays.push(submission.day_index);
    progress.completedDays.sort((a, b) => a - b);
  }
  progress.selectedDayIndex = null;
  await saveProgress(progress);
}

async function handleApprove(body) {
  const submission = await loadSubmission(body.id);
  if (!submission) {
    return { status: 404, body: { ok: false, error: 'Submission not found' } };
  }

  if (submission.status === 'sent') {
    return { status: 409, body: { ok: false, error: 'Submission already sent' } };
  }

  const feedbackText = typeof body.feedbackText === 'string' ? body.feedbackText.trim() : submission.feedback_text;
  const followupText =
    typeof body.followupText === 'string'
      ? body.followupText.trim() || null
      : submission.followup_text;
  const reviewerNote =
    typeof body.reviewerNote === 'string' ? body.reviewerNote.trim() || null : submission.reviewer_note;

  const approved = await updateSubmission(submission.id, {
    feedback_text: feedbackText,
    followup_text: followupText,
    reviewer_note: reviewerNote,
    status: 'approved',
    approved_at: new Date().toISOString()
  });

  await pushMessage(approved.user_id, buildLineMessages(approved));
  await markProgressCompleted(approved);

  const sent = await updateSubmission(submission.id, {
    status: 'sent',
    sent_at: new Date().toISOString()
  });

  return {
    status: 200,
    body: {
      ok: true,
      action: 'approved',
      submission: sent
    }
  };
}

async function handleReject(body) {
  const submission = await loadSubmission(body.id);
  if (!submission) {
    return { status: 404, body: { ok: false, error: 'Submission not found' } };
  }

  const reviewerNote =
    typeof body.reviewerNote === 'string' ? body.reviewerNote.trim() || null : submission.reviewer_note;

  const updated = await updateSubmission(submission.id, {
    reviewer_note: reviewerNote,
    status: 'rejected',
    rejected_at: new Date().toISOString()
  });

  return {
    status: 200,
    body: {
      ok: true,
      action: 'rejected',
      submission: updated
    }
  };
}

async function handleUpdate(body) {
  const submission = await loadSubmission(body.id);
  if (!submission) {
    return { status: 404, body: { ok: false, error: 'Submission not found' } };
  }

  if (submission.status === 'sent') {
    return { status: 409, body: { ok: false, error: 'Sent submissions cannot be edited' } };
  }

  const patch = {};
  if (typeof body.feedbackText === 'string') {
    patch.feedback_text = body.feedbackText.trim();
  }
  if (typeof body.followupText === 'string') {
    patch.followup_text = body.followupText.trim() || null;
  }
  if (typeof body.reviewerNote === 'string') {
    patch.reviewer_note = body.reviewerNote.trim() || null;
  }

  const updated = await updateSubmission(submission.id, patch);
  return {
    status: 200,
    body: {
      ok: true,
      action: 'updated',
      submission: updated
    }
  };
}

export default async function handler(req, res) {
  if (!hasSupabaseConfig()) {
    return json(res, 500, { ok: false, error: 'Supabase is not configured' });
  }

  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    return json(res, 500, { ok: false, error: 'Missing LINE channel access token' });
  }

  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const status = req.query?.status || 'pending';
      const rows =
        (await supabaseRequest(
          `${REVIEW_TABLE}?status=eq.${encodeURIComponent(status)}&select=*&order=created_at.desc&limit=50`
        )) || [];

      return json(res, 200, { ok: true, submissions: rows });
    }

    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    const body = await readJsonBody(req);
    if (!body?.id || !body?.action) {
      return json(res, 400, { ok: false, error: 'id and action are required' });
    }

    if (body.action === 'approve') {
      const result = await handleApprove(body);
      return json(res, result.status, result.body);
    }

    if (body.action === 'reject') {
      const result = await handleReject(body);
      return json(res, result.status, result.body);
    }

    if (body.action === 'update') {
      const result = await handleUpdate(body);
      return json(res, result.status, result.body);
    }

    return json(res, 400, { ok: false, error: 'Unknown action' });
  } catch (error) {
    console.error('review-submissions failed:', error);
    return json(res, 500, { ok: false, error: String(error?.message || error) });
  }
}
