export default async function handler(req, res) {
  const events = req.body.events;

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'audio') {
      console.log('音声きた！', event.message.id);
    }
  }

  res.status(200).send('OK');
}
const replyToken = event.replyToken;

await fetch('https://api.line.me/v2/bot/message/reply', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer YOUR_CHANNEL_ACCESS_TOKEN`
  },
  body: JSON.stringify({
    replyToken: replyToken,
    messages: [
      {
        type: 'text',
        text: '音声ありがとう！解析するね！'
      }
    ]
  })
});
