// قواعد تلغرام: ضع القيم في ملف .env الموجود في جذر المشروع.
export const telegram = {
  botToken: process.env.TELEGRAM_BOT_TOKEN?.trim(),
  chatId: process.env.TELEGRAM_CHAT_ID?.trim(),
  apiTimeoutMs: 10000
};
