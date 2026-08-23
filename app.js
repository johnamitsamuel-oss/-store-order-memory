import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.APP_CONFIG || {};

const configured =
  cfg.SUPABASE_URL &&
  cfg.SUPABASE_PUBLISHABLE_KEY &&
  !cfg.SUPABASE_URL.includes("YOUR_PROJECT") &&
  !cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_");

const supabase = configured
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY)
  : null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const authCard = $("#authCard");
const workspaceCard = $("#workspaceCard");
const app = $("#app");

let session = null;
let workspace = null;
let memberRole = "staff";
let products = [];
let orders = [];
let channel = null;

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDateKey(k) {
  if (!k) return new Date();

  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(k) {
  if (!k) return "";

  return parseDateKey(k).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtTimestamp(value) {
  if (!value) return "";

  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function msg(el, text = "") {
  if (el) el.textContent = text;
}

function setScreen(name) {
  authCard.classList.toggle("hidden", name !== "auth");
  workspaceCard.classList.toggle("hidden", name !== "workspace");
  app.classList.toggle("hidden", name !== "app");
}

function isSenior() {
  return ["manager", "owner", "boss", "admin"].includes(
    String(memberRole || "").toLowerCase()
  );
}

$("#todayLabel").textContent = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

if (!configured) {
  msg(
    $("#authMessage"),
    "Add your Supabase URL and publishable key in config.js first."
  );
}

async function bootstrap() {
  if (!supabase) {
    setScreen("auth");
    return;
  }

  const { data } = await supabase.auth.getSession();

  session = data.session;

  if (!session) {
    setScreen("auth");
    return;
  }

  await loadWorkspace();
}

async function loadWorkspace() {
  const { data, error } = await supabase
    .from("workspace_members")
    .select(
      "workspace_id, role, workspaces(id,name,invite_code)"
    )
    .eq("user_id", session.user.id)
    .limit(1)
    .maybeSingle();

  if (error) {
    msg($("#workspaceMessage"), error.message);
    setScreen("workspace");
    return;
  }

  if (!data?.workspaces) {
    setScreen("workspace");
    return;
  }

  workspace = data.workspaces;
  memberRole = data.role || "staff";

  $("#workspaceTitle").textContent = workspace.name;
  $("#inviteCodeDisplay").textContent = workspace.invite_code;

  setScreen("app");

  await refreshAll();
  subscribeRealtime();
}

async function refreshAll() {
  if (!workspace) return;

  const [p, o] = await Promise.all([
    supabase
      .from("products")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("active", true)
      .order("name", { ascending: true }),

    supabase
      .from("orders")
      .select("*")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false }),
  ]);

  if (p.error) {
    msg($("#appMessage"), p.error.message);
  } else {
    products = p.data || [];
  }

  if (o.error) {
    msg($("#appMessage"), o.error.message);
  } else {
    orders = o.data || [];
  }

  renderAll();
}

function subscribeRealtime() {
  if (channel) {
    supabase.removeChannel(channel);
  }

  channel = supabase
    .channel(`store-${workspace.id}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "products",
        filter: `workspace_id=eq.${workspace.id}`,
      },
      refreshAll
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "orders",
        filter: `workspace_id=eq.${workspace.id}`,
      },
      refreshAll
    )
    .subscribe();
}

function activeOrders() {
  return orders.filter(
    (o) => !o.status || o.status === "active"
  );
}

function completedOrders() {
  return orders.filter((o) => o.status === "completed");
}

function activeOrderFor(productId) {
  return (
    activeOrders().find(
      (o) => o.product_id === productId
    ) || null
  );
}

function productFor(productId) {
  return products.find((p) => p.id === productId) || null;
}

function startingQty(product) {
  return Math.max(
    0,
    Math.min(999, Number(product.default_quantity) || 1)
  );
}

function renderAll() {
  renderStats();
  renderWeek();
  renderProducts();
  renderHistory();
}

function renderStats() {
  const active = activeOrders();

  if ($("#dueCount")) {
    $("#dueCount").textContent = active.length;
  }

  if ($("#weekOrderedCount")) {
    $("#weekOrderedCount").textContent = active.reduce(
      (sum, o) => sum + (Number(o.quantity) || 0),
      0
    );
  }

  if ($("#productCount")) {
    $("#productCount").textContent = products.length;
  }
}

function renderWeek() {
  const host = $("#weekList");

  if (!host) return;

  host.innerHTML = "";

  ensureCompleteOrderButton();

  if ($("#weekEmpty")) {
    $("#weekEmpty").classList.toggle(
      "hidden",
      products.length > 0
    );
  }

  const sorted = [...products].sort((a, b) => {
    const ao = !!activeOrderFor(a.id);
    const bo = !!activeOrderFor(b.id);

    if (ao !== bo) {
      return ao ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

  sorted.forEach((product) => {
    const order = activeOrderFor(product.id);

    const row = document.createElement("div");
    row.className = "order-row";

    const body = document.createElement("div");

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = product.name;

    const status = document.createElement("span");

    if (order) {
      status.className = "due due-now";
      status.textContent = "Active order";
    } else {
      status.className = "due not-due";
      status.textContent = "Not on current order";
    }

    body.append(title, status);

    const controls = document.createElement("div");
    controls.className = "qty-controls";

    if (order) {
      const minus = document.createElement("button");
      const qty = document.createElement("span");
      const plus = document.createElement("button");

      minus.type = "button";
      plus.type = "button";

      minus.className = "mini";
      plus.className = "mini";

      minus.textContent = "−";
      plus.textContent = "+";

      const currentQty = Math.max(
        0,
        Number(order.quantity) || 0
      );

      qty.className = "qty-pill";
      qty.textContent = `Qty ${currentQty}`;

      minus.addEventListener("click", async () => {
        await changeOrderQty(
          order,
          Math.max(0, currentQty - 1)
        );
      });

      plus.addEventListener("click", async () => {
        await changeOrderQty(
          order,
          Math.min(999, currentQty + 1)
        );
      });

      controls.append(minus, qty, plus);
    } else {
      const add = button(
        "Add",
        "mini",
        async () => {
          await addActiveOrder(product);
        }
      );

      controls.append(add);
    }

    row.append(body, controls);
    host.append(row);
  });
}

function ensureCompleteOrderButton() {
  const host = $("#weekList");

  if (!host) return;

  let btn = $("#completeOrderBtn");

  if (!isSenior()) {
    if (btn) btn.remove();
    return;
  }

  if (!btn) {
    btn = document.createElement("button");
    btn.id = "completeOrderBtn";
    btn.type = "button";
    btn.className = "primary";
    btn.textContent = "Complete Order";

    btn.addEventListener(
      "click",
      completeCurrentOrder
    );

    host.parentElement.insertBefore(btn, host);
  }

  btn.disabled = activeOrders().length === 0;
}

async function addActiveOrder(product) {
  msg($("#appMessage"));

  const alreadyActive = activeOrderFor(product.id);

  if (alreadyActive) {
    msg(
      $("#appMessage"),
      `${product.name} is already on the active order.`
    );
    return;
  }

  const qty = startingQty(product);

  const { error } = await supabase
    .from("orders")
    .insert({
      workspace_id: workspace.id,
      product_id: product.id,
      product_name: product.name,
      quantity: qty,
      ordered_on: localDateKey(),
      ordered_by: session.user.id,
      status: "active",
    });

  if (error) {
    msg($("#appMessage"), error.message);
    return;
  }

  await refreshAll();
}

async function changeOrderQty(order, quantity) {
  const safeQty = Math.max(
    0,
    Math.min(999, Number(quantity) || 0)
  );

  const { error } = await supabase
    .from("orders")
    .update({
      quantity: safeQty,
    })
    .eq("id", order.id);

  if (error) {
    msg($("#appMessage"), error.message);
    return;
  }

  await refreshAll();
}

async function completeCurrentOrder() {
  if (!isSenior()) {
    msg(
      $("#appMessage"),
      "Only a manager or owner can complete an order."
    );
    return;
  }

  const active = activeOrders();

  if (!active.length) {
    msg($("#appMessage"), "There is no active order.");
    return;
  }

  const ok = window.confirm(
    `Complete this order with ${active.length} product${active.length === 1 ? "" : "s"}?`
  );

  if (!ok) return;

  const ids = active.map((o) => o.id);

  const { error } = await supabase
    .from("orders")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: session.user.id,
    })
    .in("id", ids);

  if (error) {
    msg($("#appMessage"), error.message);
    return;
  }

  msg(
    $("#appMessage"),
    "Order completed and moved to history."
  );

  await refreshAll();
}

function renderProducts() {
  const host = $("#productList");

  if (!host) return;

  host.innerHTML = "";

  if ($("#productEmpty")) {
    $("#productEmpty").classList.toggle(
      "hidden",
      products.length > 0
    );
  }

  products.forEach((product) => {
    const active = activeOrderFor(product.id);

    const row = document.createElement("div");
    row.className = "product-row";

    const body = document.createElement("div");

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = product.name;

    const meta = document.createElement("div");
    meta.className = "meta";

    meta.textContent =
      `Usual qty ${Number(product.default_quantity) || 1}` +
      (active
        ? ` • Current order qty ${Number(active.quantity) || 0}`
        : "");

    body.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "product-actions";

    const edit = button(
      "Edit",
      "mini",
      () => editProduct(product)
    );

    actions.append(edit);

    row.append(body, actions);
    host.append(row);
  });
}

async function editProduct(product) {
  const newName = window.prompt(
    "Product name",
    product.name
  );

  if (newName === null) return;

  const cleanName = newName.trim();

  if (!cleanName) {
    msg(
      $("#productMessage"),
      "Product name cannot be empty."
    );
    return;
  }

  const qtyInput = window.prompt(
    "Usual quantity",
    String(product.default_quantity || 1)
  );

  if (qtyInput === null) return;

  const defaultQuantity = Math.max(
    1,
    Math.min(999, Number(qtyInput) || 1)
  );

  const { error } = await supabase
    .from("products")
    .update({
      name: cleanName,
      default_quantity: defaultQuantity,
    })
    .eq("id", product.id);

  if (error) {
    msg($("#productMessage"), error.message);
    return;
  }

  await refreshAll();
}

function button(text, cls, fn) {
  const b = document.createElement("button");

  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.addEventListener("click", fn);

  return b;
}

function renderHistory() {
  const host = $("#historyList");

  if (!host) return;

  host.innerHTML = "";

  const history = [...completedOrders()].sort(
    (a, b) =>
      new Date(b.completed_at || b.updated_at || b.created_at) -
      new Date(a.completed_at || a.updated_at || a.created_at)
  );

  if ($("#historyEmpty")) {
    $("#historyEmpty").classList.toggle(
      "hidden",
      history.length > 0
    );
  }

  history.forEach((o) => {
    const row = document.createElement("div");
    row.className = "history-row";

    const body = document.createElement("div");

    const date = document.createElement("div");
    date.className = "history-date";

    date.textContent = o.completed_at
      ? fmtTimestamp(o.completed_at)
      : fmtDate(o.ordered_on);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = o.product_name;

    body.append(date, meta);

    const qty = document.createElement("div");
    qty.className = "history-qty";
    qty.textContent = `Qty ${Number(o.quantity) || 0}`;

    row.append(body, qty);
    host.append(row);
  });
}

$("#authForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    if (!supabase) return;

    msg($("#authMessage"));

    const email = $("#email").value.trim();
    const password = $("#password").value;

    const { data, error } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (error) {
      msg($("#authMessage"), error.message);
      return;
    }

    session = data.session;

    await loadWorkspace();
  }
);

$("#signUpBtn").addEventListener(
  "click",
  async () => {
    if (!supabase) return;

    const email = $("#email").value.trim();
    const password = $("#password").value;

    if (!email || password.length < 6) {
      msg(
        $("#authMessage"),
        "Enter an email and a password of at least 6 characters."
      );
      return;
    }

    const { data, error } =
      await supabase.auth.signUp({
        email,
        password,
      });

    if (error) {
      msg($("#authMessage"), error.message);
      return;
    }

    if (!data.session) {
      msg(
        $("#authMessage"),
        "Account created. Check your email if confirmation is enabled, then sign in."
      );
    } else {
      session = data.session;
      await loadWorkspace();
    }
  }
);

$("#createWorkspaceForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    const name = $("#workspaceName").value.trim();

    const { error } = await supabase.rpc(
      "create_workspace",
      {
        p_name: name,
      }
    );

    if (error) {
      msg($("#workspaceMessage"), error.message);
      return;
    }

    await loadWorkspace();
  }
);

$("#joinWorkspaceForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    const code = $("#inviteCode")
      .value.trim()
      .toUpperCase();

    const { error } = await supabase.rpc(
      "join_workspace",
      {
        p_invite_code: code,
      }
    );

    if (error) {
      msg($("#workspaceMessage"), error.message);
      return;
    }

    await loadWorkspace();
  }
);

$("#productForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    msg($("#productMessage"));

    const name = $("#productName").value.trim();

    if (!name) {
      msg(
        $("#productMessage"),
        "Enter a product name."
      );
      return;
    }

    const defaultQuantity = Math.max(
      1,
      Math.min(
        999,
        Number($("#defaultQty").value) || 1
      )
    );

    const duplicate = products.find(
      (p) =>
        p.name.trim().toLowerCase() ===
        name.toLowerCase()
    );

    if (duplicate) {
      msg(
        $("#productMessage"),
        "This product already exists."
      );
      return;
    }

    const { error } = await supabase
      .from("products")
      .insert({
        workspace_id: workspace.id,
        name,
        default_quantity: defaultQuantity,
        created_by: session.user.id,
      });

    if (error) {
      msg($("#productMessage"), error.message);
      return;
    }

    $("#productName").value = "";
    $("#defaultQty").value = "1";
    $("#productName").focus();

    await refreshAll();
  }
);

$("#demoBtn").addEventListener(
  "click",
  async () => {
    const demo = [
      ["Coca-Cola 20oz", 4],
      ["Sprite 20oz", 2],
      ["Diet Coke 20oz", 1],
      ["Red Bull 12oz", 2],
      ["Monster Original", 2],
      ["Monster Mango", 1],
    ];

    const existingNames = new Set(
      products.map((p) =>
        p.name.trim().toLowerCase()
      )
    );

    const rows = demo
      .filter(
        ([name]) =>
          !existingNames.has(
            name.toLowerCase()
          )
      )
      .map(([name, default_quantity]) => ({
        workspace_id: workspace.id,
        name,
        default_quantity,
        created_by: session.user.id,
      }));

    if (!rows.length) {
      msg(
        $("#productMessage"),
        "Example products already exist."
      );
      return;
    }

    const { error } = await supabase
      .from("products")
      .insert(rows);

    if (error) {
      msg($("#productMessage"), error.message);
      return;
    }

    await refreshAll();
  }
);

$$(".main-tab").forEach((btn) =>
  btn.addEventListener(
    "click",
    () => showMain(btn.dataset.screen)
  )
);

function showMain(name) {
  $("#weekScreen").classList.toggle(
    "hidden",
    name !== "week"
  );

  $("#productsScreen").classList.toggle(
    "hidden",
    name !== "products"
  );

  $("#historyScreen").classList.toggle(
    "hidden",
    name !== "history"
  );

  $$(".main-tab").forEach((b) =>
    b.classList.toggle(
      "active",
      b.dataset.screen === name
    )
  );
}

$("#goProductsBtn").addEventListener(
  "click",
  () => showMain("products")
);

$("#inviteBtn").addEventListener(
  "click",
  () => $("#inviteDialog").showModal()
);

async function signOut() {
  if (channel) {
    await supabase.removeChannel(channel);
  }

  await supabase.auth.signOut();

  session = null;
  workspace = null;
  memberRole = "staff";
  products = [];
  orders = [];

  setScreen("auth");
}

$("#signOutBtn").addEventListener(
  "click",
  signOut
);

$("#workspaceSignOut").addEventListener(
  "click",
  signOut
);

if (supabase) {
  supabase.auth.onAuthStateChange(
    (_e, s) => {
      session = s;

      if (!s) {
        setScreen("auth");
      }
    }
  );
}

bootstrap();
