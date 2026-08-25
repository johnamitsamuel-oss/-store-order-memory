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

const draftQty = new Map();
const selectedOrderIds = new Set();

/* =====================================================
   HELPERS
===================================================== */

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

function fmtTime(value) {
  if (!value) return "";

  return new Date(value).toLocaleTimeString("en-US", {
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

function activeOrders() {
  return orders.filter(
    (o) => !o.status || o.status === "active"
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

function button(text, cls, fn) {
  const b = document.createElement("button");

  b.type = "button";
  b.className = cls;
  b.textContent = text;

  b.addEventListener("click", fn);

  return b;
}

/* =====================================================
   DATE
===================================================== */

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

/* =====================================================
   STARTUP
===================================================== */

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
  $("#inviteCodeDisplay").textContent =
    workspace.invite_code;

  setScreen("app");

  await refreshAll();
  subscribeRealtime();

  showMain("products");
}

/* =====================================================
   LOAD DATABASE
===================================================== */

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

/* =====================================================
   REALTIME
===================================================== */

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

/* =====================================================
   RENDER ALL
===================================================== */

function renderAll() {
  hideOldStats();
  prepareProductResultArea();

  renderProducts();
  renderCurrentOrders();
  renderHistory();
}

/* =====================================================
   REMOVE USELESS CURRENT ORDER STATS
===================================================== */

function hideOldStats() {
  const stats = $(".stats-grid");

  if (stats) {
    stats.classList.add("hidden");
  }
}

/* =====================================================
   PRODUCT RESULT AREA

   We reuse the old Store Products card,
   but it is now ONLY the search result.
===================================================== */

function prepareProductResultArea() {
  const host = $("#productList");

  if (!host) return;

  const card = host.closest(".list-card");

  if (!card) return;

  const heading = card.querySelector("h2");

  if (heading) {
    heading.textContent = "Product result";
  }

  const eyebrow = card.querySelector(".eyebrow");

  if (eyebrow) {
    eyebrow.textContent = "Order";
  }

  const description = card.querySelector(".muted");

  if (description) {
    description.textContent =
      "Adjust quantity here and press Done.";
  }
}

/* =====================================================
   PRODUCTS TAB

   TYPE -> MATCH -> +/- -> DONE
===================================================== */

function renderProducts() {
  const host = $("#productList");

  if (!host) return;

  host.innerHTML = "";

  const input = $("#productName");

  const query =
    (input?.value || "")
      .trim()
      .toLowerCase();

  const empty = $("#productEmpty");

  /*
    Nothing typed:
    do NOT show giant product database.
  */
  if (!query) {
    if (empty) {
      empty.classList.remove("hidden");

      empty.textContent =
        "Type a product name above to start an order.";
    }

    return;
  }

  /*
    Find matching products while typing.
  */
  const matches = products.filter((p) =>
    p.name
      .toLowerCase()
      .includes(query)
  );

  if (!matches.length) {
    if (empty) {
      empty.classList.remove("hidden");

      empty.textContent =
        "No matching product. Use Add new product if this is a new item.";
    }

    return;
  }

  if (empty) {
    empty.classList.add("hidden");
  }

  matches.forEach((product) => {
    renderProductResult(
      host,
      product
    );
  });
}

function renderProductResult(host, product) {
  const active =
    activeOrderFor(product.id);

  /*
    Current database quantity.
    If not currently ordered -> 0.
  */
  const databaseQty =
    active
      ? Math.max(
          0,
          Number(active.quantity) || 0
        )
      : 0;

  /*
    Initialize draft only once.
  */
  if (!draftQty.has(product.id)) {
    draftQty.set(
      product.id,
      databaseQty
    );
  }

  const row =
    document.createElement("div");

  row.className = "product-row";

  const body =
    document.createElement("div");

  const title =
    document.createElement("div");

  title.className = "item-title";
  title.textContent = product.name;

  const meta =
    document.createElement("div");

  meta.className = "meta";

  meta.textContent = active
    ? `Current order: Qty ${databaseQty}`
    : "Not currently on order";

  body.append(
    title,
    meta
  );

  const actions =
    document.createElement("div");

  actions.className =
    "product-actions";

  const qtyControls =
    document.createElement("div");

  qtyControls.className =
    "qty-controls";

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

  const currentDraft =
    Math.max(
      0,
      Number(
        draftQty.get(product.id)
      ) || 0
    );

  qty.className = "qty-pill";
  qty.textContent =
    `Qty ${currentDraft}`;

  minus.addEventListener(
    "click",
    () => {
      const old =
        Number(
          draftQty.get(product.id)
        ) || 0;

      const next =
        Math.max(0, old - 1);

      draftQty.set(
        product.id,
        next
      );

      renderProducts();
    }
  );

  plus.addEventListener(
    "click",
    () => {
      const old =
        Number(
          draftQty.get(product.id)
        ) || 0;

      const next =
        Math.min(999, old + 1);

      draftQty.set(
        product.id,
        next
      );

      renderProducts();
    }
  );

  qtyControls.append(
    minus,
    qty,
    plus
  );

  const done = button(
    "Done",
    "primary",
    async () => {
      await confirmProductOrder(product);
    }
  );

  /*
    New/currently absent product cannot
    be sent to Current Orders at Qty 0.

    BUT once it is already on Current Orders,
    Qty 0 IS allowed and remains pending.
  */
  if (!active && currentDraft === 0) {
    done.disabled = true;
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
    qtyControls,
    done,
    edit,
    remove
  );

  row.append(
    body,
    actions
  );

  host.append(row);
}

/* =====================================================
   LIVE PRODUCT SEARCH
===================================================== */

if ($("#productName")) {
  $("#productName")
    .addEventListener(
      "input",
      () => {
        /*
          A different search should initialize
          from current database quantity.
        */
        renderProducts();
      }
    );
}

/* =====================================================
   DONE PRODUCT

   Add/update Current Orders.
===================================================== */

async function confirmProductOrder(product) {
  msg($("#productMessage"));
  msg($("#appMessage"));

  const quantity =
    Math.max(
      0,
      Math.min(
        999,
        Number(
          draftQty.get(product.id)
        ) || 0
      )
    );

  const active =
    activeOrderFor(product.id);

  /*
    EXISTING CURRENT ORDER

    Qty 0 is valid here.
    Item remains in Current Orders.
  */
  if (active) {
    const { error } =
      await supabase
        .from("orders")
        .update({
          quantity,
          product_name:
            product.name,
        })
        .eq("id", active.id);

    if (error) {
      msg(
        $("#productMessage"),
        error.message
      );

      return;
    }

    msg(
      $("#productMessage"),
      `${product.name} updated to Qty ${quantity}.`
    );

    draftQty.delete(product.id);

    await refreshAll();

    /*
      Stay on Products.
      Clear search ready for next item.
    */
    $("#productName").value = "";

    renderProducts();

    return;
  }

  /*
    NEW CURRENT ORDER

    Need at least Qty 1 initially.
  */
  if (quantity <= 0) {
    msg(
      $("#productMessage"),
      "Set quantity before pressing Done."
    );

    return;
  }

  const { error } =
    await supabase
      .from("orders")
      .insert({
        workspace_id:
          workspace.id,

        product_id:
          product.id,

        product_name:
          product.name,

        quantity,

        ordered_on:
          localDateKey(),

        ordered_by:
          session.user.id,

        status:
          "active",
      });

  if (error) {
    msg(
      $("#productMessage"),
      error.message
    );

    return;
  }

  msg(
    $("#productMessage"),
    `${product.name} added to Current Orders — Qty ${quantity}.`
  );

  draftQty.delete(product.id);

  await refreshAll();

  /*
    Products stays HOME.
    Search clears for next product.
  */
  $("#productName").value = "";

  renderProducts();
}

/* =====================================================
   ADD NEW PRODUCT

   No Usual Qty concept.
===================================================== */

$("#productForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    msg($("#productMessage"));

    const name =
      $("#productName")
        .value
        .trim();

    if (!name) {
      msg(
        $("#productMessage"),
        "Enter a product name."
      );

      return;
    }

    /*
      Prevent duplicate product names.
    */
    const existing =
      products.find(
        (p) =>
          p.name
            .trim()
            .toLowerCase() ===
          name.toLowerCase()
      );

    if (existing) {
      msg(
        $("#productMessage"),
        `${existing.name} already exists. Adjust its quantity below.`
      );

      draftQty.set(
        existing.id,
        activeOrderFor(existing.id)
          ? Number(
              activeOrderFor(
                existing.id
              ).quantity
            ) || 0
          : 0
      );

      renderProducts();

      return;
    }

    /*
      Database may still require
      default_quantity column,
      so silently save 1.

      User never sees/uses it.
    */
    const { data, error } =
      await supabase
        .from("products")
        .insert({
          workspace_id:
            workspace.id,

          name,

          default_quantity:
            1,

          created_by:
            session.user.id,
        })
        .select()
        .single();

    if (error) {
      msg(
        $("#productMessage"),
        error.message
      );

      return;
    }

    /*
      Brand-new product starts at Qty 1
      in the search result.

      It is NOT Current Order yet.
      User still presses Done.
    */
    draftQty.set(
      data.id,
      1
    );

    msg(
      $("#productMessage"),
      `${name} created. Confirm quantity below and press Done.`
    );

    await refreshAll();

    /*
      KEEP the typed name in search box,
      so the new product appears immediately.
    */
    $("#productName").value =
      name;

    draftQty.set(
      data.id,
      1
    );

    renderProducts();
  }
);

/* =====================================================
   EDIT PRODUCT
===================================================== */

async function editProduct(product) {
  const newName =
    window.prompt(
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

  const { error } =
    await supabase
      .from("products")
      .update({
        name: cleanName,
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
    Update ACTIVE order name.

    Completed History is NOT changed.
  */
  const active =
    activeOrderFor(product.id);

  if (active) {
    const { error: activeError } =
      await supabase
        .from("orders")
        .update({
          product_name:
            cleanName,
        })
        .eq("id", active.id);

    if (activeError) {
      msg(
        $("#productMessage"),
        activeError.message
      );

      return;
    }
  }

  $("#productName").value =
    cleanName;

  await refreshAll();
  renderProducts();
}

/* =====================================================
   DELETE PRODUCT

   Deletes/retire from product database.
   Completed History remains untouched.
===================================================== */

async function deleteProduct(product) {
  const active =
    activeOrderFor(product.id);

  let warning =
    `Delete ${product.name} from the product database?`;

  if (active) {
    warning +=
      "\n\nIt is also on Current Orders and will be removed from there.";
  }

  const ok =
    window.confirm(warning);

  if (!ok) return;

  if (active) {
    const { error: orderError } =
      await supabase
        .from("orders")
        .delete()
        .eq("id", active.id);

    if (orderError) {
      msg(
        $("#productMessage"),
        orderError.message
      );

      return;
    }

    selectedOrderIds.delete(
      active.id
    );
  }

  /*
    Try permanent deletion first.
  */
  const { error } =
    await supabase
      .from("products")
      .delete()
      .eq("id", product.id);

  /*
    If database relationship blocks delete,
    retire/hide product instead.
  */
  if (error) {
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
        softError.message
      );

      return;
    }
  }

  draftQty.delete(product.id);

  $("#productName").value = "";

  msg(
    $("#productMessage"),
    `${product.name} removed.`
  );

  await refreshAll();
}

/* =====================================================
   CURRENT ORDERS

   REVIEW ONLY:
   checkbox + product + quantity

   NO + / -
===================================================== */

function renderCurrentOrders() {
  const host = $("#weekList");

  if (!host) return;

  host.innerHTML = "";

  /*
    Remove old Complete Selected button
    before rebuilding screen.
  */
  const oldBtn =
    $("#completeOrderBtn");

  if (oldBtn) {
    oldBtn.remove();
  }

  const active =
    [...activeOrders()].sort(
      (a, b) =>
        String(
          a.product_name || ""
        ).localeCompare(
          String(
            b.product_name || ""
          )
        )
    );

  const empty =
    $("#weekEmpty");

  if (!active.length) {
    if (empty) {
      empty.classList.remove(
        "hidden"
      );

      const h =
        empty.querySelector("h3");

      const p =
        empty.querySelector("p");

      if (h) {
        h.textContent =
          "No items in current order";
      }

      if (p) {
        p.textContent =
          "Go to Products to build the current order.";
      }
    }

    return;
  }

  if (empty) {
    empty.classList.add("hidden");
  }

  active.forEach((order) => {
    const row =
      document.createElement("div");

    row.className =
      "order-row";

    const check =
      document.createElement("input");

    check.type =
      "checkbox";

    check.className =
      "check";

    check.checked =
      selectedOrderIds.has(
        order.id
      );

    check.setAttribute(
      "aria-label",
      `Select ${order.product_name}`
    );

    check.addEventListener(
      "change",
      () => {
        if (check.checked) {
          selectedOrderIds.add(
            order.id
          );
        } else {
          selectedOrderIds.delete(
            order.id
          );
        }

        updateCompleteSelectedButton();
      }
    );

    const body =
      document.createElement("div");

    const title =
      document.createElement("div");

    title.className =
      "item-title";

    title.textContent =
      order.product_name;

    const qty =
      document.createElement("div");

    qty.className = "meta";

    qty.textContent =
      `Qty ${Math.max(
        0,
        Number(
          order.quantity
        ) || 0
      )}`;

    body.append(
      title,
      qty
    );

    row.append(
      check,
      body
    );

    host.append(row);
  });

  /*
    Complete Selected goes AFTER all products.
  */
  ensureCompleteSelectedButton();
}

/* =====================================================
   COMPLETE SELECTED BUTTON
===================================================== */

function ensureCompleteSelectedButton() {
  const host =
    $("#weekList");

  if (!host) return;

  if (!isSenior()) {
    return;
  }

  const btn =
    document.createElement("button");

  btn.id =
    "completeOrderBtn";

  btn.type =
    "button";

  btn.className =
    "primary";

  btn.addEventListener(
    "click",
    completeSelectedOrders
  );

  /*
    Put button AFTER product list.
  */
  host.parentElement.append(
    btn
  );

  updateCompleteSelectedButton();
}

function updateCompleteSelectedButton() {
  const btn =
    $("#completeOrderBtn");

  if (!btn) return;

  const count =
    selectedOrderIds.size;

  btn.disabled =
    count === 0;

  btn.textContent =
    count
      ? `Complete Selected (${count})`
      : "Complete Selected";
}

/* =====================================================
   COMPLETE SELECTED ORDER BATCH
===================================================== */

async function completeSelectedOrders() {
  if (!isSenior()) {
    msg(
      $("#appMessage"),
      "Only a manager or owner can complete an order."
    );

    return;
  }

  const selected =
    activeOrders().filter(
      (o) =>
        selectedOrderIds.has(
          o.id
        )
    );

  if (!selected.length) {
    msg(
      $("#appMessage"),
      "Select at least one product."
    );

    return;
  }

  const totalQty =
    selected.reduce(
      (sum, order) =>
        sum +
        Math.max(
          0,
          Number(
            order.quantity
          ) || 0
        ),
      0
    );

  const ok =
    window.confirm(
      `Complete ${selected.length} product${
        selected.length === 1
          ? ""
          : "s"
      } with total quantity ${totalQty}?`
    );

  if (!ok) return;

  /*
    Same Batch ID for everything selected
    in THIS completion click.
  */
  const batchId =
    crypto.randomUUID();

  const completedAt =
    new Date().toISOString();

  const ids =
    selected.map(
      (o) => o.id
    );

  const { error } =
    await supabase
      .from("orders")
      .update({
        status:
          "completed",

        completed_at:
          completedAt,

        completed_by:
          session.user.id,

        completion_batch_id:
          batchId,
      })
      .in("id", ids);

  if (error) {
    msg(
      $("#appMessage"),
      error.message
    );

    return;
  }

  selected.forEach((order) => {
    selectedOrderIds.delete(
      order.id
    );

    draftQty.delete(
      order.product_id
    );
  });

  msg(
    $("#appMessage"),
    `Order completed: ${selected.length} product${
      selected.length === 1
        ? ""
        : "s"
    }, ${totalQty} total quantity.`
  );

  await refreshAll();

  showMain("week");
}

/* =====================================================
   HISTORY

   KEEP CURRENT WORKING STRUCTURE:
   DATE -> BATCH -> PRODUCTS
===================================================== */

function renderHistory() {
  const host =
    $("#historyList");

  if (!host) return;

  host.innerHTML = "";

  const history =
    [...completedOrders()].sort(
      (a, b) =>
        new Date(
          b.completed_at ||
            b.updated_at ||
            b.created_at
        ) -
        new Date(
          a.completed_at ||
            a.updated_at ||
            a.created_at
        )
    );

  const empty =
    $("#historyEmpty");

  if (empty) {
    empty.classList.toggle(
      "hidden",
      history.length > 0
    );
  }

  if (!history.length) {
    return;
  }

  /*
    DATE GROUPS
  */
  const dateGroups =
    new Map();

  history.forEach((order) => {
    const completedValue =
      order.completed_at ||
      order.updated_at ||
      order.created_at;

    const dateKey =
      completedValue
        ? localDateKey(
            new Date(
              completedValue
            )
          )
        : order.ordered_on;

    if (!dateGroups.has(dateKey)) {
      dateGroups.set(
        dateKey,
        []
      );
    }

    dateGroups
      .get(dateKey)
      .push(order);
  });

  const dates =
    [...dateGroups.keys()]
      .sort(
        (a, b) =>
          parseDateKey(b) -
          parseDateKey(a)
      );

  dates.forEach((dateKey) => {
    const dateOrders =
      dateGroups.get(
        dateKey
      );

    const dayFolder =
      document.createElement(
        "details"
      );

    dayFolder.className =
      "history-day";

    const daySummary =
      document.createElement(
        "summary"
      );

    daySummary.className =
      "history-day-summary";

    daySummary.textContent =
      fmtDate(dateKey);

    dayFolder.append(
      daySummary
    );

    /*
      BATCH GROUPS
    */
    const batches =
      new Map();

    dateOrders.forEach((order) => {
      const batchKey =
        order.completion_batch_id ||
        `old-${order.id}`;

      if (!batches.has(batchKey)) {
        batches.set(
          batchKey,
          []
        );
      }

      batches
        .get(batchKey)
        .push(order);
    });

    const batchList =
      [...batches.values()]
        .sort(
          (a, b) =>
            new Date(
              b[0].completed_at ||
                b[0].created_at
            ) -
            new Date(
              a[0].completed_at ||
                a[0].created_at
            )
        );

    batchList.forEach((batch) => {
      const productCount =
        batch.length;

      const totalQty =
        batch.reduce(
          (sum, order) =>
            sum +
            Math.max(
              0,
              Number(
                order.quantity
              ) || 0
            ),
          0
        );

      const completedAt =
        batch[0].completed_at ||
        batch[0].created_at;

      const batchFolder =
        document.createElement(
          "details"
        );

      batchFolder.className =
        "history-batch";

      const summary =
        document.createElement(
          "summary"
        );

      summary.className =
        "history-batch-summary";

      const time =
        fmtTime(completedAt);

      summary.textContent =
        `Order completed — ${productCount} product${
          productCount === 1
            ? ""
            : "s"
        } — ${totalQty} quantit${
          totalQty === 1
            ? "y"
            : "ies"
        }${
          time
            ? ` — ${time}`
            : ""
        }`;

      batchFolder.append(
        summary
      );

      batch.forEach((order) => {
        const row =
          document.createElement(
            "div"
          );

        row.className =
          "history-row";

        const title =
          document.createElement(
            "div"
          );

        title.className =
          "history-date";

        title.textContent =
          order.product_name;

        const qty =
          document.createElement(
            "div"
          );

        qty.className =
          "history-qty";

        qty.textContent =
          `Qty ${Math.max(
            0,
            Number(
              order.quantity
            ) || 0
          )}`;

        row.append(
          title,
          qty
        );

        batchFolder.append(
          row
        );
      });

      dayFolder.append(
        batchFolder
      );
    });

    host.append(
      dayFolder
    );
  });
}

/* =====================================================
   LOGIN
===================================================== */

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

    session =
      data.session;

    await loadWorkspace();
  }
);

/* =====================================================
   CREATE ACCOUNT
===================================================== */

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
      session =
        data.session;

      await loadWorkspace();
    }
  }
);

