import crypto from 'crypto';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const TRIAL_SENTENCES = [
  {
    day: 1,
    japanesePrompt: '私は毎朝コーヒーを飲みます。',
    modelAnswer: '저는 매일 아침에 커피를 마셔요.',
    checkPoint:
      '「아침에」の에を入れること。「커피」が「코피」になっていないか確認。日常会話では「마십니다」より「마셔요」の形が自然です。'
  },
  {
    day: 2,
    japanesePrompt: '私は今、家で仕事をしています。',
    modelAnswer: '저는 지금 집에서 일하고 있어요.',
    checkPoint: '「지금 + -고 있어요」で今まさにしている状態を表せるかを確認。'
  },
  {
    day: 3,
    japanesePrompt: '今日は＿＿をしています。（空欄は自由）',
    modelAnswer: '오늘은 ____ 고 있어요.',
    checkPoint: '空欄に自分で単語を入れて「오늘은 + 動詞の語幹 + 고 있어요」を作ること。'
  }
];

/**
 * NOTE:
 * - This in-memory store works for a single process.
 * - For production/serverless, replace with Redis/DB.
 */
const userProgressStore = globalThis.__lineTrialUserStore || new Map();
globalThis.__lineTrialUserStore = userProgressStore;

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_HOURS = 9;
const LESSON_RELEASE_HOUR_JST = 8;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_TABLE = 'trial_user_progress';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
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
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const expected = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  return expected === signature;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function startTrial(userId) {
  const startedAt = new Date().toISOString();
  const progress = {
    userId,
    startedAt,
    completedDays: [],
    selectedDayIndex: null,
    deliveredDays: [0]
  };
  return progress;
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
  if (hasSupabaseConfig()) {
    const encodedUserId = encodeURIComponent(userId);
    const rows = await supabaseRequest(
      `${SUPABASE_TABLE}?user_id=eq.${encodedUserId}&select=user_id,started_at,completed_days,selected_day_index,delivered_days&limit=1`
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const row = rows[0];
    const parsed = {
      startedAt: row.started_at,
      completedDays: Array.isArray(row.completed_days) ? row.completed_days : [],
      selectedDayIndex: Number.isInteger(row.selected_day_index) ? row.selected_day_index : null,
      deliveredDays: Array.isArray(row.delivered_days) ? row.delivered_days : [0]
    };
    return normalizeProgress(parsed, row.user_id || userId);
  }

  return normalizeProgress(userProgressStore.get(userId), userId);
}

async function saveProgress(progress) {
  const normalized = normalizeProgress(progress, progress.userId);
  if (!normalized) return;

  if (hasSupabaseConfig()) {
    await supabaseRequest(`${SUPABASE_TABLE}?on_conflict=user_id`, {
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
    return;
  }

  userProgressStore.set(normalized.userId, normalized);
}

async function getOrCreateProgress(userId) {
  const existing = await loadProgress(userId);
  if (existing) return existing;
  const created = startTrial(userId);
  await saveProgress(created);
  return created;
}

function getDatePartsInJst(timestamp) {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(new Date(timestamp));
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  return { year, month, day };
}

function toUtcTimestampFromJst({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  return Date.UTC(year, month - 1, day, hour - JST_OFFSET_HOURS, minute, second, 0);
}

function getLessonReleaseTimestamp(startedAtISO, dayIndex) {
  const startedAt = new Date(startedAtISO).getTime();

  if (dayIndex <= 0) {
    return startedAt;
  }

  const { year, month, day } = getDatePartsInJst(startedAt);
  const day2ReleaseBase = toUtcTimestampFromJst({
    year,
    month,
    day: day + 1,
    hour: LESSON_RELEASE_HOUR_JST
  });

  return day2ReleaseBase + DAY_MS * (dayIndex - 1);
}

function getAvailableDayIndex(startedAtISO) {
  const now = Date.now();

  let availableDayIndex = 0;

  for (let dayIndex = 1; dayIndex < TRIAL_SENTENCES.length; dayIndex += 1) {
    if (now >= getLessonReleaseTimestamp(startedAtISO, dayIndex)) {
      availableDayIndex = dayIndex;
    }
  }

  return availableDayIndex;
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

async function replyMessage(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: Array.isArray(messages) ? messages : [messages]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('LINE reply failed:', res.status, text);
  }
}

async function pushMessage(userId, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LINE push failed: ${res.status} ${text}`);
  }
}

async function getAudioContent(messageId) {
  const audioRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    }
  });

  if (!audioRes.ok) {
    throw new Error(`LINE audio fetch failed: ${audioRes.status} ${await audioRes.text()}`);
  }

  return audioRes.arrayBuffer();
}

async function transcribeAudio(audioBuffer) {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/mp4' }), 'voice.m4a');
  formData.append('model', 'gpt-4o-mini-transcribe');

  const transcriptRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: formData
  });

  if (!transcriptRes.ok) {
    const errText = await transcriptRes.text();
    throw new Error(`OpenAI transcription failed: ${transcriptRes.status} ${errText}`);
  }

  const transcriptData = await transcriptRes.json();
  return transcriptData.text || '';
}

function extractTextFromGeminiResponse(data) {
  const candidates = data?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return '';
}

function tryParseJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

async function generateGeminiAudioFeedback({ audioBuffer, lesson, recognizedText }) {
  const prompt = [
    'あなたは韓国語コーチです。',
    '学習者の音声（韓国語）を聞いて、発音とイントネーションを評価してください。',
    `課題（日本語）: ${lesson.japanesePrompt}`,
    `模範解答（韓国語）: ${lesson.modelAnswer}`,
    `文字起こし結果: ${recognizedText || '(空)'}`,
    '',
    '次のJSONだけを返してください。説明文は不要です。',
    '{"score": number, "pronunciation": string, "intonation": string, "fix": string, "model": string}',
    '条件:',
    '- scoreは0-100の整数',
    '- pronunciation, intonation, fix, model はそれぞれ120文字以内',
    '- modelは学習者向けの自然な模範文',
    `添削チェックポイント: ${lesson.checkPoint}`
  ].join('\n');

  const base64Audio = Buffer.from(audioBuffer).toString('base64');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: 'audio/mp4',
                  data: base64Audio
                }
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini feedback failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const rawText = extractTextFromGeminiResponse(data);
  const parsed = tryParseJson(rawText);

  if (!parsed) {
    throw new Error(`Gemini feedback parse failed: ${rawText}`);
  }

  return {
    score: Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 0,
    pronunciation: parsed.pronunciation || '発音の要点を確認できませんでした。',
    intonation: parsed.intonation || 'イントネーションの要点を確認できませんでした。',
    fix: parsed.fix || 'もう一度ゆっくり録音してみてください。',
    model: parsed.model || lesson.modelAnswer
  };
}

function normalizeKorean(text) {
  return (text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[a.length][b.length];
}

function buildFallbackFeedback(expectedKorean, recognizedText) {
  const expected = normalizeKorean(expectedKorean);
  const actual = normalizeKorean(recognizedText);

  if (!actual) {
    return {
      score: 0,
      pronunciation: '音声は受信できましたが、文字起こし結果が空でした。',
      intonation: 'イントネーション評価を行うため、もう一度録音してください。',
      fix: 'もう一度、少しゆっくり・はっきり録音して送ってみてください。',
      model: expectedKorean
    };
  }

  const distance = levenshtein(expected, actual);
  const maxLen = Math.max(expected.length, actual.length, 1);
  const score = Math.max(0, Math.round((1 - distance / maxLen) * 100));

  return {
    score,
    pronunciation: '発音の大枠は確認できました。',
    intonation: '音の高低と語尾の下げ方を意識するとより自然です。',
    fix: '語尾と助詞を意識してもう一度録音するとさらに良くなります。',
    model: expectedKorean
  };
}

function mapErrorToUserMessage(error) {
  const message = String(error?.message || '');

  if (message.includes('insufficient_quota')) {
    return '現在、音声添削APIの利用上限に達しています。時間をおいて再度お試しください。';
  }

  if (message.includes('OpenAI transcription failed: 429')) {
    return '現在アクセス集中のため音声文字起こしに失敗しました。少し時間をおいて再送してください。';
  }

  if (message.includes('Gemini feedback failed: 429')) {
    return '現在アクセス集中のため音声添削に失敗しました。少し時間をおいて再送してください。';
  }

  if (message.includes('OpenAI transcription failed: 401') || message.includes('Gemini feedback failed: 401')) {
    return '現在、音声機能の設定エラーが発生しています。運営側で確認中です。';
  }

  return '処理中にエラーが発生しました。少し時間をおいて再送してください。';
}

function parseDayFromText(text) {
  const normalized = String(text || '').trim();
  const match = normalized.match(/([1-3])\s*日目/);
  if (!match) return null;
  const day = Number(match[1]);
  return Number.isInteger(day) ? day - 1 : null;
}

function getDayAssignmentMessage(dayIndex) {
  const lesson = TRIAL_SENTENCES[dayIndex];
  if (!lesson) return null;

  return (
    `【${lesson.day}日目の課題】\n` +
    '以下の日本語を韓国語で言って、音声を送ってください。\n' +
    `「${lesson.japanesePrompt}」\n` +
    `先に「${lesson.day}日目」と送ってから録音するとスムーズです。`
  );
}

export async function sendScheduledAssignments(now = Date.now()) {
  if (!hasSupabaseConfig()) {
    return { ok: true, skipped: true, reason: 'Supabase is not configured' };
  }

  const rows = (await supabaseRequest(`${SUPABASE_TABLE}?select=user_id`)) || [];
  const userIds = rows.map((row) => row.user_id).filter(Boolean);
  let sentCount = 0;

  for (const userId of userIds) {
    const progress = await loadProgress(userId);
    if (!progress) continue;

    for (let dayIndex = 1; dayIndex < TRIAL_SENTENCES.length; dayIndex += 1) {
      const alreadyDelivered = progress.deliveredDays.includes(dayIndex);
      const releaseAt = getLessonReleaseTimestamp(progress.startedAt, dayIndex);

      if (!alreadyDelivered && now >= releaseAt) {
        const text = getDayAssignmentMessage(dayIndex);
        await pushMessage(userId, { type: 'text', text });
        progress.deliveredDays.push(dayIndex);
        progress.deliveredDays.sort((a, b) => a - b);
        sentCount += 1;
      }
    }

    await saveProgress(progress);
  }

  return { ok: true, skipped: false, sentCount, users: userIds.length };
}

async function handleFollow(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  const progress = startTrial(userId);
  await saveProgress(progress);

  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text:
        'さっそく1日目の課題をお送りします\n' +
        '─────────────\n' +
        '3日間のテーマ\n' +
        '文法：現在・状態（〜です／〜しています）\n' +
        'シーン：日常・自己紹介\n' +
        '同じ文法を3日間、少しずつ負荷を上げながら練習します。\n' +
        '─────────────\n' +
        '【1日目：まず1文、言ってみる】\n' +
        '以下の日本語を韓国語で言って、音声を送ってください。\n' +
        '「私は毎朝コーヒーを飲みます。」\n' +
        '※ 分からなくてOKです。知っている単語だけ並べてみてください。\n' +
        'トーク画面下のマイクボタンを押して録音し、このトーク画面に送ってください。\n' +
        '─────────────\n' +
        '送っていただいた音声にAIがフィードバックをお返しします。 \n' +
        '正解は添削と一緒にお届けします。\n' +
        '※ 体験版は1文のみです。正式コースでは毎日5文に取り組みます。\n' +
        'コースに関するご質問はいつでもどうぞ。\n' +
        'コースの詳細・お申し込みはこちら→【URL】'
    }
  ]);
}

async function handleTextMessage(event) {
  const userId = event.source?.userId;
  const input = event.message?.text;
  if (!userId || !input) return;

  const progress = await getOrCreateProgress(userId);
  const dayIndex = parseDayFromText(input);

  if (dayIndex === null) return;

  const availableDayIndex = getAvailableDayIndex(progress.startedAt);

  if (dayIndex > availableDayIndex) {
    const unlockDate = new Date(getLessonReleaseTimestamp(progress.startedAt, dayIndex)).toISOString();
    await replyMessage(event.replyToken, {
      type: 'text',
      text: `まだDay ${dayIndex + 1} は解放されていません。${formatDate(unlockDate)} 以降に取り組めます。`
    });
    return;
  }

  if (progress.completedDays.includes(dayIndex)) {
    await replyMessage(event.replyToken, {
      type: 'text',
      text: `Day ${dayIndex + 1} は提出済みです。別の日の課題に進んでください。`
    });
    return;
  }

  progress.selectedDayIndex = dayIndex;
  await saveProgress(progress);

  await replyMessage(event.replyToken, {
    type: 'text',
    text: `Day ${dayIndex + 1} を受け付けました。\nこのまま録音を送ってください。`
  });
}

async function handleAudioMessage(event) {
  const userId = event.source?.userId;
  const messageId = event.message?.id;

  if (!userId || !messageId) return;

  const progress = await getOrCreateProgress(userId);
  const availableDayIndex = getAvailableDayIndex(progress.startedAt);

  const day1Incomplete = !progress.completedDays.includes(0) && availableDayIndex >= 0;

  let targetDayIndex = progress.selectedDayIndex;

  if (targetDayIndex === null && day1Incomplete) {
    targetDayIndex = 0;
  }

  if (targetDayIndex === null) {
    await replyMessage(event.replyToken, {
      type: 'text',
      text:
        '録音を受け取りましたが、何日目の課題か不明です。\n' +
        '先に「2日目」または「3日目」と送ってから録音してください。'
    });
    return;
  }

  if (targetDayIndex > availableDayIndex) {
    const unlockDate = new Date(getLessonReleaseTimestamp(progress.startedAt, targetDayIndex)).toISOString();
    await replyMessage(event.replyToken, {
      type: 'text',
      text: `Day ${targetDayIndex + 1} はまだ解放されていません。${formatDate(unlockDate)} 以降に取り組めます。`
    });
    return;
  }

  if (progress.completedDays.includes(targetDayIndex)) {
    await replyMessage(event.replyToken, {
      type: 'text',
      text: `Day ${targetDayIndex + 1} は提出済みです。別の日の課題を指定してください。`
    });
    return;
  }

  const audioBuffer = await getAudioContent(messageId);
  const recognizedText = await transcribeAudio(audioBuffer);

  const lesson = TRIAL_SENTENCES[targetDayIndex];

  let feedback;
  try {
    feedback = await generateGeminiAudioFeedback({
      audioBuffer,
      lesson,
      recognizedText
    });
  } catch (geminiError) {
    console.error('Gemini feedback fallback:', geminiError);
    feedback = buildFallbackFeedback(lesson.modelAnswer, recognizedText);
  }

  progress.selectedDayIndex = null;

  if (!progress.completedDays.includes(targetDayIndex)) {
    progress.completedDays.push(targetDayIndex);
    progress.completedDays.sort((a, b) => a - b);
  }
  await saveProgress(progress);

  const messages = [
    {
      type: 'text',
      text:
        `【Day ${lesson.day} フィードバック】\n` +
        `あなたの発話(文字起こし): ${recognizedText || '(聞き取り結果なし)'}\n` +
        `総合スコア: ${feedback.score}/100\n\n` +
        `発音: ${feedback.pronunciation}\n` +
        `イントネーション: ${feedback.intonation}\n` +
        `改善ポイント: ${feedback.fix}\n` +
        `模範文: ${feedback.model}`
    }
  ];

  if (progress.completedDays.length >= TRIAL_SENTENCES.length) {
    messages.push({
      type: 'text',
      text:
        '3日間の無料体験、完走おめでとうございます！🎉\n' +
        'ご参加ありがとうございました。\n\n' +
        '「続けたい」「もっとやりたい」と感じていただけていたら、ぜひ正式コースへ。\n' +
        '10月5日開講・モニター5名限定です。\n' +
        '正規価格 ¥98,000のところ、モニター特別価格 ¥59,400（40%OFF）でご参加いただけます。\n' +
        '【申し込みフォームURL】\n' +
        'ご質問はお気軽にどうぞ。明日も改めてご案内をお送りします。'
    });
  } else {
    messages.push({
      type: 'text',
      text:
        '次の提出時は、先に「2日目」または「3日目」と送ってから録音してください。\n' +
        '（1日目のみ指定なし提出OK）'
    });
  }

  await replyMessage(event.replyToken, messages);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY || !GEMINI_API_KEY) {
    return json(res, 500, { ok: false, error: 'Missing env vars' });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-line-signature'];

  if (!verifyLineSignature(rawBody, signature)) {
    return json(res, 401, { ok: false, error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(res, 400, { ok: false, error: 'Invalid JSON' });
  }

  const events = body.events || [];

  for (const event of events) {
    try {
      if (event.type === 'follow') {
        await handleFollow(event);
      }

      if (event.type === 'message' && event.message?.type === 'text') {
        await handleTextMessage(event);
      }

      if (event.type === 'message' && event.message?.type === 'audio') {
        await handleAudioMessage(event);
      }
    } catch (error) {
      console.error('Webhook event error:', error);
      if (event.replyToken) {
        await replyMessage(event.replyToken, {
          type: 'text',
          text: mapErrorToUserMessage(error)
        });
      }
    }
  }

  return json(res, 200, { ok: true });
}
