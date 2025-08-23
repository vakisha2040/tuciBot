require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const axios = require('axios');

//const { bot, webhookPath } = require('./telegram');
const { startBot } = require('./bot');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());


// 🧠 Important: Handle Telegram webhook updates
//app.post(webhookPath, (req, res) => {
 // bot.processUpdate(req.body);
//  res.sendStatus(200);
//});

// Health check
app.get('/', (req, res) => {
  res.send('🟢 Grid bot is alive and running!');
});

require('./telegram'); // ✅ This will start the Telegram bot

// Start server
app.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});

// Optional: auto-start bot
if (process.env.AUTO_START === 'true') {
  startBot();
}

// Self-ping to keep Render alive
cron.schedule('*/9 * * * *', async () => {
  const url = process.env.SELF_URL || `http://http://ec2-13-212-254-222.ap-southeast-1.compute.amazonaws.com/`;
  try {
    await axios.get(url);
    console.log(`🔁 Self-ping sent at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('❌ Self-ping failed:', err.message);
  }
});
