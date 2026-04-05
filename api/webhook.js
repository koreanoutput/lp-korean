// 音声取得
const audioRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
  headers: {
    'Authorization': `Bearer YOUR_CHANNEL_ACCESS_TOKEN`
  }
});

const audioBuffer = await audioRes.arrayBuffer();


// ===== ここから追加 =====

// 文字起こし
const formData = new FormData();
formData.append('file', new Blob([audioBuffer]), 'audio.m4a');
formData.append('model', 'gpt-4o-mini-transcribe');

const transcriptRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer YOUR_OPENAI_API_KEY`
  },
  body: formData
});

const transcriptData = await transcriptRes.json();
const text = transcriptData.text;

console.log('文字起こし:', text);

// ===== ここまで追加 =====


// LINE返信
await fetch('https://api.line.me/v2/bot/message/reply', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer YOUR_CHANNEL_ACCESS_TOKEN`
  },
  body: JSON.stringify({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `あなたの発話👇\n${text}`
      }
    ]
  })
});
