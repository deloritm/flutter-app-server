const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid'); // برای تولید unique ID

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

// Set webhook دستی بعد از deploy
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

// Webhook endpoint برای تلگرام
app.post('/webhook', async (req, res) => {
  try {
    // چک می‌کنیم که درخواست تکراری نباشه
    const updateId = req.body.update_id;
    const processedKey = `processed_update_${updateId}`;
    const alreadyProcessed = await redis.get(processedKey);
    if (alreadyProcessed) {
      console.log(`Duplicate update_id ${updateId}, ignoring`);
      return res.sendStatus(200);
    }
    await redis.setex(processedKey, 3600, 'true'); // 1 ساعت ذخیره
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
    await bot.sendMessage(ADMIN_CHAT_ID, 
      '*سلام ادمین! 👋*\nاین ربات برای مدیریت درخواست‌های اپلیکیشن است.\n- درخواست‌ها رو اینجا می‌بینی.\n- با دکمه‌های *تأیید* یا *رد* پاسخ بده و توضیحات رو بنویس.',
      { parse_mode: 'Markdown' }
    );
  }
});

// Handle callback_query (دکمه‌های تأیید/رد)
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
  if (parts.length !== 4) { // اضافه کردن requestId
    bot.answerCallbackQuery(callbackQueryId, { text: 'خطای داخلی: ساختار داده نادرست' });
    return;
  }

  const action = parts[0];
  const nationalCode = parts[1];
  const license = parts[2];
  const requestId = parts[3];

  // چک می‌کنیم که callback قبلاً پردازش نشده باشه
  const callbackKey = `callback_${requestId}_${nationalCode}_${license}`;
  const alreadyProcessed = await redis.get(callbackKey);
  if (alreadyProcessed) {
    bot.answerCallbackQuery(callbackQueryId, { text: 'این درخواست قبلاً پردازش شده است.' });
    return;
  }

  // ذخیره pending action با requestId
  const pendingKey = `pending_${requestId}_${nationalCode}_${license}`;
  await redis.setex(pendingKey, 3600, JSON.stringify({ action, chatId, messageId })); // 1 ساعت مهلت برای توضیحات
  console.log(`Stored pending action: key=${pendingKey}, action=${action}`);

  // غیرفعال کردن دکمه‌ها برای جلوگیری از کلیک دوباره
  await bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    { chat_id: chatId, message_id: messageId }
  );

  // درخواست توضیحات
  await bot.sendMessage(
    chatId,
    `لطفاً توضیحات برای *${action === 'accept' ? 'تأیید' : 'رد'}* درخواست (ID: ${requestId}) را وارد کنید:`,
    { parse_mode: 'Markdown' }
  );

  // پاسخ به callback
  await bot.answerCallbackQuery(callbackQueryId, {
    text: `درخواست برای ${action === 'accept' ? 'تأیید' : 'رد'} ثبت شد.`
  });

  // علامت‌گذاری callback به‌عنوان پردازش‌شده
  await redis.setex(callbackKey, 3600 * 24, 'true'); // 24 ساعت ذخیره
});

// Handle پیام‌های متنی از ادمین
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID || !msg.text || msg.text.startsWith('/')) return;

  console.log(`Received message from admin: ${msg.text}`);

  // چک pending actions
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
        ? `*درخواست تأیید شد* ✅\n*ID درخواست*: ${requestId}\n*توضیحات*: ${msg.text}`
        : `*درخواست رد شد* ❌\n*ID درخواست*: ${requestId}\n*توضیحات*: ${msg.text}`;

      const responseKey = `response_${nationalCode}_${license}`;
      await redis.setex(responseKey, 3600 * 24 * 7, responseMessage); // ذخیره 7 روز
      await redis.del(key); // پاک کردن pending
      console.log(`Stored response: key=${responseKey}, message=${responseMessage}`);

      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `پاسخ ثبت شد:\n${responseMessage}`,
        { parse_mode: 'Markdown' }
      );

      return; // فقط اولین pending رو پردازش کن
    }
  }
  console.log('No pending action found for text message');
});

// Endpoint برای اعتبارسنجی لایسنس
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

// Endpoint برای ارسال فرم
app.post('/submit-form', async (req, res) => {
  const { name, minAge, maxAge, nationalCode, description, license } = req.body;
  console.log(`Received form: name=${name}, nationalCode=${nationalCode}, license=${license}`);

  const licenseData = USERS[license];
  if (!licenseData || !licenseData.valid) {
    console.log(`Invalid license: ${license}`);
    return res.json({ success: false, message: 'لایسنس نامعتبر است' });
  }

  const requestId = uuidv4(); // تولید unique ID برای درخواست
  const nationalCodeText = nationalCode === '0' ? 'ندارد' : nationalCode;
  const descriptionText = description && description !== 'ندارد' ? description : 'ندارد';
  const text = `*درخواست جدید* 📬\n*نام*: ${name}\n*سن*: ${minAge} تا ${maxAge}\n*کد ملی*: ${nationalCodeText}\n*توضیحات*: ${descriptionText}\n*لایسنس*: ${license}\n*ID درخواست*: ${requestId}`;

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

// Endpoint برای بررسی پاسخ
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

// Endpoint برای پاک کردن پیام‌های قبلی
app.post('/clear-messages', async (req, res) => {
  const { nationalCode, license } = req.body;
  const responseKey = `response_${nationalCode}_${license}`;
  console.log(`Clearing messages: key=${responseKey}`);
  await redis.del(responseKey);
  res.json({ success: true });
});

// پاسخ برای ریشه، برای رفع ارور Cannot GET /
app.get('/', (req, res) => {
  res.send('Server is running');
});
app.get('/test-redis', async (req, res) => {
  try {
    await redis.set('test_key', 'test_value');
    const value = await redis.get('test_key');
    res.send(`Redis test: ${value}`);
  } catch (err) {
    res.status(500).send(`Redis error: ${err}`);
  }
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
