export default async function handler(req, res) {
  const events = req.body.events;

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'audio') {
      
      const replyToken = event.replyToken;

      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer DOd6LxMqMkN5fk+EA28SLhl02rOfP3FzEenBb7M49cmTPeM7mB5jrkM+xlA35EoHJVNfhaf3/s+LKqKb9YaaVptr5XqTWR3zB+HkB2/bql3WqSTDdk5u0bL3fmWw9c3r3VQHsxwDmJ2qQIqEpiILHgdB04t89/1O/w1cDnyilFU=`
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

    }
  }

  res.status(200).send('OK');
}
