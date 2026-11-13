"use strict";

/* ================= CONFIG ================= */
const SUPABASE_URL = "https://azrrxnubhactuxcqquzp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6cnJ4bnViaGFjdHV4Y3FxdXpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyNzkzNDYsImV4cCI6MjEwOTg1NTM0Nn0.BO_jkso1GFRY9oyOd7apsmP0y11yjff8CJfE6Dx-9c4";

const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ================= utils ================= */
const rp = (n) => "Rp" + Math.round(n || 0).toLocaleString("id-ID");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
const JKT_TZ = "Asia/Jakarta";
const dayKey = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: JKT_TZ });
const fmtDateTime = (iso) => new Date(iso).toLocaleString("id-ID", { timeZone: JKT_TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const todayKey = () => dayKey(new Date().toISOString());
const DOW = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function waLink(phone, text) {
  let d = (phone || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1);
  if (!d.startsWith("62") && d.length > 0) d = "62" + d;
  return "https://wa.me/" + d + "?text=" + encodeURIComponent(text);
}
function errMsg(err) {
  if (!err) return "Terjadi kesalahan";
  const m = err.message || String(err);
  if (m.startsWith("OVER_LIMIT:")) return "Melebihi batas utang";
  return m;
}
function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch (e) { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

/* ================= state ================= */
const state = {
  phase: "loading", // loading | login | onboarding | app
  session: null,
  storeId: null, storeName: "", role: null,
  categories: [], products: [], customers: [], debts: [], sales: [],
  tab: lsGet("warungku.tab", "kasir"),
  cart: [], cartDiscount: 0,
  kasirQuery: "", kasirCategory: "all",
  laporanPeriod: "today",
  loading: false,
};

/* ================= boot / auth ================= */
async function boot() {
  const { data: { session } } = await supa.auth.getSession();
  state.session = session;
  supa.auth.onAuthStateChange((_event, sess) => {
    const changed = (sess && sess.user && sess.user.id) !== (state.session && state.session.user && state.session.user.id);
    state.session = sess;
    if (changed) { afterAuthChange(); }
  });
  await afterAuthChange();
}
async function afterAuthChange() {
  if (!state.session) { state.phase = "login"; render(); return; }
  state.phase = "loading"; render();
  try {
    const { data: members, error } = await supa.from("store_members")
      .select("store_id, role, is_active, stores(name)")
      .eq("user_id", state.session.user.id).eq("is_active", true).limit(1);
    if (error) throw error;
    if (!members || members.length === 0) { state.phase = "onboarding"; render(); return; }
    state.storeId = members[0].store_id;
    state.role = members[0].role;
    state.storeName = (members[0].stores && members[0].stores.name) || "";
    document.getElementById("storeNameLabel").textContent = state.storeName || "WarungKu";
    state.phase = "app";
    await loadAll();
    startPolling();
  } catch (e) {
    toast("Gagal memuat akun: " + errMsg(e));
    state.phase = "login";
    render();
  }
}
let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (state.phase === "app" && !document.hidden) loadAll(true); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.phase === "app") loadAll(true); });
}

/* ================= data loading ================= */
async function loadAll(silent) {
  if (!state.storeId) return;
  if (!silent) { state.loading = true; render(); }
  try {
    const [catsR, prodR, costR, custR, debtR, salesR] = await Promise.all([
      supa.from("categories").select("*").eq("store_id", state.storeId),
      supa.from("products").select("*").eq("store_id", state.storeId),
      supa.from("product_costs").select("product_id, cost_price").eq("store_id", state.storeId),
      supa.from("customers").select("*").eq("store_id", state.storeId),
      supa.from("debt_ledger").select("*").eq("store_id", state.storeId).order("created_at", { ascending: false }).limit(1000),
      supa.from("sales").select("id, subtotal, discount, total, method, status, customer_id, created_at, sale_items(id, product_id, name_snapshot, qty, unit_price, discount, sale_item_costs(unit_cost))")
        .eq("store_id", state.storeId).order("created_at", { ascending: false }).limit(500),
    ]);
    for (const r of [catsR, prodR, costR, custR, debtR, salesR]) if (r.error) throw r.error;

    const costMap = {};
    (costR.data || []).forEach((c) => { costMap[c.product_id] = c.cost_price; });

    state.categories = (catsR.data || []).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name, "id"));
    state.products = (prodR.data || []).map((p) => ({
      id: p.id, categoryId: p.category_id, name: p.name, barcode: p.barcode, unit: p.unit,
      sellPrice: Number(p.sell_price), costPrice: Number(costMap[p.id] || 0),
      stock: Number(p.stock), minStock: Number(p.min_stock), isActive: p.is_active,
    }));
    state.customers = (custR.data || []).map((c) => ({ id: c.id, name: c.name, phone: c.phone, debtLimit: Number(c.debt_limit) })).sort((a, b) => a.name.localeCompare(b.name, "id"));
    state.debts = (debtR.data || []).map((d) => ({ id: d.id, customerId: d.customer_id, kind: d.kind, amount: Number(d.amount), note: d.note, createdAt: d.created_at }));
    state.sales = (salesR.data || []).map((s) => ({
      id: s.id, total: Number(s.total), discount: Number(s.discount), method: s.method, status: s.status,
      customerId: s.customer_id, createdAt: s.created_at,
      items: (s.sale_items || []).map((i) => ({
        productId: i.product_id, name: i.name_snapshot, qty: Number(i.qty), unitPrice: Number(i.unit_price),
        costPrice: Number((i.sale_item_costs && i.sale_item_costs.unit_cost) || 0),
      })),
    }));
  } catch (e) {
    toast("Gagal memuat data: " + errMsg(e));
  }
  state.loading = false;
  render();
}

/* ================= derived ================= */
function balanceFor(customerId) {
  return state.debts.filter((x) => x.customerId === customerId).reduce((s, x) => s + (x.kind === "debt" ? x.amount : -x.amount), 0);
}
function productById(id) { return state.products.find((p) => p.id === id); }
function lowStockProducts() { return state.products.filter((p) => p.isActive !== false && (p.stock || 0) <= (p.minStock || 0)); }
function isOwner() { return state.role === "owner"; }

