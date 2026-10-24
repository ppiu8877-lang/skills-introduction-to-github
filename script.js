const cartButton = document.querySelector(".cart-button");
const cartCount = document.querySelector(".cart-count");
const cartStorageKey = "poultry-cart";

const readCart = () => {
  try {
    const cart = JSON.parse(localStorage.getItem(cartStorageKey) || "[]");
    return Array.isArray(cart)
      ? cart.filter((item) => item && item.name && Number.isFinite(Number(item.price)) && Number(item.price) >= 0)
        .map((item) => ({ ...item, price: Number(item.price), quantity: Math.max(1, Number(item.quantity) || 1) }))
      : [];
  } catch {
    return [];
  }
};

const updateCartBadge = () => {
  const cartItems = readCart().reduce((total, item) => total + Number(item.quantity || 0), 0);
  if (cartCount) {
    cartCount.textContent = cartItems;
    cartCount.style.display = cartItems > 0 ? "grid" : "none";
  }
};

const notifyVisitor = async () => {
  const visitorKey = "poultry-visitor-seen";
  const returning = localStorage.getItem(visitorKey) === "true";
  localStorage.setItem("poultry-source-page", JSON.stringify({
    name: document.title,
    url: window.location.href
  }));
  try {
    const response = await fetch("/api/visitors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: returning ? "returning" : "new" })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      throw new Error(result?.error || "تعذر تسجيل الزيارة");
    }
    localStorage.setItem(visitorKey, "true");
  } catch (error) {
    console.error("تعذر تسجيل الزيارة:", error);
  }
};

document.querySelectorAll(".order-button").forEach((button) => {
  button.addEventListener("click", () => {
    const card = button.closest(".product-card");
    if (!card) return;
    const nameElement = card.querySelector("h3");
    const priceElement = card.querySelector(".price strong");
    if (!nameElement || !priceElement) return;
    const name = nameElement.textContent.trim();
    const price = Number(priceElement.textContent.replace(/[^\d.]/g, ""));
    if (!name || !Number.isFinite(price)) return;
    const quantityElement = card.querySelector(".quantity span");
    const quantity = quantityElement ? Math.max(1, Number(quantityElement.textContent)) : 1;
    const cart = readCart();
    const existing = cart.find((item) => item.name === name);
    if (existing) existing.quantity += quantity;
    else cart.push({ name, price, quantity, icon: card.classList.contains("fish-card") ? "🐟" : card.classList.contains("meat-card") ? "🥩" : "🍗" });
    localStorage.setItem(cartStorageKey, JSON.stringify(cart));
    updateCartBadge();
    window.location.href = "checkout.html";
  });
});

document.querySelectorAll(".quantity").forEach((quantity) => {
  const value = quantity.querySelector("span");
  const increaseButton = quantity.querySelector("button:first-child");
  const decreaseButton = quantity.querySelector("button:last-child");
  if (!value || !increaseButton || !decreaseButton) return;
  increaseButton.addEventListener("click", () => {
    value.textContent = Number(value.textContent) + 1;
  });
  decreaseButton.addEventListener("click", () => {
    value.textContent = Math.max(1, Number(value.textContent) - 1);
  });
});

if (cartButton) {
  cartButton.addEventListener("click", () => {
    window.location.href = "checkout.html";
  });
}

document.querySelector("[data-language-toggle]")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  const isArabic = document.documentElement.lang === "ar";
  document.documentElement.lang = isArabic ? "en" : "ar";
  document.documentElement.dir = isArabic ? "ltr" : "rtl";
  button.querySelector("span").textContent = isArabic ? "English" : "العربية";
});

updateCartBadge();
notifyVisitor();
