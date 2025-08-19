const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Environment variables from Vercel
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const REDIS_URL = process.env.REDIS_URL;

const bot = new TelegramBot(BOT_TOKEN);
const redis = new Redis(REDIS_URL);

// Hardcoded license validation
const USERS = {
  '123': { valid: true, name: 'محمد' },
  '456': { valid: true, name: 'علی' },
  '789': { valid: true, name: 'زهرا' }
};

// Set webhook manually after deploy
app.get('/set-webhook', async (req, res) => {
  const webhookUrl = `https://${req.headers.host}/webhook`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`Webhook set to ${webhookUrl}`);
    res.send('Webhook set successfully');
  } catch (err) {
    console.error(`Failed to set webhook: ${err}`);
    res.status(500).send('Failed to set webhook');
  }
});

// Webhook endpoint for Telegram
app.post('/webhook', (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error(`Webhook error: ${err}`);
    res.sendStatus(500);
  }
});

// Handle Telegram callback_query (accept/reject buttons)
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const callbackQueryId = callbackQuery.id;

  console.log(`Received callback: data=${data}, chat_id=${chatId}`);

  if (!data) {
    bot.answerCallbackQuery(callbackQueryId, { text: 'خطای داخلی: داده‌ای دریافت نشد' });
    return;
  }

  const parts = data.split('_');
  if (parts.length !== 3) {
    bot.answerCallbackQuery(callbackQueryId, { text: 'خطای داخلی: ساختار داده نادرست' });
    return;
  }

  const action = parts[0];
  const nationalCode = parts[1];
  const license = parts[2];

  // Store pending action in Redis
  const pendingKey = `pending_${nationalCode}_${license}`;
  await redis.set(pendingKey, JSON.stringify({ action, chatId }));
  console.log(`Stored pending action: key=${pendingKey}, action=${action}`);

  // Ask admin for explanation
  bot.sendMessage(chatId, `لطفاً توضیحات برای ${action === 'accept' ? 'تأیید' : 'رد'} درخواست را وارد کنید:`);

  // Answer callback
  bot.answerCallbackQuery(callbackQueryId, {
    text: `درخواست برای ${action === 'accept' ? 'تأیید' : 'رد'} ثبت شد.`
  });
});

// Handle text messages from admin
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID || !msg.text) return;

  console.log(`Received message from admin: ${msg.text}`);

  // Check for pending actions in Redis
  const keys = await redis.keys('pending_*');
  for (const key of keys) {
    const pendingData = JSON.parse(await redis.get(key));
    if (pendingData && pendingData.chatId.toString() === ADMIN_CHAT_ID) {
      const parts = key.split('_').slice(1);
      const nationalCode = parts[0];
      const license = parts[1];
      const action = pendingData.action;

      const responseMessage = action === 'accept'
        ? `درخواست شما تایید شد\nتوضیحات: ${msg.text}`
        : `درخواست شما رد شد\nتوضیحات: ${msg.text}`;

      const responseKey = `response_${nationalCode}_${license}`;
      await redis.set(responseKey, responseMessage);
      await redis.del(key);
      console.log(`Stored response: key=${responseKey}, message=${responseMessage}`);

      bot.sendMessage(ADMIN_CHAT_ID, `پاسخ ثبت شد: ${responseMessage}`);
      return;
    }
  }
  console.log('No pending action found for text message');
});

// Endpoint for license validation
app.post('/validate-license', (req, res) => {
  const { license } = req.body;
  console.log(`Validating license: ${license}`);
  const licenseData = USERS[license];
  if (licenseData && licenseData.valid) {
    res.json({ success: true, name: licenseData.name || 'کاربر' });
  } else {
    res.json({ success: false, message: 'لایسنس نامعتبر است' });
  }
});

// Endpoint for form submission
app.post('/submit-form', async (req, res) => {
  const { name, minAge, maxAge, nationalCode, description, license } = req.body;
  console.log(`Received form: name=${name}, nationalCode=${nationalCode}, license=${license}`);

  const licenseData = USERS[license];
  if (!licenseData || !licenseData.valid) {
    console.log(`Invalid license: ${license}`);
    return res.json({ success: false, message: 'لایسنس نامعتبر است' });
  }

  const nationalCodeText = nationalCode === '0' ? 'ندارد' : nationalCode;
  const descriptionText = description && description !== 'ندارد' ? description : 'ندارد';
  const text = `درخواست جدید:\nنام: ${name}\nسن: ${minAge} تا ${maxAge}\nکد ملی: ${nationalCodeText}\nتوضیحات: ${descriptionText}\nلایسنس: ${license}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: 'تأیید', callback_data: `accept_${nationalCode}_${license}` },
        { text: 'رد', callback_data: `reject_${nationalCode}_${license}` }
      ]
    ]
  };

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, text, { reply_markup: replyMarkup });
    console.log(`Form sent to Telegram: chat_id=${ADMIN_CHAT_ID}`);
    res.json({ success: true, message: 'اطلاعات ارسال شد، منتظر تأیید باشید' });
  } catch (err) {
    console.error(`Failed to send to Telegram: ${err}`);
    res.json({ success: false, message: 'خطا در ارسال به تلگرام' });
  }
});

// Endpoint for checking response
app.post('/check-response', async (req, res) => {
  const { nationalCode, license } = req.body;
  const responseKey = `response_${nationalCode}_${license}`;
  console.log(`Checking response: key=${responseKey}`);
  const message = await redis.get(responseKey);
  if (message) {
    res.json({ success: true, message });
  } else {
    res.json({ success: false, message: 'هنوز پاسخی یافت نشد' });
  }
});

// Endpoint for clearing previous messages
app.post('/clear-messages', async (req, res) => {
  const { nationalCode, license } = req.body;
  const responseKey = `response_${nationalCode}_${license}`;
  console.log(`Clearing messages: key=${responseKey}`);
  await redis.del(responseKey);
  res.json({ success: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));