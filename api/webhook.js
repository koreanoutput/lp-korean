import crypto from 'crypto';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TRIAL_SENTENCES = [
  { day: 1, japanese: '私は毎朝、韓国語を10分勉強します。', korean: '저는 매일 아침 한국어를 10분 공부해요.' },
  { day: 2, japanese: '昨日は仕事が終わってから友達とご飯を食べました。', korean: '어제는 일이 끝난 후에 친구랑 밥을 먹었어요.' },
  { day: 3, japanese: '来週、韓国に旅行に行く予定です。', korean: '다음 주에 한국으로 여행 갈 예정이에요.' }
];

// NOTE: 本番は Redis / DB に置き換えてください（これは一時保存）
const userProgressStore = globalThis.__lineTrialUserStore || new Map();
globalThis.__lineTrialUserStore = userProgressStore;

const DAY_MS = 24 * 60 * 60 * 1000;

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const digest = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  return digest === signature;
}

function startTrial(userId) {
  const progress = { userId, startedAt: new Date().toISOString(), completedDays: [] };
  userProgressStore.set(userId, progress);
  return progress;
}

function getOrCreateProgress(userId) {
  return userProgressStore.get(userId) || startTrial(userId);
}

function getAvailableDayIndex(startedAtISO) {
  const elapsed = Math.floor((Date.now() - new Date(startedAtISO).getTime()) / DAY_MS);
  return Math.min(Math.max(elapsed, 0), TRIAL_SENTENCES.length - 1);
}

function formatJst(iso) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function lessonMessage(dayIndex) {
  const lesson = TRIAL_SENTENCES[dayIndex];
  return {
    type: 'text',
    text:
      `【3日間無料体験 Day ${lesson.day}/3】\n` +
      `次の1文を韓国語で録音して送ってください🎙️\n\n` +
      `日本語: ${lesson.japanese}\n` +
      `目標文: ${lesson.korean}`
  };
}

async function replyMessage(replyToken, messages) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
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
}

async function fetchAudio(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`LINE audio fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

async function transcribeAudio(audioBuffer) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), 'voice.m4a');
  form.append('model', 'gpt-4o-mini-transcribe');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });

  if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.text || '';
}

async function generateFeedback({ expectedKorean, japanese, recognizedText }) {
  const prompt =
    `あなたは韓国語コーチです。\n` +
    `正解文: ${expectedKorean}\n` +
    `日本語意味: ${japanese}\n` +
    `学習者の発話（文字起こし）: ${recognizedText}\n\n` +
    `次のJSONのみ返してください: {"score": number, "good": string, "fix": string, "model": string}\n` +
    `条件: scoreは0-100、各文は100文字以内。`;

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'feedback',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              score: { type: 'number' },
              good: { type: 'string' },
              fix: { type: 'string' },
              model: { type: 'string' }
            },
            required: ['score', 'good', 'fix', 'model']
          }
        }
      }
    })
  });

  if (!res.ok) throw new Error(`Feedback failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.output_text);
}

async function handleFollow(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  startTrial(userId);

  await replyMessage(event.replyToken, [
    { type: 'text', text: '友だち追加ありがとうございます！\n3日間、1日1文の体験を始めます。' },
    lessonMessage(0)
  ]);
}

async function handleAudio(event) {
  const userId = event.source?.userId;
  const messageId = event.message?.id;
  if (!userId || !messageId) return;

  const progress = getOrCreateProgress(userId);
  const availableDay = getAvailableDayIndex(progress.startedAt);

  const pendingDay = TRIAL_SENTENCES.findIndex((_, idx) => idx <= availableDay && !progress.completedDays.includes(idx));

  if (pendingDay === -1) {
    if (progress.completedDays.length >= TRIAL_SENTENCES.length) {
      await replyMessage(event.replyToken, { type: 'text', text: '3日間の無料体験は完了です🎉' });
      return;
    }

    const nextDay = Math.min(progress.completedDays.length, TRIAL_SENTENCES.length - 1);
    const nextDate = new Date(new Date(progress.startedAt).getTime() + DAY_MS * nextDay).toISOString();
    await replyMessage(event.replyToken, {
      type: 'text',
      text: `今日の提出は完了しています✅\n次の課題は ${formatJst(nextDate)} 以降です。`
    });
    return;
  }

  const lesson = TRIAL_SENTENCES[pendingDay];
  const audioBuffer = await fetchAudio(messageId);
  const recognizedText = await transcribeAudio(audioBuffer);
  const feedback = await generateFeedback({
    expectedKorean: lesson.korean,
    japanese: lesson.japanese,
    recognizedText
  });

  if (!progress.completedDays.includes(pendingDay)) {
    progress.completedDays.push(pendingDay);
    progress.completedDays.sort((a, b) => a - b);
    userProgressStore.set(userId, progress);
  }

  const messages = [
    {
      type: 'text',
      text:
        `【Day ${lesson.day} フィードバック】\n` +
        `あなたの発話: ${recognizedText || '(聞き取り結果なし)'}\n` +
        `スコア: ${Math.round(feedback.score)}/100\n\n` +
        `良かった点: ${feedback.good}\n` +
        `改善ポイント: ${feedback.fix}\n` +
        `模範文: ${feedback.model}`
    }
  ];

  const nextDay = pendingDay + 1;
  if (nextDay < TRIAL_SENTENCES.length) {
    const nextDate = new Date(new Date(progress.startedAt).getTime() + DAY_MS * nextDay).toISOString();
    messages.push({
      type: 'text',
      text: `次の課題（Day ${nextDay + 1}）は ${formatJst(nextDate)} 以降に取り組めます。`
    });
    if (availableDay >= nextDay && !progress.completedDays.includes(nextDay)) {
      messages.push(lessonMessage(nextDay));
    }
  } else {
    messages.push({ type: 'text', text: '3日間の無料体験、完走おめでとうございます！🎉' });
  }

  await replyMessage(event.replyToken, messages);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });

  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY) {
    return sendJson(res, 500, { ok: false, error: 'Missing env vars' });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-line-signature'];

  if (!verifyLineSignature(rawBody, signature)) {
    return sendJson(res, 401, { ok: false, error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }

  for (const event of body.events || []) {
    try {
      if (event.type === 'follow') await handleFollow(event);
      if (event.type === 'message' && event.message?.type === 'audio') await handleAudio(event);
    } catch (e) {
      console.error(e);
      if (event.replyToken) {
        await replyMessage(event.replyToken, {
          type: 'text',
          text: '処理中にエラーが発生しました。少し時間をおいて再送してください。'
        });
      }
    }
  }

  return sendJson(res, 200, { ok: true });
}
