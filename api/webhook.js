export default async function handler(req, res) {
  if (req.method === 'POST') {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
  }

  res.status(200).send('OK');
}
