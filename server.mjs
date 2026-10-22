import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = process.cwd();
const envPath = join(root, ".env");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const rateLimits = new Map();
const requestLimit = 16 * 1024;
const rateLimitWindowMs = 60_000;
const maxRequestsPerWindow = 5;

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8080);

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || origin === "null" || !request.headers.host) return false;

  try {
    const parsedOrigin = new URL(origin);
    return (
      (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
      parsedOrigin.host === request.headers.host
    );
  } catch {
    return false;
  }
}

function allowRequest(request, response) {
  const now = Date.now();
  const key = request.socket.remoteAddress || "unknown";
  const current = rateLimits.get(key);
  const bucket =
    current && now - current.startedAt < rateLimitWindowMs
      ? current
      : { startedAt: now, count: 0 };

  bucket.count += 1;
  rateLimits.set(key, bucket);

  if (bucket.count <= maxRequestsPerWindow) return true;
  sendJson(response, 429, { error: "محاولات كثيرة. يرجى الانتظار ثم المحاولة مجدداً." });
  return false;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > requestLimit) {
      const error = new Error("حجم الطلب أكبر من المسموح");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("بيانات الطلب غير صالحة");
    error.status = 400;
    throw error;
  }
}

function normalizeOrderItems(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).some(
      (key) =>
        ![
          "items",
          "firstName",
          "lastName",
          "phone",
          "country",
          "governorate",
          "area",
          "street",
          "houseDetails",
        ].includes(key)
    ) ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 30
  ) {
    throw new Error("قائمة المنتجات غير صالحة");
  }

  const customerFields = [
    ["firstName", 60],
    ["lastName", 60],
    ["phone", 8],
    ["governorate", 40],
    ["area", 100],
    ["street", 120],
    ["houseDetails", 300],
  ];
  const customer = {};
  for (const [key, maxLength] of customerFields) {
    if (typeof body[key] !== "string") throw new Error("بيانات العميل أو العنوان غير مكتملة");
    const value = body[key].replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!value || value.length > maxLength) throw new Error("بيانات العميل أو العنوان غير صالحة");
    customer[key] = value;
  }

  if (
    body.country !== "KW" ||
    !/^[0-9٠-٩]{8}$/.test(customer.phone) ||
    !["العاصمة", "حولي", "الفروانية", "مبارك الكبير", "الأحمدي", "الجهراء"].includes(
      customer.governorate
    )
  ) {
    throw new Error("رقم الجوال أو عنوان التوصيل في الكويت غير صالح");
  }

  let total = 0;
  const items = body.items.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some(
        (key) =>
          !["id", "title", "brand", "category", "price", "quantity", "oldPrice", "discount", "image"].includes(
            key
          )
      ) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.brand !== "string" ||
      !["chicken", "beef"].includes(item.category) ||
      !Number.isFinite(item.price) ||
      item.price < 0 ||
      item.price > 10_000 ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99
    ) {
      throw new Error("بيانات أحد المنتجات غير صالحة");
    }

    const title = item.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    const brand = item.brand.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!title || title.length > 120 || !brand || brand.length > 60) {
      throw new Error("اسم أحد المنتجات غير صالح");
    }

    const price = Math.round(item.price * 1000) / 1000;
    total += price * item.quantity;
    return { title, brand, price, quantity: item.quantity };
  });

  total = Math.round(total * 1000) / 1000;
  if (!Number.isFinite(total) || total > 100_000) {
    throw new Error("إجمالي الطلب غير صالح");
  }

  return { customer, items, total };
}

async function sendOrderSummary(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || token.includes("replace-with-")) {
    const error = new Error("إعدادات تيليجرام غير مكتملة على الخادم");
    error.status = 503;
    throw error;
  }

  const orderId = randomBytes(5).toString("hex").toUpperCase();
  const lines = [
    `طلب متجر جديد #${orderId}`,
    `الاسم: ${order.customer.firstName} ${order.customer.lastName}`,
    `الجوال: ${order.customer.phone}`,
    `الدولة: الكويت`,
    `المحافظة: ${order.customer.governorate}`,
    `المنطقة: ${order.customer.area}`,
    `الشارع: ${order.customer.street}`,
    `وصف المنزل: ${order.customer.houseDetails}`,
    "───────────────",
    ...order.items.map(
      (item) =>
        `- ${item.brand} ${item.title} × ${item.quantity}: KWD ${(item.price * item.quantity).toFixed(3)}`
    ),
    `الإجمالي: KWD ${order.total.toFixed(3)}`,
  ];
  if (lines.join("\n").length > 3_900) {
    const error = new Error("تفاصيل الطلب أطول من الحد المسموح لإشعار تيليجرام");
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ chat_id: chatId, text: lines.join("\n") }),
    });

    let result;
    try {
      result = await telegramResponse.json();
    } catch {
      const error = new Error("تعذر قراءة نتيجة إرسال إشعار الطلب");
      error.status = 502;
      throw error;
    }
    if (!telegramResponse.ok || !result.ok) {
      const error = new Error("تعذر إرسال إشعار الطلب إلى تيليجرام");
      error.status = 502;
      throw error;
    }
  } catch (error) {
    if (!error.status) error.status = 502;
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return orderId;
}

async function handleOrder(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "طريقة الطلب غير مدعومة" });
    return;
  }

  if (!isSameOrigin(request)) {
    sendJson(response, 403, { error: "مصدر الطلب غير مسموح" });
    return;
  }

  if (!allowRequest(request, response)) return;

  if (!request.headers["content-type"]?.startsWith("application/json")) {
    sendJson(response, 415, { error: "نوع بيانات الطلب غير مدعوم" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const order = normalizeOrderItems(body);
    const orderId = await sendOrderSummary(order);
    sendJson(response, 200, { ok: true, orderId });
  } catch (error) {
    const status = error.status || 400;
    if (status >= 500) console.error("Order notification failed.");
    sendJson(response, status, {
      error: status >= 500 ? "تعذر إرسال الإشعار. لم يتم تأكيد الطلب." : error.message,
    });
  }
}

function serveStaticFile(pathname, response, headOnly = false) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  const segments = decoded.replace(/^\/+/, "").split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment.startsWith(".") ||
        ["server.mjs", "package.json"].includes(segment.toLowerCase())
    )
  ) {
    response.writeHead(404).end("Not found");
    return;
  }

  const filePath = resolve(root, normalize(segments.join(sep)));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    if (!statSync(filePath).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
  } catch {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": mimeTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (pathname === "/api/orders") {
    void handleOrder(request, response);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }

  if (pathname === "/step1.html") {
    response.writeHead(302, {
      "Cache-Control": "no-store",
      Location: "/",
    }).end();
    return;
  }

  const staticPath = pathname === "/" ? "/index.html" : pathname;
  serveStaticFile(staticPath, response, request.method === "HEAD");
});

server.listen(port, host, () => {
  console.log(`Store server listening at http://${host}:${port}`);
});
