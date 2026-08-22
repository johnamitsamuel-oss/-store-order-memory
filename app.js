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
let products = [];
let orders = [];
let channel = null;

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeekKey() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;

  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);

  return localDateKey(d);
}

function parseDateKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(a, b) {
  return Math.floor((parseDateKey(b) - parseDateKey(a)) / 86400000);
}

function addDays(k, n) {
  const d = parseDateKey(k);
  d.setDate(d.getDate() + n);
  return localDateKey(d);
}

function fmtDate(k) {
  return parseDateKey(k).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function msg(el, text = "") {
  el.textContent = text;
}

function setScreen(name) {
  authCard.classList.toggle("hidden", name !== "auth");
  workspaceCard.classList.toggle("hidden", name !== "workspace");
  app.classList.toggle("hidden", name !== "app");
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
  if (!supabase) return setScreen("auth");

  const { data } = await supabase.auth.getSession();
  session = data.session;

  if (!session) return setScreen("auth");

  await loadWorkspace();
}

async function loadWorkspace() {
  const { data, error } = await supabase
    .from("workspace_members")
    .select("workspace_id, workspaces(id,name,invite_code)")
    .eq("user_id", session.user.id)
    .limit(1)
    .maybeSingle();

  if (error) {
    msg($("#workspaceMessage"), error.message);
    return setScreen("workspace");
  }

  if (!data?.workspaces) {
    return setScreen("workspace");
  }

  workspace = data.workspaces;

  $("#workspaceTitle").textContent = workspace.name;
  $("#inviteCodeDisplay").textContent = workspace.invite_code;

  setScreen("app");

  await refreshAll();
  subscribeRealtime();
}

async function refreshAll() {
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
      .order("ordered_on", { ascending: false })
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

function latestOrderFor(productId) {
  return orders.find((o) => o.product_id === productId) || null;
}

function currentWeekOrder(productId) {
  const start = startOfWeekKey();

  return (
    orders.find(
      (o) => o.product_id === productId && o.ordered_on >= start
    ) || null
  );
}

function dueInfo(product) {
  const last = latestOrderFor(product.id);

  if (!last) {
    return {
      status: "never",
      label: "Never ordered — due now",
      due: true,
      next: localDateKey(),
      last: null,
    };
  }

  const next = addDays(last.ordered_on, product.reorder_weeks * 7);
  const delta = daysBetween(localDateKey(), next);

  if (delta <= 0) {
    return {
      status: "due-now",
      label:
        delta < 0
          ? `Overdue by ${Math.abs(delta)} day${Math.abs(delta) === 1 ? "" : "s"}`
          : "Due today",
      due: true,
      next,
      last,
    };
  }

  if (delta <= 7) {
    return {
      status: "due-soon",
      label: `Due in ${delta} day${delta === 1 ? "" : "s"}`,
      due: false,
      next,
      last,
    };
  }

  return {
    status: "not-due",
    label: `Next due ${fmtDate(next)}`,
    due: false,
    next,
    last,
  };
}

function suggestedQty(product) {
  const last = latestOrderFor(product.id);
  return last?.quantity || product.default_quantity;
}

function renderAll() {
  renderStats();
  renderWeek();
  renderProducts();
  renderHistory();
}

function renderStats() {
  const due = products.filter(
    (p) => dueInfo(p).due && !currentWeekOrder(p.id)
  ).length;

  const week = orders.filter(
    (o) => o.ordered_on >= startOfWeekKey()
  ).length;

  $("#dueCount").textContent = due;
  $("#weekOrderedCount").textContent = week;
  $("#productCount").textContent = products.length;
}

function renderWeek() {
  const host = $("#weekList");
  host.innerHTML = "";

  $("#weekEmpty").classList.toggle("hidden", products.length > 0);

  const sorted = [...products].sort((a, b) => {
    const ao = !!currentWeekOrder(a.id);
    const bo = !!currentWeekOrder(b.id);

    if (ao !== bo) return ao ? 1 : -1;

    const ad = dueInfo(a);
    const bd = dueInfo(b);

    if (ad.due !== bd.due) return ad.due ? -1 : 1;

    return a.name.localeCompare(b.name);
  });

  sorted.forEach((product) => {
    const info = dueInfo(product);
    const weekOrder = currentWeekOrder(product.id);

    const row = document.createElement("div");
    row.className = "order-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "check";
    check.checked = !!weekOrder;
    check.setAttribute(
      "aria-label",
      `Mark ${product.name} ordered`
    );

    const body = document.createElement("div");

    const title = document.createElement("div");
    title.className = `item-title${weekOrder ? " ordered" : ""}`;
    title.textContent = product.name;

    const badge = document.createElement("span");
    badge.className = `due ${info.status}`;
    badge.textContent = weekOrder
      ? `Ordered this week — Qty ${weekOrder.quantity}`
      : info.label;

    body.append(title, badge);

    const controls = document.createElement("div");
    controls.className = "qty-controls";

    const minus = document.createElement("button");
    const qty = document.createElement("span");
    const plus = document.createElement("button");

    minus.type = "button";
    plus.type = "button";

    minus.className = "mini";
    plus.className = "mini";

    minus.textContent = "−";
    plus.textContent = "+";

    let draftQty = weekOrder?.quantity || suggestedQty(product);

    qty.className = "qty-pill";
    qty.textContent = `Qty ${draftQty}`;

    const setQty = (n) => {
      draftQty = Math.max(1, Math.min(999, n));
      qty.textContent = `Qty ${draftQty}`;

      if (weekOrder) {
        updateOrder(weekOrder.id, {
          quantity: draftQty,
        });
      }
    };

    minus.addEventListener("click", () => {
      setQty(draftQty - 1);
    });

    plus.addEventListener("click", () => {
      setQty(draftQty + 1);
    });

    check.addEventListener("change", async () => {
      if (check.checked) {
        const { error } = await supabase
          .from("orders")
          .insert({
            workspace_id: workspace.id,
            product_id: product.id,
            product_name: product.name,
            quantity: draftQty,
            ordered_on: localDateKey(),
            ordered_by: session.user.id,
          });

        if (error) {
          check.checked = false;
          msg($("#appMessage"), error.message);
        }
      } else if (weekOrder) {
        await deleteOrder(weekOrder.id);
      }
    });

    controls.append(minus, qty, plus);
    row.append(check, body, controls);
    host.append(row);
  });
}

function renderProducts() {
  const host = $("#productList");
  host.innerHTML = "";

  $("#productEmpty").classList.toggle(
    "hidden",
    products.length > 0
  );

  products.forEach((p) => {
    const last = latestOrderFor(p.id);
    const info = dueInfo(p);

    const row = document.createElement("div");
    row.className = "product-row";

    const body = document.createElement("div");

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = p.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent =
      `Every ${p.reorder_weeks} week${p.reorder_weeks === 1 ? "" : "s"}` +
      ` • Usual qty ${p.default_quantity}` +
      ` • Last ${
        last
          ? `${fmtDate(last.ordered_on)} / ${last.quantity}`
          : "never ordered"
      }`;

    const badge = document.createElement("span");
    badge.className = `due ${info.status}`;
    badge.textContent = info.label;

    body.append(title, meta, badge);

    const actions = document.createElement("div");
    actions.className = "product-actions";

    const cycleDown = button(
      "− week",
      "mini",
      () =>
        updateProduct(p.id, {
          reorder_weeks: Math.max(
            1,
            p.reorder_weeks - 1
          ),
        })
    );

    const cycleUp = button(
      "+ week",
      "mini",
      () =>
        updateProduct(p.id, {
          reorder_weeks: Math.min(
            52,
            p.reorder_weeks + 1
          ),
        })
    );

    const remove = button(
      "Archive",
      "mini delete",
      () =>
        updateProduct(p.id, {
          active: false,
        })
    );

    actions.append(cycleDown, cycleUp, remove);
    row.append(body, actions);
    host.append(row);
  });
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
  host.innerHTML = "";

  $("#historyEmpty").classList.toggle(
    "hidden",
    orders.length > 0
  );

  orders.forEach((o) => {
    const row = document.createElement("div");
    row.className = "history-row";

    const body = document.createElement("div");

    const date = document.createElement("div");
    date.className = "history-date";
    date.textContent = fmtDate(o.ordered_on);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = o.product_name;

    body.append(date, meta);

    const qty = document.createElement("div");
    qty.className = "history-qty";
    qty.textContent = `Qty ${o.quantity}`;

    row.append(body, qty);
    host.append(row);
  });
}

async function updateProduct(id, patch) {
  const { error } = await supabase
    .from("products")
    .update(patch)
    .eq("id", id);

  if (error) {
    msg($("#appMessage"), error.message);
  }
}

async function updateOrder(id, patch) {
  const { error } = await supabase
    .from("orders")
    .update(patch)
    .eq("id", id);

  if (error) {
    msg($("#appMessage"), error.message);
  }
}

async function deleteOrder(id) {
  const { error } = await supabase
    .from("orders")
    .delete()
    .eq("id", id);

  if (error) {
    msg($("#appMessage"), error.message);
  }
}

$("#authForm").addEventListener("submit", async (e) => {
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
    return msg($("#authMessage"), error.message);
  }

  session = data.session;

  await loadWorkspace();
});

$("#signUpBtn").addEventListener("click", async () => {
  if (!supabase) return;

  const email = $("#email").value.trim();
  const password = $("#password").value;

  if (!email || password.length < 6) {
    return msg(
      $("#authMessage"),
      "Enter an email and a password of at least 6 characters."
    );
  }

  const { data, error } =
    await supabase.auth.signUp({
      email,
      password,
    });

  if (error) {
    return msg($("#authMessage"), error.message);
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
});

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
      return msg(
        $("#workspaceMessage"),
        error.message
      );
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
      return msg(
        $("#workspaceMessage"),
        error.message
      );
    }

    await loadWorkspace();
  }
);

