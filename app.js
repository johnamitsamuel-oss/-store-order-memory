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

/*
  Stores which ACTIVE order rows are checked
  for "Complete Selected".
*/
const selectedOrderIds = new Set();

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(
    d.getMonth() + 1
  ).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function parseDateKey(k) {
  if (!k) return new Date();

  const [y, m, d] = k.split("-").map(Number);

  return new Date(y, m - 1, d);
}

function fmtDate(k) {
  if (!k) return "";

  return parseDateKey(k).toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  );
}

function fmtTime(value) {
  if (!value) return "";

  return new Date(value).toLocaleTimeString(
    "en-US",
    {
      hour: "numeric",
      minute: "2-digit",
    }
  );
}

function historyDateKey(order) {
  const value =
    order.completed_at ||
    order.updated_at ||
    order.created_at;

  if (!value) {
    return order.ordered_on || localDateKey();
  }

  return localDateKey(new Date(value));
}

function msg(el, text = "") {
  if (el) {
    el.textContent = text;
  }
}

function setScreen(name) {
  authCard.classList.toggle(
    "hidden",
    name !== "auth"
  );

  workspaceCard.classList.toggle(
    "hidden",
    name !== "workspace"
  );

  app.classList.toggle(
    "hidden",
    name !== "app"
  );
}

function isSenior() {
  return [
    "manager",
    "owner",
    "boss",
    "admin",
  ].includes(
    String(memberRole || "").toLowerCase()
  );
}

$("#todayLabel").textContent =
  new Date().toLocaleDateString("en-US", {
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

  const { data } =
    await supabase.auth.getSession();

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
    msg(
      $("#workspaceMessage"),
      error.message
    );

    setScreen("workspace");
    return;
  }

  if (!data?.workspaces) {
    setScreen("workspace");
    return;
  }

  workspace = data.workspaces;
  memberRole = data.role || "staff";

  $("#workspaceTitle").textContent =
    workspace.name;

  $("#inviteCodeDisplay").textContent =
    workspace.invite_code;

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
      .order("name", {
        ascending: true,
      }),

    supabase
      .from("orders")
      .select("*")
      .eq("workspace_id", workspace.id)
      .order("created_at", {
        ascending: false,
      }),
  ]);

  if (p.error) {
    msg(
      $("#appMessage"),
      p.error.message
    );
  } else {
    products = p.data || [];
  }

  if (o.error) {
    msg(
      $("#appMessage"),
      o.error.message
    );
  } else {
    orders = o.data || [];
  }

  /*
    If an item disappeared because it was
    completed/deleted, remove its checkbox
    selection too.
  */
  const activeIds = new Set(
    activeOrders().map((o) => o.id)
  );

  [...selectedOrderIds].forEach((id) => {
    if (!activeIds.has(id)) {
      selectedOrderIds.delete(id);
    }
  });

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
        filter:
          `workspace_id=eq.${workspace.id}`,
      },
      refreshAll
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "orders",
        filter:
          `workspace_id=eq.${workspace.id}`,
      },
      refreshAll
    )
    .subscribe();
}

/* =========================
   ORDER HELPERS
========================= */

function activeOrders() {
  return orders.filter(
    (o) =>
      !o.status ||
      o.status === "active"
  );
}

function completedOrders() {
  return orders.filter(
    (o) => o.status === "completed"
  );
}

function activeOrderFor(productId) {
  return (
    activeOrders().find(
      (o) => o.product_id === productId
    ) || null
  );
}

function productFor(productId) {
  return (
    products.find(
      (p) => p.id === productId
    ) || null
  );
}

function startingQty(product) {
  return Math.max(
    0,
    Math.min(
      999,
      Number(product.default_quantity) || 1
    )
  );
}

/* =========================
   RENDER EVERYTHING
========================= */

function renderAll() {
  renderStats();
  renderWeek();
  renderProducts();
  renderHistory();
}

/* =========================
   TOP COUNTERS
========================= */

function renderStats() {
  const active = activeOrders();

  /*
    Qty 0 products remain on Current Order,
    but they do NOT count as "Items on order".
  */
  const positiveOrders = active.filter(
    (o) =>
      (Number(o.quantity) || 0) > 0
  );

  if ($("#dueCount")) {
    $("#dueCount").textContent =
      positiveOrders.length;
  }

  if ($("#weekOrderedCount")) {
    $("#weekOrderedCount").textContent =
      positiveOrders.reduce(
        (sum, o) =>
          sum +
          Math.max(
            0,
            Number(o.quantity) || 0
          ),
        0
      );
  }

  if ($("#productCount")) {
    $("#productCount").textContent =
      products.length;
  }
}

