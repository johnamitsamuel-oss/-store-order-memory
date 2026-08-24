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
  Product quantity being edited on Products tab.

  IMPORTANT:
  Changing +/- does NOT immediately change Current Order.
  User must press Done.
*/
const draftQty = new Map();

/*
  Current Order checkboxes selected for completion.
*/
const selectedOrderIds = new Set();

/* =====================================================
   BASIC HELPERS
===================================================== */

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

/* =====================================================
   AUTH / STARTUP
===================================================== */

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

  /*
    PRODUCTS IS THE HOME PAGE.
  */
  showMain("products");
}

/* =====================================================
   DATABASE LOAD
===================================================== */

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
    Remove checkbox selections belonging
    to orders that are no longer active.
  */
  const activeIds = new Set(
    activeOrders().map((o) => o.id)
  );

  [...selectedOrderIds].forEach((id) => {
    if (!activeIds.has(id)) {
      selectedOrderIds.delete(id);
    }
  });

  /*
    Do NOT overwrite a quantity currently
    being edited in Products tab.

    But initialize drafts for products that
    do not yet have one.
  */
  products.forEach((product) => {
    if (!draftQty.has(product.id)) {
      const active =
        activeOrderFor(product.id);

      draftQty.set(
        product.id,
        active
          ? Math.max(
              0,
              Number(active.quantity) || 0
            )
          : 0
      );
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

/* =====================================================
   ORDER HELPERS
===================================================== */

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

/* =====================================================
   RENDER ALL
===================================================== */

function renderAll() {
  renderStats();
  renderCurrentOrders();
  renderProducts();
  renderHistory();
}

/* =====================================================
   COUNTERS
===================================================== */

function renderStats() {
  const active = activeOrders();

  const positive = active.filter(
    (o) =>
      (Number(o.quantity) || 0) > 0
  );

  if ($("#dueCount")) {
    $("#dueCount").textContent =
      positive.length;
  }

  if ($("#weekOrderedCount")) {
    $("#weekOrderedCount").textContent =
      positive.reduce(
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

/* =====================================================
   CURRENT ORDERS TAB

   REVIEW ONLY.
   NO +/- HERE.
===================================================== */

function renderCurrentOrders() {
  const host = $("#weekList");

  if (!host) return;

  host.innerHTML = "";

  const active = [...activeOrders()].sort(
    (a, b) =>
      String(
        a.product_name || ""
      ).localeCompare(
        String(b.product_name || "")
      )
  );

  ensureCompleteSelectedButton();

  if ($("#weekEmpty")) {
    $("#weekEmpty").classList.toggle(
      "hidden",
      active.length > 0
    );

    const emptyTitle =
      $("#weekEmpty h3");

    const emptyText =
      $("#weekEmpty p");

    if (emptyTitle) {
      emptyTitle.textContent =
        "No items in current order";
    }

    if (emptyText) {
      emptyText.textContent =
        "Go to Products to build the current order.";
    }
  }

  active.forEach((order) => {
    const row =
      document.createElement("div");

    row.className = "order-row";

    /*
      Checkbox first
    */
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

    /*
      Product name + quantity
    */
    const body =
      document.createElement("div");

    const title =
      document.createElement("div");

    title.className = "item-title";
    title.textContent =
      order.product_name;

    const meta =
      document.createElement("div");

    meta.className = "meta";
    meta.textContent =
      `Qty ${Math.max(
        0,
        Number(order.quantity) || 0
      )}`;

    body.append(
      title,
      meta
    );

    /*
      No quantity buttons in Current Orders.
    */
    row.append(
      check,
      body
    );

    host.append(row);
  });
}

/* =====================================================
   COMPLETE SELECTED BUTTON
===================================================== */

function ensureCompleteSelectedButton() {
  const host = $("#weekList");

  if (!host) return;

  let btn =
    $("#completeOrderBtn");

  /*
    Keeping current role behavior for now.
    Hierarchy itself comes later.
  */
  if (!isSenior()) {
    if (btn) {
      btn.remove();
    }

    return;
  }

  if (!btn) {
    btn =
      document.createElement("button");

    btn.id =
      "completeOrderBtn";

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
    count > 0
      ? `Complete Selected (${count})`
      : "Complete Selected";
}

/* =====================================================
   PRODUCTS TAB

   THIS IS THE MAIN WORK SCREEN.
===================================================== */

function renderProducts() {
  const host =
    $("#productList");

  if (!host) return;

  host.innerHTML = "";

  /*
    If user types something in Product box,
    filter the Store Products list.
  */
  const searchText =
    ($("#productName")?.value || "")
      .trim()
      .toLowerCase();

  const visibleProducts =
    searchText
      ? products.filter((p) =>
          p.name
            .toLowerCase()
            .includes(searchText)
        )
      : products;

  if ($("#productEmpty")) {
    $("#productEmpty").classList.toggle(
      "hidden",
      visibleProducts.length > 0
    );

    if (
      !visibleProducts.length &&
      searchText
    ) {
      $("#productEmpty").textContent =
        "No matching product found.";
    } else {
      $("#productEmpty").textContent =
        "No products added yet.";
    }
  }

  visibleProducts.forEach(
    (product) => {
      const active =
        activeOrderFor(product.id);

      /*
        If another user changed this item
        after our local draft was already
        confirmed, reset draft to current
        database qty whenever it is not dirty.
      */
      if (!draftQty.has(product.id)) {
        draftQty.set(
          product.id,
          active
            ? Math.max(
                0,
                Number(active.quantity) || 0
              )
            : 0
        );
      }

      const row =
        document.createElement("div");

      row.className =
        "product-row";

      const body =
        document.createElement("div");

      const title =
        document.createElement("div");

      title.className =
        "item-title";

      title.textContent =
        product.name;

      const meta =
        document.createElement("div");

      meta.className = "meta";

      meta.textContent =
        active
          ? `Current order qty ${Math.max(
              0,
              Number(active.quantity) || 0
            )}`
          : "Not on current order";

      body.append(
        title,
        meta
      );

      /*
        Quantity editing controls
      */
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
          const n =
            Math.max(
              0,
              (Number(
                draftQty.get(
                  product.id
                )
              ) || 0) - 1
            );

          draftQty.set(
            product.id,
            n
          );

          renderProducts();
        }
      );

      plus.addEventListener(
        "click",
        () => {
          const n =
            Math.min(
              999,
              (Number(
                draftQty.get(
                  product.id
                )
              ) || 0) + 1
            );

          draftQty.set(
            product.id,
            n
          );

          renderProducts();
        }
      );

      qtyControls.append(
        minus,
        qty,
        plus
      );

      /*
        DONE confirms this quantity into
        Current Orders.

        If current order already exists,
        Done updates it instead of creating
        duplicate.
      */
      const done = button(
        "Done",
        "primary",
        async () => {
          await confirmProductOrder(
            product
          );
        }
      );

      /*
        New item must be at least Qty 1.

        Existing current order may be
        confirmed at Qty 0 if user wants
        to keep it pending.
      */
      if (
        !active &&
        currentDraft === 0
      ) {
        done.disabled = true;
      }

      const edit = button(
        "Edit",
        "mini",
        () =>
          editProduct(product)
      );

      const remove = button(
        "Delete",
        "mini delete",
        () =>
          deleteProduct(product)
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
  );
}

/* =====================================================
   PRODUCT SEARCH

   As user types ZYN / Marlboro / etc,
   matching Store Products immediately show.
===================================================== */

if ($("#productName")) {
  $("#productName").addEventListener(
    "input",
    () => {
      renderProducts();
    }
  );
}

/* =====================================================
   DONE / CONFIRM PRODUCT QUANTITY
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
    Existing Current Order:
    update its quantity.
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
      `${product.name} current order updated to Qty ${quantity}.`
    );

    /*
      Reset local draft to exactly
      what was confirmed.
    */
    draftQty.set(
      product.id,
      quantity
    );

    await refreshAll();

    /*
      Stay on Products.
    */
    showMain("products");

    return;
  }

  /*
    New Current Order cannot start at zero.
  */
  if (quantity <= 0) {
    msg(
      $("#productMessage"),
      "Set the quantity before pressing Done."
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

  draftQty.set(
    product.id,
    quantity
  );

  await refreshAll();

  /*
    User remains on Products page
    to make another order.
  */
  showMain("products");
}

/* =====================================================
   COMPLETE SELECTED

   ONE CLICK = ONE HISTORY BATCH
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
      "Select at least one item."
    );

    return;
  }

  const totalQty =
    selected.reduce(
      (sum, o) =>
        sum +
        Math.max(
          0,
          Number(o.quantity) || 0
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
    Every item completed in THIS click
    receives the SAME batch ID.
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
        status: "completed",

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

  /*
    Reset product drafts for items
    that just left Current Order.
  */
  selected.forEach((order) => {
    selectedOrderIds.delete(
      order.id
    );

    draftQty.set(
      order.product_id,
      0
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
   EDIT PRODUCT
===================================================== */

async function editProduct(product) {
  const newName =
    window.prompt(
      "Product name",
      product.name
    );

  if (newName === null) {
    return;
  }

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
        name:
          cleanName,
      })
      .eq(
        "id",
        product.id
      );

  if (error) {
    msg(
      $("#productMessage"),
      error.message
    );

    return;
  }

  /*
    If product is currently pending,
    update its current display name too.

    Old completed history stays unchanged.
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
        .eq(
          "id",
          active.id
        );

    if (activeError) {
      msg(
        $("#productMessage"),
        activeError.message
      );

      return;
    }
  }

  msg(
    $("#productMessage"),
    `${cleanName} updated.`
  );

  await refreshAll();
}

/* =====================================================
   DELETE PRODUCT

   OLD HISTORY IS PRESERVED.
===================================================== */

async function deleteProduct(product) {
  const active =
    activeOrderFor(product.id);

  let text =
    `Permanently delete ${product.name} from Store Products?`;

  if (active) {
    text +=
      "\n\nThis product is also on Current Orders and will be removed from there.";
  }

  const ok =
    window.confirm(text);

  if (!ok) return;

  /*
    Remove current pending order first,
    if one exists.
  */
  if (active) {
    const { error: orderError } =
      await supabase
        .from("orders")
        .delete()
        .eq(
          "id",
          active.id
        );

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
    Try physical delete.
  */
  const { error } =
    await supabase
      .from("products")
      .delete()
      .eq(
        "id",
        product.id
      );

  if (error) {
    /*
      If FK prevents physical deletion,
      hide/retire product instead.
    */
    const { error: softError } =
      await supabase
        .from("products")
        .update({
          active: false,
        })
        .eq(
          "id",
          product.id
        );

    if (softError) {
      msg(
        $("#productMessage"),
        softError.message
      );

      return;
    }
  }

  draftQty.delete(
    product.id
  );

  msg(
    $("#productMessage"),
    `${product.name} deleted from Store Products.`
  );

  await refreshAll();
}

/* =====================================================
   HISTORY

   DATE
     -> COMPLETION BATCH
       -> PRODUCTS
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
    First group by completed local DATE.
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
    [...dateGroups.keys()].sort(
      (a, b) =>
        parseDateKey(b) -
        parseDateKey(a)
    );

  dates.forEach(
    (dateKey) => {
      const dateOrders =
        dateGroups.get(dateKey);

      /*
        Outer collapsible DATE folder
      */
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
        Inside date:
        group by completion_batch_id.

        Old history records that existed
        before batch IDs were introduced
        get their own fallback grouping.
      */
      const batches =
        new Map();

      dateOrders.forEach(
        (order) => {
          const key =
            order.completion_batch_id ||
            `old-${order.id}`;

          if (!batches.has(key)) {
            batches.set(
              key,
              []
            );
          }

          batches
            .get(key)
            .push(order);
        }
      );

      /*
        Sort batches newest first.
      */
      const batchList =
        [...batches.values()]
          .sort(
            (a, b) =>
              new Date(
                b[0]
                  .completed_at ||
                  b[0]
                    .created_at
              ) -
              new Date(
                a[0]
                  .completed_at ||
                  a[0]
                    .created_at
              )
          );

      batchList.forEach(
        (batch) => {
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
            batch[0]
              .completed_at ||
            batch[0]
              .created_at;

          /*
            Each completion batch is
            also expandable.
          */
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
            fmtTime(
              completedAt
            );

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

          batch.forEach(
            (order) => {
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
            }
          );

          dayFolder.append(
            batchFolder
          );
        }
      );

      host.append(
        dayFolder
      );
    }
  );
}

/* =====================================================
   GENERIC BUTTON
===================================================== */

function button(
  text,
  cls,
  fn
) {
  const b =
    document.createElement(
      "button"
    );

  b.type = "button";
  b.className = cls;
  b.textContent = text;

  b.addEventListener(
    "click",
    fn
  );

  return b;
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
      $("#email")
        .value.trim();

    const password =
      $("#password")
        .value;

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
      $("#email")
        .value.trim();

    const password =
      $("#password")
        .value;

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
      await supabase.auth
        .signUp({
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

$("#createWorkspaceForm")
  .addEventListener(
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

$("#joinWorkspaceForm")
  .addEventListener(
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
   ADD NEW STORE PRODUCT

   "Usual Qty" is NO LONGER USED.

   default_quantity = 1 is kept silently only
   for compatibility with the existing database
   if that column is still required.
===================================================== */

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

    const duplicate =
      products.find(
        (p) =>
          p.name
            .trim()
            .toLowerCase() ===
          name.toLowerCase()
      );

    if (duplicate) {
      /*
        Existing item:
        do NOT create another copy.

        Keep search text so user sees
        the existing product below.
      */
      msg(
        $("#productMessage"),
        `${duplicate.name} already exists. Adjust its quantity below.`
      );

      renderProducts();
      return;
    }

    const { error } =
      await supabase
        .from("products")
        .insert({
          workspace_id:
            workspace.id,

          name,

          /*
            Compatibility only.
            Not used by app workflow.
          */
          default_quantity:
            1,

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

    /*
      Clear search after genuinely
      creating new product.
    */
    $("#productName").value =
      "";

    if ($("#defaultQty")) {
      $("#defaultQty").value =
        "1";
    }

    await refreshAll();

    showMain("products");
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
        .map(
          (name) => ({
            workspace_id:
              workspace.id,

            name,

            default_quantity:
              1,

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

/* =====================================================
   TABS
===================================================== */

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

  $$(".main-tab").forEach(
    (b) =>
      b.classList.toggle(
        "active",
        b.dataset.screen === name
      )
  );

  /*
    When opening Products,
    synchronize drafts with current DB qty
    unless user is actively searching.
  */
  if (name === "products") {
    products.forEach(
      (product) => {
        const active =
          activeOrderFor(
            product.id
          );

        draftQty.set(
          product.id,
          active
            ? Math.max(
                0,
                Number(
                  active.quantity
                ) || 0
              )
            : 0
        );
      }
    );

    renderProducts();
  }
}

/* =====================================================
   EMPTY CURRENT ORDER -> PRODUCTS
===================================================== */

$("#goProductsBtn")
  .addEventListener(
    "click",
    () => {
      showMain(
        "products"
      );
    }
  );

/* =====================================================
   INVITE
===================================================== */

$("#inviteBtn")
  .addEventListener(
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
    await supabase
      .removeChannel(
        channel
      );
  }

  await supabase.auth
    .signOut();

  session = null;
  workspace = null;
  memberRole = "staff";

  products = [];
  orders = [];

  draftQty.clear();
  selectedOrderIds.clear();

  setScreen("auth");
}

$("#signOutBtn")
  .addEventListener(
    "click",
    signOut
  );

$("#workspaceSignOut")
  .addEventListener(
    "click",
    signOut
  );

if (supabase) {
  supabase.auth
    .onAuthStateChange(
      (_event, s) => {
        session = s;

        if (!s) {
          setScreen(
            "auth"
          );
        }
      }
    );
}

/* =====================================================
   START
===================================================== */

bootstrap();