/* ================= render shell ================= */
function render() {
  const view = document.getElementById("view");
  const main = document.getElementById("main");
  const tabbar = document.getElementById("tabbar");
  const settingsBtn = document.getElementById("settingsBtn");
  const cartBar = document.getElementById("cartBar");

  if (state.phase === "loading") {
    tabbar.hidden = true; settingsBtn.hidden = true; cartBar.hidden = true;
    main.classList.add("no-pad-bottom");
    view.innerHTML = '<div class="empty">Memuat…</div>';
    return;
  }
  if (state.phase === "login") {
    tabbar.hidden = true; settingsBtn.hidden = true; cartBar.hidden = true;
    main.classList.add("no-pad-bottom");
    document.getElementById("storeNameLabel").textContent = "WarungKu";
    view.innerHTML = renderLogin();
    return;
  }
  if (state.phase === "onboarding") {
    tabbar.hidden = true; settingsBtn.hidden = true; cartBar.hidden = true;
    main.classList.add("no-pad-bottom");
    view.innerHTML = renderOnboarding();
    return;
  }

  tabbar.hidden = false; settingsBtn.hidden = false;
  main.classList.remove("no-pad-bottom");
  document.querySelectorAll("nav.tabbar button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));

  switch (state.tab) {
    case "kasir": view.innerHTML = renderKasir(); afterRenderKasir(); break;
    case "stok": view.innerHTML = renderStok(); break;
    case "utang": view.innerHTML = renderUtang(); break;
    case "laporan": view.innerHTML = renderLaporan(); break;
    default: view.innerHTML = "";
  }
  if (state.tab === "kasir" && state.cart.length > 0) {
    cartBar.hidden = false;
    const qty = state.cart.reduce((s, i) => s + i.qty, 0);
    const total = state.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    document.getElementById("cartCount").textContent = qty;
    document.getElementById("cartSummary").textContent = "Keranjang · " + rp(total);
  } else {
    cartBar.hidden = true;
  }
  const low = lowStockProducts().length;
  const stokBtn = document.querySelector('nav.tabbar button[data-tab="stok"]');
  if (stokBtn) {
    let dot = stokBtn.querySelector(".nav-dot");
    if (low > 0 && !dot) { dot = document.createElement("span"); dot.className = "nav-dot"; stokBtn.appendChild(dot); }
    if (low === 0 && dot) dot.remove();
  }
}

/* ================= LOGIN ================= */
function renderLogin() {
  return `<div class="auth-wrap">
    <div class="auth-logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-6h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/></svg></div>
    <h2 style="text-align:center;margin-bottom:6px">Masuk ke WarungKu</h2>
    <p style="text-align:center;color:var(--muted);margin:0 0 20px">Masukkan email Anda. Kami kirim tautan masuk — tidak perlu password.</p>
    <div class="stack" style="max-width:360px;margin:0 auto;width:100%">
      <label class="field">Email<input type="email" id="loginEmail" placeholder="nama@email.com" autocomplete="email"></label>
      <button class="btn primary" data-action="send-magic-link">Kirim tautan masuk</button>
      <p id="loginStatus" style="text-align:center;color:var(--muted);font-size:13px;margin:0"></p>
    </div>
  </div>`;
}
document.addEventListener("click", async (e) => {
  const btn = e.target.closest('[data-action="send-magic-link"]');
  if (!btn) return;
  const email = document.getElementById("loginEmail").value.trim();
  if (!email) { toast("Isi email dulu"); return; }
  btn.disabled = true; btn.textContent = "Mengirim…";
  try {
    const { error } = await supa.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
    if (error) throw error;
    document.getElementById("loginStatus").textContent = "Tautan terkirim ke " + email + ". Buka email itu lalu ketuk tautannya.";
    btn.textContent = "Kirim ulang";
  } catch (err) {
    toast("Gagal mengirim: " + errMsg(err));
    btn.textContent = "Kirim tautan masuk";
  }
  btn.disabled = false;
});

/* ================= ONBOARDING ================= */
function renderOnboarding() {
  return `<div class="stack" style="margin-top:20px">
    <div class="card stack">
      <h2>Buat warung Anda</h2>
      <p style="color:var(--muted);margin:0">Masukkan nama warung. Bisa diubah lagi lewat Pengaturan.</p>
      <label class="field">Nama warung<input type="text" id="onbName" placeholder="Contoh: Warung Bu Siti" maxlength="60"></label>
      <button class="btn primary" data-action="onboard-save">Mulai</button>
      <button class="btn ghost" data-action="sign-out" style="color:var(--muted)">Keluar</button>
    </div>
  </div>`;
}
document.addEventListener("click", async (e) => {
  const onb = e.target.closest('[data-action="onboard-save"]');
  if (onb) {
    const v = document.getElementById("onbName").value.trim();
    if (!v) { toast("Isi dulu nama warungnya"); return; }
    onb.disabled = true;
    try {
      const { error } = await supa.rpc("create_store", { p_name: v });
      if (error) throw error;
      await afterAuthChange();
    } catch (err) { toast("Gagal membuat warung: " + errMsg(err)); onb.disabled = false; }
  }
  if (e.target.closest('[data-action="sign-out"]')) { await supa.auth.signOut(); }
});

/* ================= KASIR ================= */
function renderKasir() {
  const cats = [{ id: "all", name: "Semua" }, ...state.categories];
  const chips = cats.map((c) => `<button class="chip ${state.kasirCategory === c.id ? "active" : ""}" data-action="kasir-cat" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join("");
  const canScan = !!(window.BarcodeDetector || navigator.mediaDevices);
  return `
    <div class="search-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.3-4.3"></path></svg>
      <input type="text" id="kasirSearch" placeholder="Cari nama barang atau kode" value="${esc(state.kasirQuery)}">
      ${canScan ? `<button class="scan-btn" data-action="open-scan" data-target="kasir" aria-label="Scan barcode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M3 17v2a2 2 0 0 0 2 2h2M21 7V5a2 2 0 0 0-2-2h-2M21 17v2a2 2 0 0 1-2 2h-2M7 12h10"/></svg></button>` : ""}
    </div>
    <div class="chiprow">${chips}</div>
    <div id="productGrid"></div>
  `;
}
function afterRenderKasir() {
  renderProductGrid();
  const input = document.getElementById("kasirSearch");
  if (input) {
    input.addEventListener("input", () => { state.kasirQuery = input.value; renderProductGrid(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const q = input.value.trim();
        const hit = state.products.find((p) => p.barcode && p.barcode === q);
        if (hit) { addToCart(hit); input.value = ""; state.kasirQuery = ""; renderProductGrid(); }
        else if (q) toast("Barang dengan kode itu tidak ditemukan");
      }
    });
  }
}
function filteredProducts() {
  const q = state.kasirQuery.trim().toLowerCase();
  return state.products.filter((p) => {
    if (p.isActive === false) return false;
    if (state.kasirCategory !== "all" && p.categoryId !== state.kasirCategory) return false;
    if (q && !(p.name || "").toLowerCase().includes(q) && !(p.barcode || "").includes(q)) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, "id"));
}
function renderProductGrid() {
  const grid = document.getElementById("productGrid");
  if (!grid) return;
  const list = filteredProducts();
  if (state.products.length === 0) {
    grid.innerHTML = `<div class="empty"><h3 style="margin-bottom:6px">Belum ada barang</h3><p>Tambahkan barang pertama lewat tab Stok.</p></div>`;
    return;
  }
  if (list.length === 0) { grid.innerHTML = `<div class="empty">Tidak ada barang yang cocok.</div>`; return; }
  grid.innerHTML = `<div class="grid-products">` + list.map((p) => {
    const low = (p.stock || 0) <= (p.minStock || 0);
    const initial = (p.name || "?").trim().charAt(0).toUpperCase();
    return `<button class="ptile" data-action="add-cart" data-id="${esc(p.id)}">
      ${low ? '<span class="pill warn lowstock">Menipis</span>' : ""}
      <div class="avatar">${esc(initial)}</div>
      <div class="pname">${esc(p.name)}</div>
      <div class="pprice tabular">${rp(p.sellPrice)}${p.unit ? "/" + esc(p.unit) : ""}</div>
    </button>`;
  }).join("") + `</div>`;
}
function addToCart(p) {
  const existing = state.cart.find((i) => i.productId === p.id);
  if (existing) existing.qty += 1;
  else state.cart.push({ productId: p.id, name: p.name, unit: p.unit || "pcs", qty: 1, unitPrice: p.sellPrice });
  render();
  toast(p.name + " ditambahkan");
}
document.addEventListener("click", (e) => {
  const catBtn = e.target.closest('[data-action="kasir-cat"]');
  if (catBtn) { state.kasirCategory = catBtn.dataset.id; renderProductGrid(); document.querySelectorAll(".chiprow .chip").forEach((c) => c.classList.remove("active")); catBtn.classList.add("active"); return; }
  const addBtn = e.target.closest('[data-action="add-cart"]');
  if (addBtn) { const p = productById(addBtn.dataset.id); if (p) addToCart(p); return; }
  const openCart = e.target.closest('[data-action="open-cart"]');
  if (openCart) { openCartSheet(); return; }
});

function openCartSheet() { renderCartSheet(); openSheet(); }
function renderCartSheet() {
  const subtotal = state.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const rows = state.cart.map((i, idx) => `
    <div class="row" style="padding:10px 0;border-bottom:1px solid var(--line)">
      <div class="grow">
        <div style="font-weight:700">${esc(i.name)}</div>
        <div style="color:var(--muted);font-size:13px" class="tabular">${rp(i.unitPrice)} × ${i.qty}</div>
      </div>
      <div class="row" style="gap:6px">
        <button class="icon-btn" style="width:32px;height:32px" data-action="cart-dec" data-idx="${idx}">−</button>
        <span class="tabular" style="min-width:20px;text-align:center;font-weight:700">${i.qty}</span>
        <button class="icon-btn" style="width:32px;height:32px" data-action="cart-inc" data-idx="${idx}">+</button>
      </div>
      <div class="tabular" style="min-width:76px;text-align:right;font-weight:700">${rp(i.qty * i.unitPrice)}</div>
    </div>`).join("");
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>Keranjang</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body">
      ${state.cart.length === 0 ? '<div class="empty">Keranjang kosong</div>' : rows}
      ${isOwner() ? `<div style="padding-top:14px"><label class="field">Diskon (Rp)<input type="number" id="cartDiscount" inputmode="numeric" min="0" value="${state.cartDiscount || 0}"></label></div>` : ""}
      <div class="row" style="padding-top:14px;font-weight:800;font-size:17px">
        <span class="grow">Total</span>
        <span class="tabular" id="cartTotalLabel">${rp(Math.max(subtotal - (state.cartDiscount || 0), 0))}</span>
      </div>
    </div>
    <div class="sheet-foot stack">
      <button class="btn primary" data-action="go-pay" ${state.cart.length === 0 ? "disabled" : ""}>Bayar</button>
    </div>`;
  const disc = document.getElementById("cartDiscount");
  if (disc) disc.addEventListener("input", () => {
    state.cartDiscount = Number(disc.value) || 0;
    document.getElementById("cartTotalLabel").textContent = rp(Math.max(subtotal - state.cartDiscount, 0));
  });
}
document.addEventListener("click", (e) => {
  const inc = e.target.closest('[data-action="cart-inc"]');
  if (inc) { state.cart[inc.dataset.idx].qty += 1; renderCartSheet(); render(); return; }
  const dec = e.target.closest('[data-action="cart-dec"]');
  if (dec) { const idx = dec.dataset.idx; state.cart[idx].qty -= 1; if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1); renderCartSheet(); render(); return; }
  const pay = e.target.closest('[data-action="go-pay"]');
    if (pay) { renderPaySheet(); return; }
});

function renderPaySheet() {
  const subtotal = state.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const discount = isOwner() ? (state.cartDiscount || 0) : 0;
  const total = Math.max(subtotal - discount, 0);
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><button class="icon-btn" data-action="back-cart">←</button><h2>Bayar ${rp(total)}</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body stack">
      <div class="chiprow">
        <button class="chip ${(state.payMethod || "cash") === "cash" ? "active" : ""}" data-action="pay-method" data-m="cash">Tunai</button>
        <button class="chip ${state.payMethod === "debt" ? "active" : ""}" data-action="pay-method" data-m="debt">Utang</button>
      </div>
      <div id="payArea"></div>
    </div>
    <div class="sheet-foot stack">
      <button class="btn primary" id="confirmPayBtn" data-action="confirm-sale">Selesaikan transaksi</button>
    </div>`;
  renderPayArea(total);
}
document.addEventListener("click", (e) => {
  const back = e.target.closest('[data-action="back-cart"]'); if (back) { renderCartSheet(); return; }
  const pm = e.target.closest('[data-action="pay-method"]');
  if (pm) {
    state.payMethod = pm.dataset.m;
    document.querySelectorAll('[data-action="pay-method"]').forEach((b) => b.classList.remove("active"));
    pm.classList.add("active");
    const subtotal = state.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const discount = isOwner() ? (state.cartDiscount || 0) : 0;
    renderPayArea(Math.max(subtotal - discount, 0));
  }
});
function renderPayArea(total) {
  const area = document.getElementById("payArea");
  if (!area) return;
  if ((state.payMethod || "cash") === "cash") {
    const quick = [0, 5000, 10000, 20000, 50000, 100000];
    area.innerHTML = `
      <label class="field">Uang diterima<input type="number" id="cashReceived" inputmode="numeric" value="${state.cashReceived || total}"></label>
      <div class="chiprow">${quick.map((q) => `<button class="chip" data-action="quick-cash" data-v="${q === 0 ? total : q}">${q === 0 ? "Pas" : rp(q)}</button>`).join("")}</div>
      <div class="row tabular" style="font-weight:700"><span class="grow">Kembalian</span><span id="kembalianLabel">${rp(Math.max((state.cashReceived || total) - total, 0))}</span></div>`;
    const cr = document.getElementById("cashReceived");
    cr.addEventListener("input", () => { state.cashReceived = Number(cr.value) || 0; document.getElementById("kembalianLabel").textContent = rp(Math.max(state.cashReceived - total, 0)); });
  } else {
    if (state.customers.length === 0) { area.innerHTML = `<p style="color:var(--muted)">Belum ada pelanggan. Tambahkan dulu di tab Utang.</p>`; return; }
    const custOptions = state.customers.map((c) => `<option value="${esc(c.id)}" ${state.payCustomer === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    area.innerHTML = `<label class="field">Pelanggan<select id="payCustomer"><option value="">— pilih pelanggan —</option>${custOptions}</select></label><div id="debtWarning"></div>`;
    const sel = document.getElementById("payCustomer");
    sel.addEventListener("change", () => { state.payCustomer = sel.value; checkDebtLimit(total); });
    checkDebtLimit(total);
  }
}
function checkDebtLimit(total) {
  const box = document.getElementById("debtWarning");
  if (!box) return;
  const c = state.customers.find((c) => c.id === state.payCustomer);
  if (!c) { box.innerHTML = ""; state.debtOverride = false; return; }
  const bal = balanceFor(c.id);
  const after = bal + total;
  if (after > (c.debtLimit || 0)) {
    box.innerHTML = `<div class="pill danger" style="display:block;padding:10px;border-radius:12px">⚠ Melebihi limit utang. Sisa jatah ${rp(Math.max(c.debtLimit - bal, 0))}.</div>
      <label class="row" style="margin-top:10px;font-weight:600;font-size:13px"><input type="checkbox" id="overrideDebt" style="width:auto;min-height:auto"> Tetap catat utang ini</label>`;
    state.debtOverride = false;
    document.getElementById("overrideDebt").addEventListener("change", (e) => { state.debtOverride = e.target.checked; });
  } else {
    box.innerHTML = `<div class="pill good" style="display:block;padding:10px;border-radius:12px">Sisa jatah setelah transaksi ini: ${rp(Math.max(c.debtLimit - after, 0))}</div>`;
    state.debtOverride = true;
  }
}
document.addEventListener("click", (e) => {
  const qc = e.target.closest('[data-action="quick-cash"]');
  if (qc) {
    state.cashReceived = Number(qc.dataset.v);
    document.getElementById("cashReceived").value = state.cashReceived;
    const subtotal = state.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const discount = isOwner() ? (state.cartDiscount || 0) : 0;
    const total = Math.max(subtotal - discount, 0);
    document.getElementById("kembalianLabel").textContent = rp(Math.max(state.cashReceived - total, 0));
  }
  const confirm = e.target.closest('[data-action="confirm-sale"]');
  if (confirm) finalizeSale();
});

async function finalizeSale() {
  const subtotal = state.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const discount = isOwner() ? (state.cartDiscount || 0) : 0;
  const total = Math.max(subtotal - discount, 0);
  const method = state.payMethod || "cash";
  if (method === "debt") {
    if (!state.payCustomer) { toast("Pilih pelanggan dulu"); return; }
    if (!state.debtOverride) { toast("Centang konfirmasi melebihi limit, atau kurangi belanja"); return; }
  } else if ((state.cashReceived || 0) < total) {
    toast("Uang diterima kurang dari total belanja"); return;
  }
  const btn = document.getElementById("confirmPayBtn");
  btn.disabled = true; btn.textContent = "Menyimpan…";
  try {
    const items = state.cart.map((i) => ({ product_id: i.productId, qty: i.qty }));
    const { data: saleId, error } = await supa.rpc("create_sale", {
      p_store: state.storeId, p_client_uuid: uid(), p_customer: method === "debt" ? state.payCustomer : null,
      p_method: method, p_discount: discount, p_items: items, p_allow_over_limit: !!state.debtOverride,
    });
    if (error) throw error;
    const custName = method === "debt" ? (state.customers.find((c) => c.id === state.payCustomer) || {}).name : null;
    const custPhone = method === "debt" ? (state.customers.find((c) => c.id === state.payCustomer) || {}).phone : "";
    const kembalian = method === "cash" ? Math.max((state.cashReceived || total) - total, 0) : 0;
    const receiptItems = state.cart.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice }));
    state.cart = []; state.cartDiscount = 0; state.payMethod = "cash"; state.cashReceived = undefined; state.payCustomer = undefined;
    await loadAll(true);
    renderReceiptSheet({ items: receiptItems, total, method, custName, kembalian, custPhone });
  } catch (e) {
    toast("Gagal menyimpan transaksi: " + errMsg(e));
    btn.disabled = false; btn.textContent = "Selesaikan transaksi";
  }
}
function renderReceiptSheet(sale) {
  const lines = sale.items.map((i) => `${i.qty}x ${i.name} — ${rp(i.qty * i.unitPrice)}`).join("\n");
  const storeName = state.storeName || "Warung";
  const text = `*${storeName}*\n${lines}\n-----------------\nTotal: ${rp(sale.total)}${sale.method === "cash" ? `\nKembalian: ${rp(sale.kembalian)}` : `\n(Dicatat sebagai utang)`}\nTerima kasih!`;
  const canPrint = !!navigator.bluetooth;
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>Transaksi selesai</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body stack">
      <div class="card" style="font-family:var(--font-body)">
        <div style="text-align:center;font-weight:800;margin-bottom:8px">${esc(storeName)}</div>
        <hr class="sep">
        ${sale.items.map((i) => `<div class="row tabular" style="font-size:13px"><span class="grow">${esc(i.qty)}x ${esc(i.name)}</span><span>${rp(i.qty * i.unitPrice)}</span></div>`).join("")}
        <hr class="sep">
        <div class="row tabular" style="font-weight:800"><span class="grow">Total</span><span>${rp(sale.total)}</span></div>
        ${sale.method === "cash" ? `<div class="row tabular"><span class="grow">Kembalian</span><span>${rp(sale.kembalian)}</span></div>` : `<div class="pill warn" style="margin-top:6px;display:inline-block">Dicatat sebagai utang — ${esc(sale.custName || "")}</div>`}
      </div>
      <a class="btn" href="${waLink(sale.custPhone, text)}" target="_blank" rel="noopener">Kirim struk lewat WhatsApp</a>
      ${canPrint ? `<button class="btn" data-action="print-receipt" data-text="${esc(JSON.stringify({ shop: storeName, items: sale.items, total: sale.total, paid: sale.method === "cash" ? (sale.total + sale.kembalian) : sale.total }))}">Cetak struk (printer Bluetooth)</button>` : ""}
    </div>
    <div class="sheet-foot"><button class="btn primary" data-action="close-sheet">Selesai</button></div>`;
}
document.addEventListener("click", async (e) => {
  const pr = e.target.closest('[data-action="print-receipt"]');
  if (!pr) return;
  const payload = JSON.parse(pr.dataset.text);
  pr.disabled = true; pr.textContent = "Menghubungkan printer…";
  try {
    const ch = await connectPrinter();
    const data = buildReceipt(payload.shop, payload.items, payload.total, payload.paid);
    await printReceipt(ch, data);
    toast("Struk dikirim ke printer");
  } catch (err) {
    toast("Gagal mencetak: " + (err && err.message ? err.message : "cek koneksi Bluetooth printer"));
  }
  pr.disabled = false; pr.textContent = "Cetak struk (printer Bluetooth)";
});

/* -------- Bluetooth thermal printer (ESC/POS, BLE only) -------- */
const PRINTER_SERVICE = "000018f0-0000-1000-8000-00805f9b34fb";
const PRINTER_CHAR = "00002af1-0000-1000-8000-00805f9b34fb";
async function connectPrinter() {
  const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [PRINTER_SERVICE] });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(PRINTER_SERVICE);
  return service.getCharacteristic(PRINTER_CHAR);
}
function buildReceipt(shop, items, total, paid) {
  const enc = new TextEncoder();
  const ESC = 0x1b;
  const WIDTH = 32;
  const row = (left, right) => { const gap = Math.max(1, WIDTH - left.length - right.length); return left + " ".repeat(gap) + right + "\n"; };
  const parts = [
    Uint8Array.from([ESC, 0x40]), Uint8Array.from([ESC, 0x61, 1]),
    enc.encode(shop + "\n"), Uint8Array.from([ESC, 0x61, 0]),
    enc.encode("-".repeat(WIDTH) + "\n"),
    ...items.map((i) => enc.encode(row(`${i.qty}x ${i.name}`.slice(0, 20), rp(i.qty * i.unitPrice)))),
    enc.encode("-".repeat(WIDTH) + "\n"),
    enc.encode(row("TOTAL", rp(total))),
    enc.encode(row("BAYAR", rp(paid))),
    enc.encode(row("KEMBALI", rp(paid - total))),
    enc.encode("\nTerima kasih\n\n\n"),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
async function printReceipt(ch, data) {
  for (let i = 0; i < data.length; i += 100) await ch.writeValueWithoutResponse(data.slice(i, i + 100));
}

/* -------- Camera barcode scanner -------- */
let scanStream = null, scanStop = null, scanTarget = null;
document.addEventListener("click", async (e) => {
  const open = e.target.closest('[data-action="open-scan"]');
  if (open) { scanTarget = open.dataset.target; await openScanner(); return; }
  if (e.target.closest('[data-action="scan-close"]')) closeScanner();
});
async function openScanner() {
  const overlay = document.getElementById("scanOverlay");
  const video = document.getElementById("scanVideo");
  const hint = document.getElementById("scanHint");
  overlay.classList.add("open");
  hint.textContent = "Arahkan kamera ke barcode";
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  } catch (e) {
    toast("Tidak bisa mengakses kamera: " + (e && e.message ? e.message : "izin ditolak"));
    closeScanner();
    return;
  }
  video.srcObject = scanStream;
  await video.play();
  let lastCode = "", lastAt = 0, stopped = false;
  const emit = (code) => {
    const now = Date.now();
    if (code === lastCode && now - lastAt < 1500) return;
    lastCode = code; lastAt = now;
    navigator.vibrate && navigator.vibrate(60);
    onScanResult(code);
  };
  if ("BarcodeDetector" in window) {
    const formats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];
    const detector = new window.BarcodeDetector({ formats });
    const tick = async () => {
      if (stopped) return;
      try { const hits = await detector.detect(video); if (hits && hits[0]) emit(hits[0].rawValue); } catch (e) {}
      requestAnimationFrame(tick);
    };
    tick();
    scanStop = () => { stopped = true; scanStream.getTracks().forEach((t) => t.stop()); };
  } else {
    hint.textContent = "Memuat pemindai cadangan…";
    try {
      const mod = await import("https://esm.sh/@zxing/browser@0.1.5");
      const reader = new mod.BrowserMultiFormatReader();
      hint.textContent = "Arahkan kamera ke barcode";
      const controls = await reader.decodeFromStream(scanStream, video, (result) => { if (result && !stopped) emit(result.getText()); });
      scanStop = () => { stopped = true; controls.stop(); scanStream.getTracks().forEach((t) => t.stop()); };
    } catch (e) {
      toast("Pemindai barcode tidak didukung di peramban ini");
      closeScanner();
    }
  }
}
function closeScanner() {
  document.getElementById("scanOverlay").classList.remove("open");
  if (scanStop) { try { scanStop(); } catch (e) {} scanStop = null; }
  scanStream = null;
}
function onScanResult(code) {
  if (scanTarget === "kasir") {
    const hit = state.products.find((p) => p.barcode && p.barcode === code);
    if (hit) { addToCart(hit); closeScanner(); }
    else { document.getElementById("scanHint").textContent = "Kode " + code + " tidak dikenali — coba lagi"; }
  } else if (scanTarget === "product-form") {
    const field = document.getElementById("pf-barcode");
    if (field) field.value = code;
    closeScanner();
  }
}

/* ================= STOK ================= */
function renderStok() {
  const low = lowStockProducts();
  const grouped = {};
  state.products.forEach((p) => { const k = p.categoryId || "__none"; (grouped[k] = grouped[k] || []).push(p); });
  const catList = [...state.categories, { id: "__none", name: "Tanpa kategori" }];
  let body = "";
  if (state.products.length === 0) {
    body = `<div class="empty"><h3>Belum ada barang</h3><p>Tambahkan barang pertama Anda.</p></div>`;
  } else {
    body = catList.filter((c) => grouped[c.id] && grouped[c.id].length).map((c) => {
      const items = grouped[c.id].sort((a, b) => a.name.localeCompare(b.name, "id"));
      return `<div class="section-title">${esc(c.name)}</div><div class="stack" style="margin-bottom:18px">` + items.map((p) => {
        const lowP = (p.stock || 0) <= (p.minStock || 0);
        return `<button class="card row" style="text-align:left" data-action="edit-product" data-id="${esc(p.id)}">
          <div class="grow">
            <div style="font-weight:700">${esc(p.name)} ${p.isActive === false ? '<span class="pill" style="background:var(--surface-2);color:var(--muted)">nonaktif</span>' : ""}</div>
            <div style="color:var(--muted);font-size:13px" class="tabular">${rp(p.sellPrice)}${isOwner() ? " · modal " + rp(p.costPrice || 0) : ""}</div>
          </div>
          <div style="text-align:right">
            <div class="tabular" style="font-weight:800">${p.stock || 0} ${esc(p.unit || "pcs")}</div>
            ${lowP ? '<span class="pill warn">Stok menipis</span>' : ""}
          </div>
        </button>`;
      }).join("") + `</div>`;
    }).join("");
  }
  return `
    ${low.length > 0 ? `<div class="card" style="background:var(--warn-soft);border-color:var(--warn-soft);margin-bottom:16px"><strong style="color:var(--warn)">${low.length} barang stoknya menipis</strong></div>` : ""}
    <div class="row" style="margin-bottom:16px;gap:10px">
      <button class="btn primary" style="width:auto;flex:1" data-action="new-product">+ Tambah barang</button>
      <button class="btn" style="width:auto;flex:1" data-action="manage-categories">Kategori</button>
    </div>
    ${body}`;
}
document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="new-product"]')) openProductForm(null);
  const ep = e.target.closest('[data-action="edit-product"]'); if (ep) openProductForm(productById(ep.dataset.id));
  if (e.target.closest('[data-action="manage-categories"]')) openCategoryManager();
});

function openProductForm(p) {
  const catOptions = state.categories.map((c) => `<option value="${esc(c.id)}" ${p && p.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const canScan = !!(window.BarcodeDetector || navigator.mediaDevices);
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>${p ? "Ubah barang" : "Barang baru"}</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body stack">
      <label class="field">Nama barang<input type="text" id="pf-name" value="${p ? esc(p.name) : ""}" placeholder="Contoh: Indomie Goreng"></label>
      <label class="field">Kategori<select id="pf-cat"><option value="">— tanpa kategori —</option>${catOptions}</select></label>
      <div class="row" style="gap:10px">
        <label class="field grow">Harga jual (Rp)<input type="number" id="pf-sell" inputmode="numeric" value="${p ? p.sellPrice : ""}"></label>
        ${isOwner() ? `<label class="field grow">Modal/HPP (Rp)<input type="number" id="pf-cost" inputmode="numeric" value="${p ? p.costPrice || 0 : ""}"></label>` : ""}
      </div>
      <div class="row" style="gap:10px">
        <label class="field grow">Stok<input type="number" id="pf-stock" inputmode="numeric" value="${p ? p.stock : 0}"></label>
        <label class="field grow">Stok minimum<input type="number" id="pf-minstock" inputmode="numeric" value="${p ? p.minStock : 1}"></label>
      </div>
      <div class="row" style="gap:10px">
        <label class="field grow">Satuan<input type="text" id="pf-unit" value="${p ? esc(p.unit || "pcs") : "pcs"}" placeholder="pcs, kg, bungkus"></label>
        <label class="field grow">Barcode (opsional)
          <div class="row" style="gap:6px">
            <input type="text" id="pf-barcode" value="${p ? esc(p.barcode || "") : ""}" placeholder="Ketik atau scan" style="flex:1">
            ${canScan ? `<button type="button" class="icon-btn scan-icon-btn" data-action="open-scan" data-target="product-form" aria-label="Scan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M3 17v2a2 2 0 0 0 2 2h2M21 7V5a2 2 0 0 0-2-2h-2M21 17v2a2 2 0 0 1-2 2h-2M7 12h10"/></svg></button>` : ""}
          </div>
        </label>
      </div>
      ${p ? `<label class="row" style="font-weight:600"><input type="checkbox" id="pf-active" style="width:auto;min-height:auto" ${p.isActive === false ? "" : "checked"}> Aktif (tampil di kasir)</label>` : ""}
    </div>
    <div class="sheet-foot row" style="gap:10px">
      ${p ? `<button class="btn danger" style="width:auto" data-action="delete-product" data-id="${esc(p.id)}">Hapus</button>` : ""}
            <button class="btn primary grow" data-action="save-product" data-id="${p ? esc(p.id) : ""}" data-oldstock="${p ? p.stock : 0}">Simpan</button>
    </div>`;
  openSheet();
}
document.addEventListener("click", async (e) => {
  const save = e.target.closest('[data-action="save-product"]');
  if (save) {
    const name = document.getElementById("pf-name").value.trim();
    if (!name) { toast("Nama barang wajib diisi"); return; }
    const costEl = document.getElementById("pf-cost");
    const stock = Number(document.getElementById("pf-stock").value) || 0;
    const row = {
      store_id: state.storeId, name,
      category_id: document.getElementById("pf-cat").value || null,
      sell_price: Number(document.getElementById("pf-sell").value) || 0,
      stock, min_stock: Number(document.getElementById("pf-minstock").value) || 0,
      unit: document.getElementById("pf-unit").value.trim() || "pcs",
      barcode: document.getElementById("pf-barcode").value.trim() || null,
    };
    const activeEl = document.getElementById("pf-active");
    if (activeEl) row.is_active = activeEl.checked;
    save.disabled = true;
    try {
      let productId = save.dataset.id;
      if (productId) {
        const { error } = await supa.from("products").update(row).eq("id", productId);
        if (error) throw error;
        const oldStock = Number(save.dataset.oldstock) || 0;
        if (stock !== oldStock) {
          await supa.from("stock_movements").insert({ store_id: state.storeId, product_id: productId, type: "adjustment", qty_change: stock - oldStock, created_by: state.session.user.id });
        }
      } else {
        row.is_active = true;
        const { data, error } = await supa.from("products").insert(row).select("id").single();
        if (error) throw error;
        productId = data.id;
      }
      if (costEl) {
        const costPrice = Number(costEl.value) || 0;
        await supa.from("product_costs").upsert({ product_id: productId, store_id: state.storeId, cost_price: costPrice }, { onConflict: "product_id" });
      }
      closeSheet(); toast("Barang disimpan"); loadAll(true);
    } catch (err) { toast("Gagal menyimpan: " + errMsg(err)); }
    save.disabled = false;
  }
  const del = e.target.closest('[data-action="delete-product"]');
  if (del) {
    try { const { error } = await supa.from("products").delete().eq("id", del.dataset.id); if (error) throw error; closeSheet(); toast("Barang dihapus"); loadAll(true); }
    catch (err) { toast("Gagal menghapus: " + errMsg(err)); }
  }
});

function openCategoryManager() { renderCategoryManager(); openSheet(); }
function renderCategoryManager() {
  const rows = state.categories.map((c) => `
    <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <span class="grow">${esc(c.name)}</span>
      <button class="icon-btn" style="width:32px;height:32px" data-action="del-cat" data-id="${esc(c.id)}">🗑</button>
    </div>`).join("");
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>Kategori</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body">
      ${rows || '<p style="color:var(--muted)">Belum ada kategori.</p>'}
      <div class="row" style="margin-top:14px;gap:8px">
        <input type="text" id="newCatName" placeholder="Nama kategori baru" class="grow">
        <button class="btn primary" style="width:auto" data-action="add-cat">Tambah</button>
      </div>
    </div>`;
}
document.addEventListener("click", async (e) => {
  const add = e.target.closest('[data-action="add-cat"]');
  if (add) {
    const input = document.getElementById("newCatName");
    const name = input.value.trim();
    if (!name) return;
    try { const { error } = await supa.from("categories").insert({ store_id: state.storeId, name }); if (error) throw error; input.value = ""; renderCategoryManager(); loadAll(true); }
    catch (err) { toast("Gagal menambah kategori: " + errMsg(err)); }
  }
  const del = e.target.closest('[data-action="del-cat"]');
  if (del) {
    const inUse = state.products.some((p) => p.categoryId === del.dataset.id);
    if (inUse) { toast("Masih dipakai barang. Pindahkan dulu kategorinya."); return; }
    try { const { error } = await supa.from("categories").delete().eq("id", del.dataset.id); if (error) throw error; renderCategoryManager(); loadAll(true); }
    catch (err) { toast("Gagal menghapus: " + errMsg(err)); }
  }
});

/* ================= UTANG ================= */
function renderUtang() {
  if (state.customers.length === 0) {
    return `<button class="btn primary" style="margin-bottom:16px" data-action="new-customer">+ Tambah pelanggan</button>
      <div class="empty"><h3>Belum ada pelanggan</h3><p>Tambahkan pelanggan untuk mulai mencatat utang.</p></div>`;
  }
  const rows = state.customers.map((c) => {
    const bal = balanceFor(c.id);
    const limit = c.debtLimit || 0;
    const pct = limit > 0 ? Math.min(bal / limit, 1) * 100 : (bal > 0 ? 100 : 0);
    const status = bal <= 0 ? "good" : (bal >= limit ? "danger" : (bal >= limit * 0.8 ? "warn" : "good"));
    const statusLabel = bal <= 0 ? "Lunas" : (bal >= limit ? "Melebihi limit" : (bal >= limit * 0.8 ? "Mendekati limit" : "Aman"));
    return `<button class="card" style="text-align:left;margin-bottom:10px;width:100%" data-action="open-customer" data-id="${esc(c.id)}">
      <div class="row">
        <div class="grow"><div style="font-weight:700">${esc(c.name)}</div><div style="color:var(--muted);font-size:13px">${esc(c.phone || "Tanpa nomor HP")}</div></div>
        <div style="text-align:right"><div class="tabular" style="font-weight:800">${rp(bal)}</div><span class="pill ${status}">${statusLabel}</span></div>
      </div>
      <div style="height:6px;border-radius:3px;background:var(--surface-2);margin-top:10px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--${status === "good" ? "accent" : status})"></div></div>
    </button>`;
  }).join("");
  return `<button class="btn primary" style="margin-bottom:16px" data-action="new-customer">+ Tambah pelanggan</button>${rows}`;
}
document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="new-customer"]')) openCustomerForm(null);
  const oc = e.target.closest('[data-action="open-customer"]'); if (oc) openCustomerDetail(oc.dataset.id);
});
function openCustomerForm(c) {
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>${c ? "Ubah pelanggan" : "Pelanggan baru"}</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body stack">
      <label class="field">Nama<input type="text" id="cf-name" value="${c ? esc(c.name) : ""}"></label>
      <label class="field">No. HP (untuk WhatsApp)<input type="tel" id="cf-phone" value="${c ? esc(c.phone || "") : ""}" placeholder="08xxxxxxxxxx"></label>
      <label class="field">Batas utang (Rp)<input type="number" id="cf-limit" inputmode="numeric" value="${c ? c.debtLimit : 100000}"></label>
    </div>
    <div class="sheet-foot"><button class="btn primary" data-action="save-customer" data-id="${c ? esc(c.id) : ""}">Simpan</button></div>`;
  openSheet();
}
document.addEventListener("click", async (e) => {
  const save = e.target.closest('[data-action="save-customer"]');
  if (save) {
    const name = document.getElementById("cf-name").value.trim();
    if (!name) { toast("Nama wajib diisi"); return; }
    const row = { store_id: state.storeId, name, phone: document.getElementById("cf-phone").value.trim() || null, debt_limit: Number(document.getElementById("cf-limit").value) || 0 };
    try {
      if (save.dataset.id) { const { error } = await supa.from("customers").update(row).eq("id", save.dataset.id); if (error) throw error; }
      else { const { error } = await supa.from("customers").insert(row); if (error) throw error; }
      closeSheet(); toast("Pelanggan disimpan"); loadAll(true);
    } catch (err) { toast("Gagal menyimpan: " + errMsg(err)); }
  }
});
function openCustomerDetail(id) { renderCustomerDetail(id); openSheet(); }
function renderCustomerDetail(id) {
  const c = state.customers.find((c) => c.id === id);
  if (!c) { closeSheet(); return; }
  const bal = balanceFor(id);
  const entries = state.debts.filter((d) => d.customerId === id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
  const rows = entries.map((d) => `
    <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <div class="grow"><div style="font-weight:600">${d.kind === "debt" ? "Utang baru" : "Pembayaran"}</div><div style="color:var(--muted);font-size:12px">${fmtDateTime(d.createdAt)}${d.note ? " · " + esc(d.note) : ""}</div></div>
      <div class="tabular" style="font-weight:700;color:${d.kind === "debt" ? "var(--danger)" : "var(--accent)"}">${d.kind === "debt" ? "+" : "−"}${rp(d.amount)}</div>
    </div>`).join("");
  const reminderText = `Halo ${c.name}, ini pengingat dari ${state.storeName || "warung kami"}. Sisa utang Anda saat ini ${rp(bal)}. Terima kasih.`;
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>${esc(c.name)}</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body stack">
      <div class="card">
        <div class="row"><span class="grow" style="color:var(--muted)">Sisa utang</span><span class="tabular big-number">${rp(bal)}</span></div>
        <div class="row" style="margin-top:6px"><span class="grow" style="color:var(--muted)">Batas utang</span><span class="tabular">${rp(c.debtLimit || 0)}</span></div>
      </div>
      <div class="row" style="gap:10px">
        <button class="btn primary grow" data-action="record-payment" data-id="${esc(id)}">Catat pembayaran</button>
        <button class="btn grow" data-action="edit-customer" data-id="${esc(id)}">Ubah</button>
      </div>
      ${bal > 0 ? `<a class="btn" href="${waLink(c.phone, reminderText)}" target="_blank" rel="noopener">Kirim pengingat WhatsApp</a>` : ""}
      <div class="section-title" style="margin-top:6px">Riwayat</div>
      ${rows || '<p style="color:var(--muted)">Belum ada riwayat.</p>'}
    </div>`;
}
document.addEventListener("click", (e) => {
  const ec = e.target.closest('[data-action="edit-customer"]'); if (ec) openCustomerForm(state.customers.find((c) => c.id === ec.dataset.id));
  const rp_ = e.target.closest('[data-action="record-payment"]'); if (rp_) openPaymentForm(rp_.dataset.id);
});
function openPaymentForm(customerId) {
  const c = state.customers.find((c) => c.id === customerId);
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>Catat pembayaran</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body stack">
      <p style="color:var(--muted);margin:0">${esc(c.name)} · sisa utang saat ini ${rp(balanceFor(customerId))}</p>
      <label class="field">Jumlah dibayar (Rp)<input type="number" id="pay-amount" inputmode="numeric" value="${balanceFor(customerId)}"></label>
      <label class="field">Catatan (opsional)<input type="text" id="pay-note"></label>
    </div>
    <div class="sheet-foot"><button class="btn primary" data-action="save-payment" data-id="${esc(customerId)}">Simpan pembayaran</button></div>`;
}
document.addEventListener("click", async (e) => {
  const sp = e.target.closest('[data-action="save-payment"]');
  if (sp) {
    const amount = Number(document.getElementById("pay-amount").value) || 0;
    if (amount <= 0) { toast("Jumlah harus lebih dari 0"); return; }
    try {
      const { error } = await supa.rpc("record_payment", { p_store: state.storeId, p_customer: sp.dataset.id, p_amount: amount, p_note: document.getElementById("pay-note").value.trim() || null });
      if (error) throw error;
      await loadAll(true);
      openCustomerDetail(sp.dataset.id); toast("Pembayaran dicatat");
    } catch (err) { toast("Gagal menyimpan: " + errMsg(err)); }
  }
});

/* ================= LAPORAN ================= */
function periodRange(period) {
  const now = new Date();
  const startOfToday = new Date(now.toLocaleString("en-US", { timeZone: JKT_TZ })); startOfToday.setHours(0, 0, 0, 0);
  let from;
  if (period === "today") from = startOfToday.getTime();
  else if (period === "week") from = startOfToday.getTime() - 6 * 86400000;
  else if (period === "month") from = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1).getTime();
  else from = new Date(startOfToday.getFullYear(), 0, 1).getTime();
  return { from, to: now.getTime() };
}
function renderLaporan() {
  const { from, to } = periodRange(state.laporanPeriod);
  const sales = state.sales.filter((s) => s.status === "paid" || s.status === "pending").filter((s) => { const t = new Date(s.createdAt).getTime(); return t >= from && t <= to; });
  const omzet = sales.reduce((s, x) => s + x.total, 0);
  const modal = isOwner() ? sales.reduce((s, x) => s + x.items.reduce((ss, i) => ss + i.qty * (i.costPrice || 0), 0), 0) : 0;
  const untung = omzet - modal;
  const byProduct = {};
  sales.forEach((s) => s.items.forEach((i) => {
    const k = i.productId || i.name;
    byProduct[k] = byProduct[k] || { name: i.name, qty: 0, omzet: 0 };
    byProduct[k].qty += i.qty; byProduct[k].omzet += i.qty * i.unitPrice;
  }));
  const top = Object.values(byProduct).sort((a, b) => b.qty - a.qty).slice(0, 5);
  const periods = [["today", "Hari ini"], ["week", "7 hari"], ["month", "Bulan ini"], ["year", "Tahun ini"]];
  const chips = periods.map(([id, label]) => `<button class="chip ${state.laporanPeriod === id ? "active" : ""}" data-action="laporan-period" data-id="${id}">${label}</button>`).join("");

  const days = [];
  for (let i = 6; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 86400000).toISOString()));
  const totalsByDay = {};
  days.forEach((d) => (totalsByDay[d] = 0));
  state.sales.forEach((s) => { const k = dayKey(s.createdAt); if (k in totalsByDay) totalsByDay[k] += s.total; });
  const maxVal = Math.max(1, ...days.map((d) => totalsByDay[d]));
  const W = 320, H = 140, padL = 8, padR = 8, padB = 24, padT = 18, barGap = 10;
  const barW = (W - padL - padR - barGap * (days.length - 1)) / days.length;
  const bars = days.map((d, idx) => {
    const v = totalsByDay[d];
    const h = Math.max(2, (v / maxVal) * (H - padT - padB));
    const x = padL + idx * (barW + barGap);
    const y = H - padB - h;
    const dow = DOW[new Date(d + "T00:00:00").getDay()];
    const isToday = d === todayKey();
    return `<g><rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="var(--accent)" opacity="${isToday ? 1 : 0.55}"><title>${d}: ${rp(v)}</title></rect>
      <text x="${x + barW / 2}" y="${H - padB + 14}" text-anchor="middle" font-size="10" fill="var(--muted)">${dow}</text>
      ${isToday ? `<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--ink)">${Math.round(v / 1000)}rb</text>` : ""}</g>`;
  }).join("");

  return `
    <div class="chiprow">${chips}</div>
    <div class="stack" style="margin-bottom:18px">
      <div class="card"><div style="color:var(--muted);font-size:13px">Omzet</div><div class="big-number tabular">${rp(omzet)}</div></div>
      ${isOwner() ? `<div class="row" style="gap:12px">
        <div class="card grow"><div style="color:var(--muted);font-size:13px">Modal</div><div class="tabular" style="font-weight:800;font-size:18px">${rp(modal)}</div></div>
        <div class="card grow"><div style="color:var(--muted);font-size:13px">Untung bersih</div><div class="tabular" style="font-weight:800;font-size:18px;color:var(--accent)">${rp(untung)}</div></div>
      </div>` : ""}
    </div>
    <div class="section-title">Omzet 7 hari terakhir</div>
    <div class="card chartwrap" style="margin-bottom:18px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Omzet 7 hari terakhir" style="width:100%;height:auto">${bars}</svg></div>
    <div class="section-title">Produk terlaris (periode dipilih)</div>
    <div class="stack">
      ${top.length === 0 ? '<p style="color:var(--muted)">Belum ada transaksi di periode ini.</p>' : top.map((p, idx) => `
        <div class="card row">
          <div class="pill good" style="width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none">${idx + 1}</div>
          <div class="grow" style="font-weight:700">${esc(p.name)}</div>
          <div style="text-align:right"><div class="tabular" style="font-weight:800">${p.qty} terjual</div><div class="tabular" style="color:var(--muted);font-size:12px">${rp(p.omzet)}</div></div>
        </div>`).join("")}
    </div>`;
}
document.addEventListener("click", (e) => { const lp = e.target.closest('[data-action="laporan-period"]'); if (lp) { state.laporanPeriod = lp.dataset.id; render(); } });

/* ================= SETTINGS ================= */
function openSettings() { renderSettings(); openSheet(); }
function renderSettings() {
  document.getElementById("sheet").innerHTML = `
    <div class="sheet-head"><h2>Pengaturan</h2><button class="icon-btn" data-action="close-sheet">✕</button></div>
    <div class="sheet-body stack">
      <div class="row"><span class="grow" style="color:var(--muted)">Masuk sebagai</span><span>${esc(state.session.user.email || "")}</span></div>
      <div class="row"><span class="grow" style="color:var(--muted)">Peran</span><span class="role-badge">${isOwner() ? "Pemilik" : "Karyawan"}</span></div>
      ${isOwner() ? `<label class="field">Nama warung<input type="text" id="set-storename" value="${esc(state.storeName)}"></label><button class="btn primary" data-action="save-storename">Simpan nama</button>` : ""}
      <hr class="sep">
      <button class="btn" data-action="manage-categories">Kelola kategori</button>
      <hr class="sep">
      <button class="btn danger" data-action="sign-out">Keluar</button>
      <p style="color:var(--muted);font-size:12px;margin:0">Data tersimpan di database Supabase milik Anda sendiri. Akun karyawan terpisah dengan hak akses terbatas menyusul di pembaruan berikutnya.</p>
    </div>`;
}
document.addEventListener("click", async (e) => {
  if (e.target.closest("#settingsBtn")) openSettings();
  const ss = e.target.closest('[data-action="save-storename"]');
  if (ss) {
    const v = document.getElementById("set-storename").value.trim();
    if (!v) { toast("Nama tidak boleh kosong"); return; }
    try { const { error } = await supa.from("stores").update({ name: v }).eq("id", state.storeId); if (error) throw error; state.storeName = v; document.getElementById("storeNameLabel").textContent = v; toast("Nama disimpan"); }
    catch (err) { toast("Gagal: " + errMsg(err)); }
  }
  if (e.target.closest('[data-action="sign-out"]')) { await supa.auth.signOut(); clearInterval(pollTimer); state.storeId = null; state.phase = "login"; closeSheet(); render(); }
});

/* ================= sheet + tabs wiring ================= */
function openSheet() { document.getElementById("sheetRoot").classList.add("open"); }
function closeSheet() { document.getElementById("sheetRoot").classList.remove("open"); }
document.addEventListener("click", (e) => { if (e.target.closest('[data-action="close-sheet"]')) closeSheet(); });
document.querySelectorAll("nav.tabbar button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => { state.tab = btn.dataset.tab; lsSet("warungku.tab", state.tab); render(); });
});

boot();
