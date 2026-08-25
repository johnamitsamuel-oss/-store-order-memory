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
   BASIC HELPERS
===================================================== */

function normalizeName(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

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

function button(text, cls, fn) {
  const b = document.createElement("button");

  b.type = "button";
  b.className = cls;
  b.textContent = text;

  b.addEventListener("click", fn);

  return b;
}

/* =====================================================
   ORDER HELPERS
===================================================== */

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

function matchingProducts(searchText) {
  const query = normalizeName(searchText);

  if (!query) return [];

  return products.filter((product) => {
    const name = normalizeName(product.name);

    return name.includes(query);
  });
}

/* =====================================================
   TODAY
===================================================== */

if ($("#todayLabel")) {
  $("#todayLabel").textContent =
    new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
}

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
    products = (p.data || []).filter(
      (product) => product.active !== false
    );
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
   RENDER EVERYTHING
===================================================== */

function renderAll() {
  hideOldStats();
  prepareProductResultArea();
  renderProducts();
  renderCurrentOrders();
  renderHistory();
}

/* =====================================================
   CURRENT ORDERS STATS ARE NOT NEEDED
===================================================== */

function hideOldStats() {
  const stats = $(".stats-grid");

  if (stats) {
    stats.classList.add("hidden");
  }
}

/* =====================================================
   PRODUCT RESULT AREA
===================================================== */

function prepareProductResultArea() {
  const host = $("#productList");

  if (!host) return;

  const card = host.closest(".list-card");

  if (!card) return;

  const heading = card.querySelector("h2");
  const eyebrow = card.querySelector(".eyebrow");
  const description = card.querySelector(".muted");

  if (heading) {
    heading.textContent = "Product result";
  }

  if (eyebrow) {
    eyebrow.textContent = "Order";
  }

  if (description) {
    description.textContent =
      "Adjust quantity here and press Done.";
  }
}

/* =====================================================
   PRODUCTS SCREEN
===================================================== */

function renderProducts() {
  const host = $("#productList");

  if (!host) return;

  host.innerHTML = "";

  const input = $("#productName");
  const empty = $("#productEmpty");

  const searchText =
    input?.value?.trim() || "";

  const query =
    normalizeName(searchText);

  const submitBtn =
    $("#productForm button[type='submit']");

  /*
    Nothing typed.
  */
  if (!query) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add new product";
    }

    if (empty) {
      empty.classList.remove("hidden");
      empty.textContent =
        "Type a product name above to start an order.";
    }

    return;
  }

  const matches =
    matchingProducts(searchText);

  /*
    IMPORTANT DUPLICATE RULE:

    If ANY existing product matches what
    the user typed, Add New Product is disabled.

    Example:
    Search = Zyn coolmint
    Existing = Zyn Coolmint 3

    User must use the existing result below,
    not accidentally create "Zyn coolmint".
  */
  if (matches.length > 0) {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent =
        "Matching product found";
    }
  } else {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent =
        "Add new product";
    }
  }

  if (!matches.length) {
    if (empty) {
      empty.classList.remove("hidden");
      empty.textContent =
        "No matching product. If this is a new item, press Add new product.";
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

/* =====================================================
   ONE PRODUCT SEARCH RESULT
===================================================== */

function renderProductResult(host, product) {
  const active =
    activeOrderFor(product.id);

  const savedQty =
    active
      ? Math.max(
          0,
          Number(active.quantity) || 0
        )
      : 0;

  if (!draftQty.has(product.id)) {
    draftQty.set(
      product.id,
      savedQty
    );
  }

  const currentDraft =
    Math.max(
      0,
      Number(
        draftQty.get(product.id)
      ) || 0
    );

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
    ? `Current order: Qty ${savedQty}`
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

  minus.type = "button";
  minus.className = "mini";
  minus.textContent = "−";

  const qty =
    document.createElement("span");

  qty.className = "qty-pill";
  qty.textContent =
    `Qty ${currentDraft}`;

  const plus =
    document.createElement("button");

  plus.type = "button";
  plus.className = "mini";
  plus.textContent = "+";

  minus.addEventListener(
    "click",
    () => {
      const old =
        Math.max(
          0,
          Number(
            draftQty.get(product.id)
          ) || 0
        );

      draftQty.set(
        product.id,
        Math.max(0, old - 1)
      );

      renderProducts();
    }
  );

  plus.addEventListener(
    "click",
    () => {
      const old =
        Math.max(
          0,
          Number(
            draftQty.get(product.id)
          ) || 0
        );

      draftQty.set(
        product.id,
        Math.min(999, old + 1)
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
    Brand-new current order cannot begin
    with Qty 0.

    But an ALREADY EXISTING current order
    is allowed to remain Qty 0.
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
   LIVE SEARCH
===================================================== */

if ($("#productName")) {
  $("#productName").addEventListener(
    "input",
    () => {
      msg($("#productMessage"));
      renderProducts();
    }
  );
}

/* =====================================================
   CONFIRM PRODUCT INTO CURRENT ORDERS
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
    Product already exists in Current Orders.

    Qty 0 is allowed.
    Item stays pending.
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

    draftQty.delete(
      product.id
    );

    await refreshAll();

    $("#productName").value = "";

    renderProducts();

    return;
  }

  /*
    Product is not yet in Current Orders.
  */
  if (quantity <= 0) {
    msg(
      $("#productMessage"),
      "Set quantity before pressing Done."
    );

    return;
  }

  /*
    Safety check against duplicate ACTIVE order.
    Useful when two users work at same time.
  */
  const { data: existingActive, error: checkError } =
    await supabase
      .from("orders")
      .select("*")
      .eq(
        "workspace_id",
        workspace.id
      )
      .eq(
        "product_id",
        product.id
      )
      .or(
        "status.eq.active,status.is.null"
      )
      .limit(1)
      .maybeSingle();

  if (checkError) {
    msg(
      $("#productMessage"),
      checkError.message
    );

    return;
  }

  if (existingActive) {
    msg(
      $("#productMessage"),
      `${product.name} is already on Current Orders at Qty ${Number(
        existingActive.quantity
      ) || 0}. Refreshing now.`
    );

    await refreshAll();

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

  draftQty.delete(
    product.id
  );

  await refreshAll();

  $("#productName").value = "";

  renderProducts();
}

/* =====================================================
   ADD NEW PRODUCT
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
      DUPLICATE PROTECTION #1

      If search text already finds any
      existing active product, do not create
      a new product.

      Example:
      "Zyn coolmint"
      already finds
      "Zyn Coolmint 3"
    */
    const matches =
      matchingProducts(name);

    if (matches.length > 0) {
      msg(
        $("#productMessage"),
        "Matching product already exists. Use the result below."
      );

      renderProducts();

      return;
    }

    /*
      DUPLICATE PROTECTION #2

      Exact active name check.
    */
    const exact =
      products.find(
        (product) =>
          normalizeName(product.name) ===
          normalizeName(name)
      );

    if (exact) {
      msg(
        $("#productMessage"),
        `${exact.name} already exists. Use the result below.`
      );

      renderProducts();

      return;
    }

    /*
      Check database for a previously deleted
      product with exactly the same name.

      If found, reactivate it instead of
      creating another duplicate row.
    */
    const { data: oldRows, error: oldError } =
      await supabase
        .from("products")
        .select("*")
        .eq(
          "workspace_id",
          workspace.id
        )
        .ilike(
          "name",
          name
        )
        .limit(10);

    if (oldError) {
      msg(
        $("#productMessage"),
        oldError.message
      );

      return;
    }

    const deletedExact =
      (oldRows || []).find(
        (product) =>
          normalizeName(product.name) ===
          normalizeName(name) &&
          product.active === false
      );

    if (deletedExact) {
      const { data: restored, error: restoreError } =
        await supabase
          .from("products")
          .update({
            active: true,
            name,
          })
          .eq(
            "id",
            deletedExact.id
          )
          .select()
          .single();

      if (restoreError) {
        msg(
          $("#productMessage"),
          restoreError.message
        );

        return;
      }

      draftQty.set(
        restored.id,
        1
      );

      msg(
        $("#productMessage"),
        `${name} restored. Confirm quantity below and press Done.`
      );

      await refreshAll();

      $("#productName").value =
        name;

      draftQty.set(
        restored.id,
        1
      );

      renderProducts();

      return;
    }

    /*
      Truly new product.
      default_quantity remains only because
      old database schema may require it.
      User never sees or uses "usual qty".
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

          active:
            true,

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
      New product starts as draft Qty 1.
      It is NOT yet in Current Orders.

      User must still press Done.
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
        normalizeName(p.name) ===
          normalizeName(cleanName)
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
    Current active order should use
    the new product name.

    Completed History remains unchanged.
  */
  const active =
    activeOrderFor(product.id);

  if (active) {
    const { error: orderError } =
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

    if (orderError) {
      msg(
        $("#productMessage"),
        orderError.message
      );

      return;
    }
  }

  $("#productName").value =
    cleanName;

  draftQty.delete(
    product.id
  );

  await refreshAll();

  renderProducts();
}

/* =====================================================
   DELETE PRODUCT

   IMPORTANT:
   We soft-delete from Products database.

   That means:
   active = false

   So:
   - no longer appears in search
   - cannot confuse future ordering
   - completed History stays intact
===================================================== */

async function deleteProduct(product) {
  const active =
    activeOrderFor(product.id);

  let warning =
    `Delete ${product.name} from the product database?`;

  if (active) {
    warning +=
      "\n\nIt is also in Current Orders. It will be removed from Current Orders too.";
  }

  const ok =
    window.confirm(warning);

  if (!ok) return;

  /*
    Remove unfinished Current Order first.
  */
  if (active) {
    const { error: activeError } =
      await supabase
        .from("orders")
        .delete()
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

    selectedOrderIds.delete(
      active.id
    );
  }

  /*
    Do NOT hard-delete product row.

    Retire it instead so completed History
    and database relationships remain safe.
  */
  const { error } =
    await supabase
      .from("products")
      .update({
        active: false,
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

  draftQty.delete(
    product.id
  );

  $("#productName").value = "";

  msg(
    $("#productMessage"),
    `${product.name} removed.`
  );

  await refreshAll();

  renderProducts();
}

/* =====================================================
   CURRENT ORDERS

   Review only:
   checkbox + product + quantity
===================================================== */

function renderCurrentOrders() {
  const host =
    $("#weekList");

  if (!host) return;

  host.innerHTML = "";

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
    empty.classList.add(
      "hidden"
    );
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

    qty.className =
      "meta";

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

    host.append(
      row
    );
  });

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
    Button is AFTER all pending products.
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
   COMPLETE SELECTED ORDERS
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
      (order) =>
        selectedOrderIds.has(
          order.id
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
    All products completed in this click
    receive the same batch ID.
  */
  const batchId =
    crypto.randomUUID();

  const completedAt =
    new Date().toISOString();

  const ids =
    selected.map(
      (order) =>
        order.id
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
      .in(
        "id",
        ids
      );

  if (error) {
    msg(
      $("#appMessage"),
      error.message
    );

    return;
  }

  selected.forEach(
    (order) => {
      selectedOrderIds.delete(
        order.id
      );

      draftQty.delete(
        order.product_id
      );
    }
  );

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
   DATE -> COMPLETION BATCH -> PRODUCTS
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
      $("#email")
        .value
        .trim();

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
        .value
        .trim();

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
   CREATE WORKSPACE
===================================================== */

$("#createWorkspaceForm").addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    const name =
      $("#workspaceName")
        .value
        .trim();

    const { error } =
      await supabase.rpc(
        "create_workspace",
        {
          p_name:
            name,
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
   JOIN WORKSPACE
===================================================== */

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
        products.map(
          (product) =>
            normalizeName(
              product.name
            )
        )
      );

    const rows =
      demo
        .filter(
          (name) =>
            !existingNames.has(
              normalizeName(name)
            )
        )
        .map((name) => ({
          workspace_id:
            workspace.id,

          name,

          default_quantity:
            1,

          active:
            true,

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
    (btn) =>
      btn.classList.toggle(
        "active",
        btn.dataset.screen === name
      )
  );

  if (name === "products") {
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
   GO TO PRODUCTS
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
   START APP
===================================================== */

bootstrap();