/* =====================================================
   WORKSPACE
===================================================== */

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
        .value
        .trim()
        .toUpperCase();

    const { error } =
      await supabase.rpc(
        "join_workspace",
        {
          p_invite_code:
            code,
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

/* =====================================================
   DEMO PRODUCTS
===================================================== */

$("#demoBtn").addEventListener(
  "click",
  async () => {
    const demo = [
      "Coca-Cola 20oz",
      "Sprite 20oz",
      "Diet Coke 20oz",
      "Red Bull 12oz",
      "Monster Original",
      "Monster Mango",
    ];

    const existingNames =
      new Set(
        products.map((p) =>
          p.name
            .trim()
            .toLowerCase()
        )
      );

    const rows =
      demo
        .filter(
          (name) =>
            !existingNames.has(
              name.toLowerCase()
            )
        )
        .map((name) => ({
          workspace_id:
            workspace.id,

          name,

          default_quantity:
            1,

          created_by:
            session.user.id,
        }));

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

/* =====================================================
   TABS
===================================================== */

$$(".main-tab").forEach((btn) =>
  btn.addEventListener(
    "click",
    () =>
      showMain(
        btn.dataset.screen
      )
  )
);

function showMain(name) {
  $("#weekScreen")
    .classList.toggle(
      "hidden",
      name !== "week"
    );

  $("#productsScreen")
    .classList.toggle(
      "hidden",
      name !== "products"
    );

  $("#historyScreen")
    .classList.toggle(
      "hidden",
      name !== "history"
    );

  $$(".main-tab").forEach((b) =>
    b.classList.toggle(
      "active",
      b.dataset.screen === name
    )
  );

  if (name === "products") {
    /*
      Re-sync drafts from Current Orders
      when returning to Products.
    */
    draftQty.clear();

    renderProducts();
  }

  if (name === "week") {
    renderCurrentOrders();
  }

  if (name === "history") {
    renderHistory();
  }
}

/* =====================================================
   GO PRODUCTS
===================================================== */

$("#goProductsBtn").addEventListener(
  "click",
  () =>
    showMain("products")
);

/* =====================================================
   INVITE
===================================================== */

$("#inviteBtn").addEventListener(
  "click",
  () =>
    $("#inviteDialog")
      .showModal()
);

/* =====================================================
   SIGN OUT
===================================================== */

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

  draftQty.clear();
  selectedOrderIds.clear();

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
    (_event, s) => {
      session = s;

      if (!s) {
        setScreen("auth");
      }
    }
  );
}

/* =====================================================
   START
===================================================== */

bootstrap();