$("#productForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    const name = $("#productName").value.trim();

    const reorder_weeks = Math.max(
      1,
      Math.min(
        52,
        Number($("#reorderWeeks").value) || 1
      )
    );

    const default_quantity = Math.max(
      1,
      Math.min(
        999,
        Number($("#defaultQty").value) || 1
      )
    );

    const { error } = await supabase
      .from("products")
      .insert({
        workspace_id: workspace.id,
        name,
        reorder_weeks,
        default_quantity,
        created_by: session.user.id,
      });

    if (error) {
      return msg(
        $("#productMessage"),
        error.message
      );
    }

    $("#productName").value = "";
    $("#defaultQty").value = "1";
    $("#productName").focus();
  }
);

$("#demoBtn").addEventListener(
  "click",
  async () => {
    const demo = [
      ["Coca-Cola 20oz", 1, 4],
      ["Sprite 20oz", 1, 2],
      ["Diet Coke 20oz", 2, 1],
      ["Red Bull 12oz", 1, 2],
      ["Monster Original", 2, 2],
      ["Monster Mango", 3, 1],
    ];

    const rows = demo.map(
      ([name, reorder_weeks, default_quantity]) => ({
        workspace_id: workspace.id,
        name,
        reorder_weeks,
        default_quantity,
        created_by: session.user.id,
      })
    );

    const { error } = await supabase
      .from("products")
      .insert(rows);

    if (error) {
      msg(
        $("#productMessage"),
        error.message
      );
    }
  }
);

$$(".main-tab").forEach((btn) =>
  btn.addEventListener("click", () =>
    showMain(btn.dataset.screen)
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
