import { randomBytes } from "node:crypto";

export function normalizeOrderItems(body) {
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

export async function sendOrderSummary(order) {
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
