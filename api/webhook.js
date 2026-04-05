import crypto from 'crypto';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TRIAL_SENTENCES = [
  { day: 1, japanese: '私は毎朝、韓国語を10分勉強します。', korean: '저는 매일 아침 한국어를 10분 공부해요.' },
  { day: 2, japanese: '昨日は仕事が終わってから友達とご飯を食べました。', korean: '어제는 일이 끝난 후에 친구랑 밥을 먹었어요.' },
  { day: 3, japanese: '来週、韓国に旅行に行く予定です。', korean: '다음 주에 한국으로 여행 갈 예정이에요.' }
];

/**
 * NOTE:
 * - This in-memory store works for a single process.
 * - For production/serverless, replace with Redis/DB.
 */
const userProgressStore = globalThis.__lineTrialUserStore || new Map();
globalThis.__lineTrialUserStore = userProgressStore;

const DAY_MS = 24 * 60 * 60 * 1000;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const expected = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
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
    completedDays: []
  };
  userProgressStore.set(userId, progress);
  return progress;
}

function getOrCreateProgress(userId) {
  const existing = userProgressStore.get(userId);
  if (existing) return existing;
  return startTrial(userId);
}

function getAvailableDayIndex(startedAtISO) {
  const startedAt = new Date(startedAtISO).getTime();
  const now = Date.now();
  const elapsedDays = Math.floor((now - startedAt) / DAY_MS);
  return Math.min(Math.max(elapsedDays, 0), TRIAL_SENTENCES.length - 1);
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

function normalizeKorean(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

function buildFeedback(expectedKorean, recognizedText) {
  const expected = normalizeKorean(expectedKorean);
  const actual = normalizeKorean(recognizedText);

  if (!actual) {
    return {
      score: 0,
      good: '音声は受信できましたが、文字起こし結果が空でした。',
      fix: 'もう一度、少しゆっくり・はっきり録音して送ってみてください。',
      model: expectedKorean
    };
  }

  const distance = levenshtein(expected, actual);
  const maxLen = Math.max(expected.length, actual.length, 1);
  const score = Math.max(0, Math.round((1 - distance / maxLen) * 100));

  let good = '文全体の流れはとても良いです。';
  let fix = '語尾と助詞をもう一度意識して言ってみましょう。';

  if (score >= 90) {
    good = 'ほぼ正確です！発音も自然でとても良いです。';
    fix = 'このまま同じ速さで2〜3回繰り返して定着させましょう。';
  } else if (score >= 70) {
    good = '大枠は合っています。伝わる韓国語になっています。';
    fix = '抜けやすい語尾・助詞を意識してもう一度録音するとさらに良くなります。';
  } else if (score >= 40) {
    good = '重要な単語はしっかり出ています。';
    fix = '文を前半/後半に分けて、ゆっくりつなげて録音してみてください。';
  }

  return {
    score,
    good,
    fix,
    model: expectedKorean
  };
}

function buildLessonMessage(dayIndex) {
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

async function handleFollow(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  startTrial(userId);

  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text:
        '友だち追加ありがとうございます！\n' +
        '今日から3日間、1日1文の瞬間韓作文体験をお届けします。'
    },
    buildLessonMessage(0)
  ]);
}

async function handleAudioMessage(event) {
  const userId = event.source?.userId;
  const messageId = event.message?.id;

  if (!userId || !messageId) return;

  const progress = getOrCreateProgress(userId);
  const availableDayIndex = getAvailableDayIndex(progress.startedAt);

  const pendingDayIndex = TRIAL_SENTENCES.findIndex((_, idx) => {
    if (idx > availableDayIndex) return false;
    return !progress.completedDays.includes(idx);
  });

  if (pendingDayIndex === -1) {
    if (progress.completedDays.length >= TRIAL_SENTENCES.length) {
      await replyMessage(event.replyToken, {
        type: 'text',
        text:
          '3日間の無料体験は完了です🎉\n' +
          'ご参加ありがとうございました！本コースの案内をご希望なら「本コース」と送ってください。'
      });
      return;
    }

    const nextDay = Math.min(progress.completedDays.length, TRIAL_SENTENCES.length - 1);
    const nextDate = new Date(new Date(progress.startedAt).getTime() + DAY_MS * nextDay).toISOString();
    await replyMessage(event.replyToken, {
      type: 'text',
      text:
        `今日の提出は完了しています✅\n` +
        `次の課題は ${formatDate(nextDate)} 以降に配信されます。`
    });
    return;
  }

  const audioBuffer = await getAudioContent(messageId);
  const recognizedText = await transcribeAudio(audioBuffer);

  const lesson = TRIAL_SENTENCES[pendingDayIndex];
  const feedback = buildFeedback(lesson.korean, recognizedText);

  if (!progress.completedDays.includes(pendingDayIndex)) {
    progress.completedDays.push(pendingDayIndex);
    progress.completedDays.sort((a, b) => a - b);
    userProgressStore.set(userId, progress);
  }

  const messages = [
    {
      type: 'text',
      text:
        `【Day ${lesson.day} フィードバック】\n` +
        `あなたの発話: ${recognizedText || '(聞き取り結果なし)'}\n` +
        `スコア: ${feedback.score}/100\n\n` +
        `良かった点: ${feedback.good}\n` +
        `改善ポイント: ${feedback.fix}\n` +
        `模範文: ${feedback.model}`
    }
  ];

  const nextDayIndex = pendingDayIndex + 1;
  if (nextDayIndex < TRIAL_SENTENCES.length) {
    const nextDate = new Date(new Date(progress.startedAt).getTime() + DAY_MS * nextDayIndex).toISOString();
    messages.push({
      type: 'text',
      text:
        `次の課題（Day ${nextDayIndex + 1}）は ${formatDate(nextDate)} 以降に取り組めます。`
    });

    if (availableDayIndex >= nextDayIndex && !progress.completedDays.includes(nextDayIndex)) {
      messages.push(buildLessonMessage(nextDayIndex));
    }
  } else {
    messages.push({
      type: 'text',
      text: '3日間の無料体験、完走おめでとうございます！🎉'
    });
  }

  await replyMessage(event.replyToken, messages);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY) {
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

      if (event.type === 'message' && event.message?.type === 'audio') {
        await handleAudioMessage(event);
      }
    } catch (error) {
      console.error('Webhook event error:', error);
      if (event.replyToken) {
        await replyMessage(event.replyToken, {
          type: 'text',
          text: '処理中にエラーが発生しました。少し時間をおいて再送してください。'
        });
      }
    }
  }

  return json(res, 200, { ok: true });
}
