import http from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(root, "public");
const envFile = join(root, ".env");

try {
  const env = await readFile(envFile, "utf8");
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const telegram = {
  botToken: process.env.TELEGRAM_BOT_TOKEN?.trim(),
  chatId: process.env.TELEGRAM_CHAT_ID?.trim(),
  apiTimeoutMs: 10000
};
const port = Number(process.env.PORT || 3000);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
class ValidationError extends Error {}

const sendTelegramMessage = async (text) => {
  if (!telegram.botToken || !telegram.chatId) throw new Error("إعدادات تلغرام ناقصة");
  const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: telegram.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(telegram.apiTimeoutMs)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.description || `Telegram status ${response.status}`);
};

const sendOrderToTelegram = async (order) => {
  if (!telegram.botToken || !telegram.chatId) throw new Error("إعدادات تلغرام ناقصة");
  const items = order.items.map((item) => `• ${item.name} × ${item.quantity} = ${(item.price * item.quantity).toFixed(3)} د.ك`).join("\n");
  const text = [
    "🛒 طلب جديد - دواجن الوطنية",
    "",
    `👤 الاسم: ${order.customer.name}`,
    `📱 الجوال: ${order.customer.phone}`,
    `📄 الصفحة: ${order.sourcePage || order.customer.sourcePage || "غير معروف"}`,
    `📍 العنوان: ${order.customer.governorate}، ${order.customer.area}، قطعة ${order.customer.block}، شارع ${order.customer.street}، منزل ${order.customer.house}`,
    `🏠 الدور/الشقة: ${order.customer.unit || "غير محدد"}`,
    "",
    "المنتجات:",
    items,
    "",
    `📦 عدد القطع: ${order.totalItems}`,
    `💰 الإجمالي: ${Number(order.total).toFixed(3)} د.ك`,
    `💳 الدفع: ${order.paymentMethod === "mastercard" ? "Mastercard" : "KNET"}`
  ].join("\n");
  await sendTelegramMessage(text);
};

const sendVisitorToTelegram = async (request, type) => {
  const forwarded = request.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
  const country = !ip || ip === "127.0.0.1" || ip === "::1" ? "الكويت" : "غير معروف";
  await sendTelegramMessage([
    type === "new" ? "🟢 زائر جديد - الصفحة الرئيسية" : "🔵 زائر قديم - الصفحة الرئيسية",
    `🌍 الدولة: ${country}`,
    `🕒 الوقت: ${new Date().toLocaleString("ar-KW", { timeZone: "Asia/Kuwait" })}`
  ].join("\n"));
};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
    if (request.method === "POST" && pathname === "/api/visitors") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const visitor = JSON.parse(body || "{}");
      if (!["new", "returning"].includes(visitor.type)) throw new ValidationError("نوع الزائر غير صالح");
      await sendVisitorToTelegram(request, visitor.type);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && pathname === "/api/orders") {
      let body = "";
      for await (const chunk of request) body += chunk;
      await sendOrderToTelegram(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Method Not Allowed");
      return;
    }
    const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    let filePath = normalize(join(publicRoot, requested));
    if (relative(publicRoot, filePath).startsWith("..")) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    try {
      await access(filePath);
    } catch {
      filePath = normalize(join(root, requested));
      if (relative(root, filePath).startsWith("..")) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      try {
        await access(filePath);
      } catch {
        response.writeHead(404);
        response.end("Not Found");
        return;
      }
    }
    response.writeHead(200, { "content-type": contentTypes[extname(filePath)] || "application/octet-stream" });
    response.end(await readFile(filePath));
  } catch (error) {
    response.writeHead(error instanceof SyntaxError || error instanceof ValidationError ? 400 : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(port, () => {
  console.log(`Poultry store running at http://localhost:${port}`);
  if (!telegram.botToken || !telegram.chatId) console.warn("Telegram notifications disabled: configure .env");
});