/* =========================
   CURRENT ORDER
========================= */

function renderWeek() {
  const host = $("#weekList");

  if (!host) return;

  host.innerHTML = "";

  const active = activeOrders();

  ensureCompleteSelectedButton();

  /*
    Current Order empty message is based on
    ACTIVE ORDERS — not number of products.
  */
  if ($("#weekEmpty")) {
    $("#weekEmpty").classList.toggle(
      "hidden",
      active.length > 0
    );
  }

  /*
    IMPORTANT:
    Current Order shows ONLY active order items.
    Products not added to order are NOT rendered.
  */
  const sorted = [...active].sort(
    (a, b) =>
      String(a.product_name || "").localeCompare(
        String(b.product_name || "")
      )
  );

  sorted.forEach((order) => {
    const row =
      document.createElement("div");

    row.className = "order-row";

    /* Checkbox */

    const check =
      document.createElement("input");

    check.type = "checkbox";
    check.className = "check";

    check.checked =
      selectedOrderIds.has(order.id);

    check.setAttribute(
      "aria-label",
      `Select ${order.product_name}`
    );

    check.addEventListener(
      "change",
      () => {
        if (check.checked) {
          selectedOrderIds.add(order.id);
        } else {
          selectedOrderIds.delete(order.id);
        }

        updateCompleteSelectedButton();
      }
    );

    /* Product info */

    const body =
      document.createElement("div");

    const title =
      document.createElement("div");

    title.className = "item-title";
    title.textContent =
      order.product_name;

    const status =
      document.createElement("span");

    status.className = "due due-now";
    status.textContent = "Active order";

    body.append(title, status);

    /* Quantity controls */

    const controls =
      document.createElement("div");

    controls.className = "qty-controls";

    const minus =
      document.createElement("button");

    const qty =
      document.createElement("span");

    const plus =
      document.createElement("button");

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
    qty.textContent =
      `Qty ${currentQty}`;

    minus.addEventListener(
      "click",
      async () => {
        await changeOrderQty(
          order,
          Math.max(
            0,
            currentQty - 1
          )
        );
      }
    );

    plus.addEventListener(
      "click",
      async () => {
        await changeOrderQty(
          order,
          Math.min(
            999,
            currentQty + 1
          )
        );
      }
    );

    controls.append(
      minus,
      qty,
      plus
    );

    row.append(
      check,
      body,
      controls
    );

    host.append(row);
  });
}

function ensureCompleteSelectedButton() {
  const host = $("#weekList");

  if (!host) return;

  let btn = $("#completeOrderBtn");

  if (!isSenior()) {
    if (btn) {
      btn.remove();
    }

    return;
  }

  if (!btn) {
    btn =
      document.createElement("button");

    btn.id = "completeOrderBtn";
    btn.type = "button";
    btn.className = "primary";

    btn.addEventListener(
      "click",
      completeSelectedOrders
    );

    host.parentElement.insertBefore(
      btn,
      host
    );
  }

  btn.textContent =
    "Complete Selected";

  updateCompleteSelectedButton();
}

function updateCompleteSelectedButton() {
  const btn = $("#completeOrderBtn");

  if (!btn) return;

  const count =
    selectedOrderIds.size;

  btn.disabled = count === 0;

  btn.textContent =
    count > 0
      ? `Complete Selected (${count})`
      : "Complete Selected";
}

/* =========================
   ADD PRODUCT TO ORDER
========================= */

