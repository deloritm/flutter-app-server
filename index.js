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

// Webhook endpoint - پاسخ فوری و پردازش async
app.post('/webhook', (req, res) => {
  res.sendStatus(200); // فوری 200 بفرست تا Telegram timeout نکنه
  // پردازش update رو async کن
  setImmediate(() => {
    try {
      bot.processUpdate(req.body);
    } catch (err) {
      console.error(`Error processing update: ${err}`);
    }
  });
});

// خوش‌آمدگویی به ادمین
bot.onText(/\/start/, async (msg) => {
  if (msg.chat.id.toString() === ADMIN_CHAT_ID) {
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      '*سلام ادمین! 👋*\nاین ربات درخواست‌های کاربران را نمایش می‌دهد.\n1. درخواست را بررسی کنید.\n2. پاسخ خود را بنویسید.',
      { parse_mode: 'Markdown' }
    );
  }
});

// Handle پیام‌های متنی از ادمین - ذخیره پاسخ
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID || !msg.text || msg.text.startsWith('/')) return;

  console.log(`Received message from admin: ${msg.text}`);

  const keys = await redis.keys('pending_*');
  if (keys.length === 0) {
    await bot.sendMessage(ADMIN_CHAT_ID, 'هیچ درخواست در انتظاری وجود ندارد.');
    return;
  }

  for (const key of keys) {
    const pendingData = JSON.parse(await redis.get(key));
    if (pendingData && pendingData.chatId.toString() === ADMIN_CHAT_ID) {
      const parts = key.split('_').slice(1);
      const requestId = parts[0];
      const nationalCode = parts[1];
      const license = parts[2];

      const responseMessage = msg.text; // پاسخ مستقیم ادمین

      const responseKey = `response_${nationalCode}_${license}`;
      try {
        await redis.setex(responseKey, 3600 * 24 * 7, responseMessage);
        await redis.del(key);
        console.log(`Stored response: key=${responseKey}, message=${responseMessage}`);

        await bot.sendMessage(
          ADMIN_CHAT_ID,
          `*پاسخ توسط کاربر مشاهده شد* ✅\n*توضیحات*: ${msg.text}`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error(`Error storing response: ${err}`);
        await bot.sendMessage(ADMIN_CHAT_ID, 'خطا در ثبت پاسخ. لطفاً دوباره امتحان کنید.');
      }
      return;
    }
  }
  await bot.sendMessage(ADMIN_CHAT_ID, 'هیچ درخواست در انتظاری برای این چت یافت نشد.');
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

  const pendingKey = `pending_${requestId}_${nationalCode}_${license}`;

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'Markdown' });
    await redis.setex(pendingKey, 3600, JSON.stringify({ chatId: ADMIN_CHAT_ID }));
    await bot.sendMessage(
      ADMIN_CHAT_ID,
      'لطفاً پاسخ خود را وارد کنید:',
      { parse_mode: 'Markdown' }
    );
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
