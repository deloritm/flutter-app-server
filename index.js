const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

// Environment variables از Vercel
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

// Set webhook دستی
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

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const updateId = req.body.update_id;
    const processedKey = `processed_update_${updateId}`;
    const alreadyProcessed = await redis.get(processedKey);
    if (alreadyProcessed) {
      console.log(`Duplicate update_id ${updateId}, ignoring`);
      return res.sendStatus(200);
    }
    await redis.setex(processedKey, 3600, 'true');
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error(`Webhook error: ${err}`);
    res.sendStatus(500);
  }
});

// خوش‌آمدگویی به ادمین
bot.onText(/\/start/, async (msg) => {
  if (msg.chat.id.toString() === ADMIN_CHAT_ID) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      '*سلام ادمین! 👋*\nاین ربات درخواست‌های کاربران را نمایش می‌دهد.\n1. درخواست را بررسی کنید.\n2. با دکمه‌های *تأیید* یا *رد* پاسخ دهید.\n3. توضیحات خود را بنویسید.',
      { parse_mode: 'Markdown' }
    );
  }
});

// Handle callback_query
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const callbackQueryId = callbackQuery.id;
  const messageId = callbackQuery.message.message_id;

  console.log(`Received callback: data=${data}, chat_id=${chatId}`);

  if (!data || chatId.toString() !== ADMIN_CHAT_ID) {
    bot.answerCallbackQuery(callbackQueryId, { text: 'خطای داخلی: داده نامعتبر یا دسترسی غیرمجاز' });
    return;
  }

  const parts = data.split('_');
  if (parts.length !== 4) {
    bot.answerCallbackQuery(callbackQueryId, { text: 'خطای داخلی: ساختار داده نادرست' });
    return;
  }

  const action = parts[0];
  const nationalCode = parts[1];
  const license = parts[2];
  const requestId = parts[3];

  const callbackKey = `callback_${requestId}_${nationalCode}_${license}`;
  const alreadyProcessed = await redis.get(callbackKey);
  if (alreadyProcessed) {
    bot.answerCallbackQuery(callbackQueryId, { text: 'این درخواست قبلاً پردازش شده است.' });
    return;
  }

  const pendingKey = `pending_${requestId}_${nationalCode}_${license}`;
  await redis.setex(pendingKey, 3600, JSON.stringify({ action, chatId, messageId }));
  console.log(`Stored pending action: key=${pendingKey}, action=${action}`);

  await bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    { chat_id: chatId, message_id: messageId }
  );

  await bot.sendMessage(
    chatId,
    `لطفاً توضیحات برای *${action === 'accept' ? 'تأیید' : 'رد'}* درخواست را وارد کنید:`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, {
    text: `درخواست برای ${action === 'accept' ? 'تأیید' : 'رد'} ثبت شد.`
  });

  await redis.setex(callbackKey, 3600 * 24, 'true');
});

// Handle پیام‌های متنی از ادمین
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID || !msg.text || msg.text.startsWith('/')) return;

  console.log(`Received message from admin: ${msg.text}`);

  const keys = await redis.keys('pending_*');
  for (const key of keys) {
    const pendingData = JSON.parse(await redis.get(key));
    if (pendingData && pendingData.chatId.toString() === ADMIN_CHAT_ID) {
      const parts = key.split('_').slice(1);
      const requestId = parts[0];
      const nationalCode = parts[1];
      const license = parts[2];
      const action = pendingData.action;

      const responseMessage = action === 'accept'
        ? `درخواست تأیید شد\nپاسخ: ${msg.text}`
        : `درخواست رد شد\nپاسخ: ${msg.text}`;

      const responseKey = `response_${nationalCode}_${license}`;
      await redis.setex(responseKey, 3600 * 24 * 7, responseMessage);
      await redis.del(key);
      console.log(`Stored response: key=${responseKey}, message=${responseMessage}`);

      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `*پاسخ ثبت شد* ✅\nپاسخ شما برای درخواست کاربر ذخیره شد و برای کاربر قابل مشاهده است.\n*وضعیت*: ${action === 'accept' ? 'تأیید' : 'رد'}\n*توضیحات*: ${msg.text}`,
        { parse_mode: 'Markdown' }
      );

      return;
    }
  }
  console.log('No pending action found for text message');
});

// اعتبارسنجی لایسنس
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

// ارسال فرم
app.post('/submit-form', async (req, res) => {
  const { name, minAge, maxAge, nationalCode, description, license } = req.body;
  console.log(`Received form: name=${name}, nationalCode=${nationalCode}, license=${license}`);

  const licenseData = USERS[license];
  if (!licenseData || !licenseData.valid) {
    console.log(`Invalid license: ${license}`);
    return res.json({ success: false, message: 'لایسنس نامعتبر است' });
  }

  const requestId = uuidv4();
  const nationalCodeText = nationalCode === '0' ? 'ندارد' : nationalCode;
  const descriptionText = description && description !== 'ندارد' ? description : 'ندارد';
  const text = `*درخواست جدید* 📬\n*نام*: ${name}\n*سن*: ${minAge} تا ${maxAge}\n*کد ملی*: ${nationalCodeText}\n*توضیحات*: ${descriptionText}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '✅ تأیید', callback_data: `accept_${nationalCode}_${license}_${requestId}` },
        { text: '❌ رد', callback_data: `reject_${nationalCode}_${license}_${requestId}` }
      ]
    ]
  };

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'Markdown', reply_markup: replyMarkup });
    console.log(`Form sent to Telegram: chat_id=${ADMIN_CHAT_ID}, requestId=${requestId}`);
    res.json({ success: true, message: 'اطلاعات ارسال شد، منتظر تأیید باشید' });
  } catch (err) {
    console.error(`Failed to send to Telegram: ${err}`);
    res.json({ success: false, message: 'خطا در ارسال به تلگرام' });
  }
});

// بررسی پاسخ
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

// پاک کردن پیام‌های قبلی
app.post('/clear-messages', async (req, res) => {
  const { nationalCode, license } = req.body;
  const responseKey = `response_${nationalCode}_${license}`;
  console.log(`Clearing messages: key=${responseKey}`);
  await redis.del(responseKey);
  res.json({ success: true });
});

// پاسخ برای ریشه
app.get('/', (req, res) => {
  res.send('Server is running');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