async function addActiveOrder(product) {
  msg($("#appMessage"));

  const alreadyActive =
    activeOrderFor(product.id);

  if (alreadyActive) {
    msg(
      $("#appMessage"),
      `${product.name} is already on the current order.`
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
    msg(
      $("#appMessage"),
      error.message
    );

    return;
  }

  msg(
    $("#appMessage"),
    `${product.name} added to current order.`
  );

  await refreshAll();
}

/* =========================
   CHANGE ORDER QUANTITY
========================= */

async function changeOrderQty(
  order,
  quantity
) {
  const safeQty = Math.max(
    0,
    Math.min(
      999,
      Number(quantity) || 0
    )
  );

  const { error } = await supabase
    .from("orders")
    .update({
      quantity: safeQty,
    })
    .eq("id", order.id);

  if (error) {
    msg(
      $("#appMessage"),
      error.message
    );

    return;
  }

  await refreshAll();
}

/* =========================
   COMPLETE SELECTED ONLY
========================= */

async function completeSelectedOrders() {
  if (!isSenior()) {
    msg(
      $("#appMessage"),
      "Only a manager or owner can complete an order."
    );

    return;
  }

  const active = activeOrders();

  const selected = active.filter(
    (o) =>
      selectedOrderIds.has(o.id)
  );

  if (!selected.length) {
    msg(
      $("#appMessage"),
      "Select at least one item to complete."
    );

    return;
  }

  const ok = window.confirm(
    `Complete ${selected.length} selected item${
      selected.length === 1
        ? ""
        : "s"
    }?`
  );

  if (!ok) return;

  const ids =
    selected.map((o) => o.id);

  const { error } = await supabase
    .from("orders")
    .update({
      status: "completed",
      completed_at:
        new Date().toISOString(),
      completed_by:
        session.user.id,
    })
    .in("id", ids);

  if (error) {
    msg(
      $("#appMessage"),
      error.message
    );

    return;
  }

  ids.forEach((id) =>
    selectedOrderIds.delete(id)
  );

  msg(
    $("#appMessage"),
    `${selected.length} selected item${
      selected.length === 1
        ? ""
        : "s"
    } moved to history.`
  );

  await refreshAll();
}

/* =========================
   PRODUCTS TAB
========================= */

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
    const active =
      activeOrderFor(product.id);

    const row =
      document.createElement("div");

    row.className = "product-row";

    const body =
      document.createElement("div");

    const title =
      document.createElement("div");

    title.className = "item-title";
    title.textContent =
      product.name;

    const meta =
      document.createElement("div");

    meta.className = "meta";

    meta.textContent =
      `Usual qty ${
        Number(
          product.default_quantity
        ) || 1
      }` +
      (active
        ? ` • Current order qty ${
            Number(active.quantity) || 0
          }`
        : "");

    body.append(title, meta);

    const actions =
      document.createElement("div");

    actions.className =
      "product-actions";

    /*
      Products tab is where items are added
      to the Current Order.
    */
    if (!active) {
      const add = button(
        "Add",
        "mini",
        async () => {
          await addActiveOrder(product);
        }
      );

      actions.append(add);
    } else {
      const onOrder =
        document.createElement("span");

      onOrder.className =
        "due due-now";

      onOrder.textContent =
        "On current order";

      actions.append(onOrder);
    }

    const edit = button(
      "Edit",
      "mini",
      () => editProduct(product)
    );

    const remove = button(
      "Delete",
      "mini delete",
      () => deleteProduct(product)
    );

    actions.append(
      edit,
      remove
    );

    row.append(
      body,
      actions
    );

    host.append(row);
  });
}

/* =========================
   EDIT PRODUCT
========================= */

async function editProduct(product) {
  const newName = window.prompt(
    "Product name",
    product.name
  );

  if (newName === null) return;

  const cleanName =
    newName.trim();

  if (!cleanName) {
    msg(
      $("#productMessage"),
      "Product name cannot be empty."
    );

    return;
  }

  const duplicate =
    products.find(
      (p) =>
        p.id !== product.id &&
        p.name
          .trim()
          .toLowerCase() ===
          cleanName.toLowerCase()
    );

  if (duplicate) {
    msg(
      $("#productMessage"),
      "Another product already has this name."
    );

    return;
  }

  const qtyInput =
    window.prompt(
      "Usual quantity",
      String(
        product.default_quantity || 1
      )
    );

  if (qtyInput === null) return;

  const defaultQuantity =
    Math.max(
      1,
      Math.min(
        999,
        Number(qtyInput) || 1
      )
    );

  const { error } = await supabase
    .from("products")
    .update({
      name: cleanName,
      default_quantity:
        defaultQuantity,
    })
    .eq("id", product.id);

  if (error) {
    msg(
      $("#productMessage"),
      error.message
    );

    return;
  }

  /*
    If currently on active order, also update
    the copied display name there.
  */
  const active =
    activeOrderFor(product.id);

  if (active) {
    await supabase
      .from("orders")
      .update({
        product_name: cleanName,
      })
      .eq("id", active.id);
  }

  msg(
    $("#productMessage"),
    `${cleanName} updated.`
  );

  await refreshAll();
}

/* =========================
   DELETE PRODUCT
========================= */

async function deleteProduct(product) {
  const ok = window.confirm(
    `Permanently delete ${product.name}?`
  );

  if (!ok) return;

  const active =
    activeOrderFor(product.id);

  /*
    If product is currently on the order,
    ask separately before removing that
    active row.
  */
  if (active) {
    const removeActive =
      window.confirm(
        `${product.name} is currently on the active order. Delete it from the current order too?`
      );

    if (!removeActive) {
      return;
    }

    const { error: activeError } =
      await supabase
        .from("orders")
        .delete()
        .eq("id", active.id);

    if (activeError) {
      msg(
        $("#productMessage"),
        activeError.message
      );

      return;
    }

    selectedOrderIds.delete(
      active.id
    );
  }

  /*
    First try real database deletion.
    Completed history stores product_name,
    quantity and completion details separately.
  */
  const { error } = await supabase
    .from("products")
    .delete()
    .eq("id", product.id);

  if (error) {
    /*
      Some databases may have a foreign-key
      rule preventing physical deletion.
      If that happens, hide it from the master
      list instead while preserving history.
    */
    const { error: softError } =
      await supabase
        .from("products")
        .update({
          active: false,
        })
        .eq("id", product.id);

    if (softError) {
      msg(
        $("#productMessage"),
        error.message
      );

      return;
    }
  }

  msg(
    $("#productMessage"),
    `${product.name} deleted.`
  );

  await refreshAll();
}

/* =========================
   GENERIC BUTTON
========================= */

function button(
  text,
  cls,
  fn
) {
  const b =
    document.createElement("button");

  b.type = "button";
  b.className = cls;
  b.textContent = text;

  b.addEventListener(
    "click",
    fn
  );

  return b;
}

/* =========================
   HISTORY
   COLLAPSIBLE BY DATE
========================= */

function renderHistory() {
  const host = $("#historyList");

  if (!host) return;

  host.innerHTML = "";

  const history =
    [...completedOrders()].sort(
      (a, b) => {
        const aTime =
          new Date(
            a.completed_at ||
              a.updated_at ||
              a.created_at
          ).getTime();

        const bTime =
          new Date(
            b.completed_at ||
              b.updated_at ||
              b.created_at
          ).getTime();

        return bTime - aTime;
      }
    );

  if ($("#historyEmpty")) {
    $("#historyEmpty").classList.toggle(
      "hidden",
      history.length > 0
    );
  }

  if (!history.length) {
    return;
  }

  /*
    Group all completed orders
    by local calendar date.
  */
  const groups = new Map();

  history.forEach((order) => {
    const key =
      historyDateKey(order);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(order);
  });

  /*
    Newest date first.
  */
  const sortedDates =
    [...groups.keys()].sort(
      (a, b) =>
        parseDateKey(b) -
        parseDateKey(a)
    );

  sortedDates.forEach(
    (dateKey) => {
      const items =
        groups.get(dateKey);

      const folder =
        document.createElement(
          "details"
        );

      folder.className =
        "history-day";

      const summary =
        document.createElement(
          "summary"
        );

      summary.className =
        "history-day-summary";

      summary.textContent =
        `${fmtDate(dateKey)} — ${
          items.length
        } item${
          items.length === 1
            ? ""
            : "s"
        }`;

      folder.append(summary);

      items.forEach((o) => {
        const row =
          document.createElement(
            "div"
          );

        row.className =
          "history-row";

        const body =
          document.createElement(
            "div"
          );

        const title =
          document.createElement(
            "div"
          );

        title.className =
          "history-date";

        title.textContent =
          o.product_name;

        const meta =
          document.createElement(
            "div"
          );

        meta.className = "meta";

        meta.textContent =
          o.completed_at
            ? `Completed ${fmtTime(
                o.completed_at
              )}`
            : "";

        body.append(
          title,
          meta
        );

        const qty =
          document.createElement(
            "div"
          );

        qty.className =
          "history-qty";

        qty.textContent =
          `Qty ${
            Number(o.quantity) || 0
          }`;

        row.append(
          body,
          qty
        );

        folder.append(row);
      });

      host.append(folder);
    }
  );
}

/* =========================
   AUTH
========================= */

$("#authForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    if (!supabase) return;

    msg($("#authMessage"));

    const email =
      $("#email").value.trim();

    const password =
      $("#password").value;

    const { data, error } =
      await supabase.auth
        .signInWithPassword({
          email,
          password,
        });

    if (error) {
      msg(
        $("#authMessage"),
        error.message
      );

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

    const email =
      $("#email").value.trim();

    const password =
      $("#password").value;

    if (
      !email ||
      password.length < 6
    ) {
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
      msg(
        $("#authMessage"),
        error.message
      );

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

/* =========================
   WORKSPACE
========================= */

$("#createWorkspaceForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    const name =
      $("#workspaceName")
        .value.trim();

    const { error } =
      await supabase.rpc(
        "create_workspace",
        {
          p_name: name,
        }
      );

    if (error) {
      msg(
        $("#workspaceMessage"),
        error.message
      );

      return;
    }

    await loadWorkspace();
  }
);

$("#joinWorkspaceForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    const code =
      $("#inviteCode")
        .value.trim()
        .toUpperCase();

    const { error } =
      await supabase.rpc(
        "join_workspace",
        {
          p_invite_code: code,
        }
      );

    if (error) {
      msg(
        $("#workspaceMessage"),
        error.message
      );

      return;
    }

    await loadWorkspace();
  }
);

/* =========================
   ADD NEW PRODUCT
========================= */

$("#productForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    msg($("#productMessage"));

    const name =
      $("#productName")
        .value.trim();

    if (!name) {
      msg(
        $("#productMessage"),
        "Enter a product name."
      );

      return;
    }

    const defaultQuantity =
      Math.max(
        1,
        Math.min(
          999,
          Number(
            $("#defaultQty").value
          ) || 1
        )
      );

    const duplicate =
      products.find(
        (p) =>
          p.name
            .trim()
            .toLowerCase() ===
          name.toLowerCase()
      );

    if (duplicate) {
      msg(
        $("#productMessage"),
        "This product already exists."
      );

      return;
    }

    const { error } =
      await supabase
        .from("products")
        .insert({
          workspace_id:
            workspace.id,
          name,
          default_quantity:
            defaultQuantity,
          created_by:
            session.user.id,
        });

    if (error) {
      msg(
        $("#productMessage"),
        error.message
      );

      return;
    }

    $("#productName").value = "";
    $("#defaultQty").value = "1";

    $("#productName").focus();

    await refreshAll();
  }
);

/* =========================
   DEMO PRODUCTS
========================= */

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

    const existingNames =
      new Set(
        products.map((p) =>
          p.name
            .trim()
            .toLowerCase()
        )
      );

    const rows = demo
      .filter(
        ([name]) =>
          !existingNames.has(
            name.toLowerCase()
          )
      )
      .map(
        ([
          name,
          default_quantity,
        ]) => ({
          workspace_id:
            workspace.id,
          name,
          default_quantity,
          created_by:
            session.user.id,
        })
      );

    if (!rows.length) {
      msg(
        $("#productMessage"),
        "Example products already exist."
      );

      return;
    }

    const { error } =
      await supabase
        .from("products")
        .insert(rows);

    if (error) {
      msg(
        $("#productMessage"),
        error.message
      );

      return;
    }

    await refreshAll();
  }
);

/* =========================
   MAIN TABS
========================= */

$$(".main-tab").forEach(
  (btn) =>
    btn.addEventListener(
      "click",
      () =>
        showMain(
          btn.dataset.screen
        )
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

  $$(".main-tab").forEach(
    (b) =>
      b.classList.toggle(
        "active",
        b.dataset.screen === name
      )
  );
}

$("#goProductsBtn").addEventListener(
  "click",
  () =>
    showMain("products")
);

/* =========================
   INVITE
========================= */

$("#inviteBtn").addEventListener(
  "click",
  () =>
    $("#inviteDialog")
      .showModal()
);

/* =========================
   SIGN OUT
========================= */

async function signOut() {
  if (channel) {
    await supabase.removeChannel(
      channel
    );
  }

  await supabase.auth.signOut();

  session = null;
  workspace = null;
  memberRole = "staff";
  products = [];
  orders = [];

  selectedOrderIds.clear();

  setScreen("auth");
}

$("#signOutBtn").addEventListener(
  "click",
  signOut
);

$("#workspaceSignOut")
  .addEventListener(
    "click",
    signOut
  );

if (supabase) {
  supabase.auth.onAuthStateChange(
    (_event, s) => {
      session = s;

      if (!s) {
        setScreen("auth");
      }
    }
  );
}

bootstrap();
