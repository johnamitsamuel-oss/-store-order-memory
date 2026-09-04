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
let families = [];
let orders = [];
let channel = null;

const draftQty = new Map();
const selectedOrderIds = new Set();
let returnToCurrentOrdersAfterDelete = false;

/* =====================================================
   HELPERS
===================================================== */

function normalizeName(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function titleCaseName(value = "") {
  return String(value).replace(
    /(^|[\s\-/])([a-z])/g,
    (_, separator, letter) =>
      `${separator}${letter.toUpperCase()}`
  );
}

function currentUserName() {
  const metadataName =
    session?.user?.user_metadata?.full_name ||
    session?.user?.user_metadata?.name;

  if (metadataName) return titleCaseName(metadataName.trim());

  const emailName =
    session?.user?.email?.split("@")[0] || "Team member";

  return titleCaseName(
    emailName.replace(/[._-]+/g, " ")
  );
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
  authCard?.classList.toggle("hidden", name !== "auth");
  workspaceCard?.classList.toggle("hidden", name !== "workspace");
  app?.classList.toggle("hidden", name !== "app");
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

function familyForProduct(product) {
  if (!product?.family_id) return null;

  return (
    families.find(
      (family) => family.id === product.family_id
    ) || null
  );
}

function productForOrder(order) {
  return (
    products.find(
      (product) => product.id === order.product_id
    ) || null
  );
}

function matchingFamilyIds(searchText) {
  const query = normalizeName(searchText);
  const ids = new Set();

  if (!query) return ids;

  families.forEach((family) => {
    if (normalizeName(family.name).includes(query)) {
      ids.add(family.id);
    }
  });

  products.forEach((product) => {
    if (
      product.family_id &&
      normalizeName(product.name).includes(query)
    ) {
      ids.add(product.family_id);
    }
  });

  return ids;
}

function matchingProducts(searchText) {
  const query = normalizeName(searchText);

  if (!query) return [];

  const familyIds = matchingFamilyIds(searchText);

  return products
    .filter(
      (product) =>
        normalizeName(product.name).includes(query) ||
        (product.family_id && familyIds.has(product.family_id))
    )
    .sort((a, b) => {
      const aActive = !!activeOrderFor(a.id);
      const bActive = !!activeOrderFor(b.id);

      /*
        Products already on Current Orders
        appear FIRST.
      */
      if (aActive !== bActive) {
        return aActive ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });
}

/* =====================================================
   DATE
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
   START
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
    const pendingInviteCode =
      new URLSearchParams(window.location.search)
        .get("join")
        ?.trim()
        .toUpperCase();

    if (pendingInviteCode) {
      const { error: joinError } =
        await supabase.rpc(
          "join_workspace",
          { p_invite_code: pendingInviteCode }
        );

      if (!joinError) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("join");
        window.history.replaceState(
          {},
          document.title,
          `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`
        );
        return loadWorkspace();
      }

      msg(
        $("#workspaceMessage"),
        `Invitation could not be joined: ${joinError.message}`
      );

      if ($("#inviteCode")) {
        $("#inviteCode").value = pendingInviteCode;
      }
    }

    setScreen("workspace");
    return;
  }

  workspace = data.workspaces;
  memberRole = data.role || "staff";

  $("#menuBtn")?.classList.toggle(
    "hidden",
    !isSenior()
  );

  if ($("#workspaceTitle")) {
    $("#workspaceTitle").textContent = workspace.name;
  }

  if ($("#inviteCodeDisplay")) {
    $("#inviteCodeDisplay").textContent =
      workspace.invite_code;
  }

  setScreen("app");

  await refreshAll();
  subscribeRealtime();

  /*
    Products is HOME screen.
  */
  showMain("products");
}

/* =====================================================
   LOAD DATA
===================================================== */

async function refreshAll() {
  if (!workspace) return;

  const [p, f, o] = await Promise.all([
    supabase
      .from("products")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("active", true)
      .order("name", { ascending: true }),

    supabase
      .from("product_families")
      .select("*")
      .eq("workspace_id", workspace.id)
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

  if (f.error) {
    msg($("#appMessage"), f.error.message);
  } else {
    families = f.data || [];
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
        table: "product_families",
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
   RENDER
===================================================== */

function renderAll() {
  hideOldStats();
  prepareProductResultArea();

  renderProducts();
  renderCurrentOrders();
  renderHistory();

  if ($("#familiesDialog")?.open) {
    renderFamiliesManager();
  }
}

function hideOldStats() {
  const stats = $(".stats-grid");

  if (stats) {
    stats.classList.add("hidden");
  }
}

/* =====================================================
   PRODUCT RESULT CARD
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
    heading.textContent = "Smart suggestions";
  }

  if (eyebrow) {
    eyebrow.textContent = "This store";
  }

  if (description) {
    description.textContent =
      "Suggestions use only this store's products, families, and order history.";
  }
}

/* =====================================================
   PRODUCTS SEARCH
===================================================== */

function renderProducts() {
  const host = $("#productList");

  if (!host) return;

  host.innerHTML = "";

  const input = $("#productName");
  const empty = $("#productEmpty");

  const searchText =
    input?.value?.trim() || "";

  const query = normalizeName(searchText);

  const submitBtn =
    $("#productForm button[type='submit']");

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

  const matches = matchingProducts(searchText);

  /*
    DUPLICATE PROTECTION:

    If typing already finds an existing product,
    Add New Product cannot be pressed.
  */
  if (matches.length) {
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

  const suggestionLabel = document.createElement("div");
  suggestionLabel.className = "suggestions-label";
  suggestionLabel.textContent = "Suggestions from this store";
  host.append(suggestionLabel);

  const familyGroups = new Map();
  const ungrouped = [];

  matches.forEach((product) => {
    if (!product.family_id) {
      ungrouped.push(product);
      return;
    }

    if (!familyGroups.has(product.family_id)) {
      familyGroups.set(product.family_id, []);
    }

    familyGroups.get(product.family_id).push(product);
  });

  familyGroups.forEach((familyProducts, familyId) => {
    const family =
      families.find((item) => item.id === familyId);

    const group = document.createElement("details");
    group.className = "product-suggestion-family";
    group.open = true;

    const summary = document.createElement("summary");
    const familyName = document.createElement("span");
    familyName.textContent = family?.name || "Product family";

    const count = document.createElement("span");
    count.className = "suggestion-count";
    count.textContent = `${familyProducts.length} item${
      familyProducts.length === 1 ? "" : "s"
    }`;

    summary.append(familyName, count);

    group.append(summary);

    familyProducts.forEach((product) => {
      renderProductResult(group, product);
    });

    host.append(group);
  });

  if (ungrouped.length) {
    const heading = document.createElement("div");
    heading.className = "suggestion-section-heading";
    heading.textContent = familyGroups.size
      ? "Other matching products"
      : "Matching products";
    host.append(heading);

    ungrouped.forEach((product) => {
      renderProductResult(host, product);
    });
  }
}

/* =====================================================
   ONE SEARCH RESULT
===================================================== */

function renderProductResult(host, product) {
  const active = activeOrderFor(product.id);

  const databaseQty = active
    ? Math.max(0, Number(active.quantity) || 0)
    : 0;

  if (!draftQty.has(product.id)) {
    draftQty.set(product.id, databaseQty);
  }

  const currentDraft = Math.max(
    0,
    Number(draftQty.get(product.id)) || 0
  );

  const row = document.createElement("div");
  row.className = "product-row";

  const body = document.createElement("div");

  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = product.name;

  const meta = document.createElement("div");
  meta.className = "meta";

  const family = familyForProduct(product);

  meta.textContent = active
    ? `Current order: Qty ${databaseQty}${
        family ? ` · ${family.name} family` : ""
      }`
    : `Not currently on order${
        family ? ` · ${family.name} family` : ""
      }`;

  body.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "product-actions";

  const qtyControls = document.createElement("div");
  qtyControls.className = "qty-controls";

  const minus = document.createElement("button");
  minus.type = "button";
  minus.className = "mini";
  minus.textContent = "−";

  const qty = document.createElement("span");
  qty.className = "qty-pill";
  qty.textContent = `Qty ${currentDraft}`;

  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "mini";
  plus.textContent = "+";

  minus.addEventListener("click", () => {
    const old =
      Math.max(
        0,
        Number(draftQty.get(product.id)) || 0
      );

    draftQty.set(
      product.id,
      Math.max(0, old - 1)
    );

    renderProducts();
  });

  plus.addEventListener("click", () => {
    const old =
      Math.max(
        0,
        Number(draftQty.get(product.id)) || 0
      );

    draftQty.set(
      product.id,
      Math.min(999, old + 1)
    );

    renderProducts();
  });

  qtyControls.append(minus, qty, plus);

  const done = button(
    "Done",
    "primary",
    async () => {
      await confirmProductOrder(product);
    }
  );

  /*
    New order cannot START with zero.

    Existing Current Order CAN be changed
    to zero and stays pending.
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

  row.append(body, actions);

  host.append(row);
}

/* =====================================================
   SEARCH WHILE TYPING
===================================================== */

$("#productName")?.addEventListener(
  "input",
  (event) => {
    const input = event.currentTarget;
    const cursor = input.selectionStart;
    const titledValue = titleCaseName(input.value);

    if (input.value !== titledValue) {
      input.value = titledValue;
      input.setSelectionRange(cursor, cursor);
    }

    msg($("#productMessage"));
    renderProducts();
  }
);

/* =====================================================
   DONE / CONFIRM PRODUCT
===================================================== */

async function confirmProductOrder(product) {
  msg($("#productMessage"));
  msg($("#appMessage"));

  const quantity = Math.max(
    0,
    Math.min(
      999,
      Number(draftQty.get(product.id)) || 0
    )
  );

  const active = activeOrderFor(product.id);

  /*
    Existing pending item:
    update quantity.

    Qty 0 remains in Current Orders.
  */
  if (active) {
    const { error } = await supabase
      .from("orders")
      .update({
        quantity,
        product_name: product.name,
      })
      .eq("id", active.id);

    if (error) {
      msg($("#productMessage"), error.message);
      return;
    }

    draftQty.delete(product.id);

    await refreshAll();

    $("#productName").value = "";

    msg(
      $("#productMessage"),
      `${product.name} updated to Qty ${quantity}.`
    );

    renderProducts();

    return;
  }

  /*
    New pending order needs at least Qty 1.
  */
  if (quantity <= 0) {
    msg(
      $("#productMessage"),
      "Set quantity before pressing Done."
    );

    return;
  }

  /*
    Re-check database in case second cashier
    added same product a second ago.
  */
  const { data: existingRows, error: checkError } =
    await supabase
      .from("orders")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("product_id", product.id)
      .order("created_at", { ascending: false });

  if (checkError) {
    msg($("#productMessage"), checkError.message);
    return;
  }

  const existingActive =
    (existingRows || []).find(
      (o) =>
        !o.status ||
        o.status === "active"
    );

  if (existingActive) {
    msg(
      $("#productMessage"),
      `${product.name} is already on Current Orders at Qty ${Number(
        existingActive.quantity
      ) || 0}.`
    );

    await refreshAll();

    return;
  }

  const { error } = await supabase
    .from("orders")
    .insert({
      workspace_id: workspace.id,
      product_id: product.id,
      product_name: product.name,
      quantity,
      ordered_on: localDateKey(),
      ordered_by: session.user.id,
      status: "active",
    });

  if (error) {
    msg($("#productMessage"), error.message);
    return;
  }

  draftQty.delete(product.id);

  await refreshAll();

  $("#productName").value = "";

  msg(
    $("#productMessage"),
    `${product.name} added to Current Orders — Qty ${quantity}.`
  );

  renderProducts();
}

/* =====================================================
   ADD NEW PRODUCT
===================================================== */

$("#productForm")?.addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    msg($("#productMessage"));

    const name = titleCaseName(
      $("#productName").value.trim()
    );

    if (!name) {
      msg(
        $("#productMessage"),
        "Enter a product name."
      );

      return;
    }

    /*
      If existing search result exists,
      absolutely no duplicate creation.
    */
    const matches = matchingProducts(name);

    if (matches.length) {
      msg(
        $("#productMessage"),
        "Matching product already exists. Use the result below."
      );

      renderProducts();

      return;
    }

    /*
      Check ALL database products,
      including inactive ones.
    */
    const { data: allSameName, error: findError } =
      await supabase
        .from("products")
        .select("*")
        .eq("workspace_id", workspace.id)
        .ilike("name", name);

    if (findError) {
      msg(
        $("#productMessage"),
        findError.message
      );

      return;
    }

    const exactExisting =
      (allSameName || []).find(
        (p) =>
          normalizeName(p.name) ===
          normalizeName(name)
      );

    /*
      If same product was previously retired,
      restore it instead of creating duplicate.
    */
    if (
      exactExisting &&
      exactExisting.active === false
    ) {
      const { data: restored, error } =
        await supabase
          .from("products")
          .update({
            active: true,
            name,
          })
          .eq("id", exactExisting.id)
          .select()
          .single();

      if (error) {
        msg(
          $("#productMessage"),
          error.message
        );

        return;
      }

      await refreshAll();

      $("#productName").value = name;

      draftQty.set(restored.id, 1);

      msg(
        $("#productMessage"),
        `${name} restored. Confirm quantity and press Done.`
      );

      renderProducts();

      return;
    }

    if (
      exactExisting &&
      exactExisting.active !== false
    ) {
      msg(
        $("#productMessage"),
        `${exactExisting.name} already exists.`
      );

      await refreshAll();
      renderProducts();

      return;
    }

    /*
      Truly new product.
    */
    const { data, error } =
      await supabase
        .from("products")
        .insert({
          workspace_id: workspace.id,
          name,
          default_quantity: 1,
          active: true,
          created_by: session.user.id,
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

    await refreshAll();

    $("#productName").value = name;

    draftQty.set(data.id, 1);

    msg(
      $("#productMessage"),
      `${name} created. Confirm quantity and press Done.`
    );

    renderProducts();
  }
);

/* =====================================================
   EDIT PRODUCT
===================================================== */

async function editProduct(product) {
  const newName = window.prompt(
    "Product name",
    product.name
  );

  if (newName === null) return;

  const cleanName = titleCaseName(newName.trim());

  if (!cleanName) {
    msg(
      $("#productMessage"),
      "Product name cannot be empty."
    );

    return;
  }

  const duplicate = products.find(
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

  const { error } = await supabase
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
    Update ACTIVE order name only.
    Completed history remains unchanged.
  */
  const active = activeOrderFor(product.id);

  if (active) {
    const { error: orderError } =
      await supabase
        .from("orders")
        .update({
          product_name: cleanName,
        })
        .eq("id", active.id);

    if (orderError) {
      msg(
        $("#productMessage"),
        orderError.message
      );

      return;
    }
  }

  draftQty.delete(product.id);

  await refreshAll();

  $("#productName").value = cleanName;

  renderProducts();
}

/* =====================================================
   DELETE PRODUCT

   IMPORTANT:
   First try real database DELETE.

   If History relationship prevents hard delete,
   retire with active=false.

   THEN VERIFY IT ACTUALLY HAPPENED.
===================================================== */

async function deleteProduct(product) {
  const active = activeOrderFor(product.id);

  let text =
    `Delete ${product.name} from the product database?`;

  if (active) {
    text +=
      "\n\nIt is also on Current Orders and will be removed from there.";
  }

  const ok = window.confirm(text);

  if (!ok) return;

  msg($("#productMessage"));

  /*
    Remove unfinished current order first.
  */
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

    selectedOrderIds.delete(active.id);
  }

  /*
    Attempt true permanent deletion.
  */
  const { error: hardDeleteError } =
    await supabase
      .from("products")
      .delete()
      .eq("id", product.id);

  /*
    Check whether record still exists.
  */
  const { data: afterHardDelete } =
    await supabase
      .from("products")
      .select("id,active,name")
      .eq("id", product.id)
      .maybeSingle();

  /*
    Hard delete successful.
  */
  if (!afterHardDelete) {
    draftQty.delete(product.id);

    $("#productName").value = "";

    await refreshAll();

    msg(
      $("#productMessage"),
      `${product.name} permanently deleted.`
    );

    if (returnToCurrentOrdersAfterDelete) {
      returnToCurrentOrdersAfterDelete = false;
      showMain("week");
    } else {
      renderProducts();
    }

    return;
  }

  /*
    Hard delete couldn't happen,
    probably because History references it.

    Soft-delete/retire it.
  */
  const { error: retireError } =
    await supabase
      .from("products")
      .update({
        active: false,
      })
      .eq("id", product.id);

  if (retireError) {
    msg(
      $("#productMessage"),
      `Delete blocked: ${retireError.message}`
    );

    return;
  }

  /*
    VERIFY active=false really saved.
  */
  const { data: verified, error: verifyError } =
    await supabase
      .from("products")
      .select("id,active,name")
      .eq("id", product.id)
      .maybeSingle();

  if (verifyError) {
    msg(
      $("#productMessage"),
      verifyError.message
    );

    return;
  }

  /*
    If still active, database policy is
    blocking our update.

    Do NOT lie and say "removed".
  */
  if (verified && verified.active !== false) {
    msg(
      $("#productMessage"),
      "Delete was blocked by the database permissions. We need to fix the Supabase products policy."
    );

    return;
  }

  draftQty.delete(product.id);

  $("#productName").value = "";

  await refreshAll();

  msg(
    $("#productMessage"),
    `${product.name} removed from Products.`
  );

  if (returnToCurrentOrdersAfterDelete) {
    returnToCurrentOrdersAfterDelete = false;
    showMain("week");
  } else {
    renderProducts();
  }
}

/* =====================================================
   PRODUCT FAMILIES
===================================================== */

function renderFamiliesManager() {
  const familyHost = $("#familyList");
  const productHost = $("#familyProductList");

  if (!familyHost || !productHost) return;

  familyHost.innerHTML = "";
  productHost.innerHTML = "";

  if (!families.length) {
    const empty = document.createElement("p");
    empty.className = "muted small family-empty";
    empty.textContent =
      "No families yet. Add Coke, Pepsi, Canada Dry, or another group above.";
    familyHost.append(empty);
  }

  families.forEach((family) => {
    const row = document.createElement("div");
    row.className = "family-row";

    const body = document.createElement("div");

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = family.name;

    const count = products.filter(
      (product) => product.family_id === family.id
    ).length;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${count} product${count === 1 ? "" : "s"}`;

    body.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "family-actions";

    actions.append(
      button("Rename", "mini", () => renameFamily(family)),
      button("Delete", "mini delete", () => deleteFamily(family))
    );

    row.append(body, actions);
    familyHost.append(row);
  });

  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "muted small family-empty";
    empty.textContent = "Add products before assigning them to families.";
    productHost.append(empty);
    return;
  }

  products.forEach((product) => {
    const row = document.createElement("div");
    row.className = "family-product-row";

    const name = document.createElement("span");
    name.className = "item-title";
    name.textContent = product.name;

    const select = document.createElement("select");
    select.setAttribute("aria-label", `Family for ${product.name}`);

    const unassigned = document.createElement("option");
    unassigned.value = "";
    unassigned.textContent = "No family";
    select.append(unassigned);

    families.forEach((family) => {
      const option = document.createElement("option");
      option.value = family.id;
      option.textContent = family.name;
      select.append(option);
    });

    select.value = product.family_id || "";

    select.addEventListener("change", async () => {
      await assignProductFamily(product, select.value || null);
    });

    row.append(name, select);
    productHost.append(row);
  });
}

$("#menuBtn")?.addEventListener("click", () => {
  if (!isSenior()) {
    msg(
      $("#appMessage"),
      "Only a manager or owner can manage product families."
    );
    return;
  }

  msg($("#familyMessage"));
  renderFamiliesManager();
  $("#familiesDialog")?.showModal();
});

$("#closeFamiliesBtn")?.addEventListener(
  "click",
  () => $("#familiesDialog")?.close()
);

$("#familyForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isSenior()) return;

  const name = $("#familyName").value.trim();

  if (!name) return;

  const duplicate = families.some(
    (family) => normalizeName(family.name) === normalizeName(name)
  );

  if (duplicate) {
    msg($("#familyMessage"), "That family already exists.");
    return;
  }

  const { error } = await supabase
    .from("product_families")
    .insert({
      workspace_id: workspace.id,
      name,
      created_by: session.user.id,
    });

  if (error) {
    msg($("#familyMessage"), error.message);
    return;
  }

  $("#familyName").value = "";
  msg($("#familyMessage"), `${name} family added.`);
  await refreshAll();
});

async function renameFamily(family) {
  if (!isSenior()) return;

  const value = window.prompt("Family name", family.name);

  if (value === null) return;

  const name = value.trim();

  if (!name) {
    msg($("#familyMessage"), "Family name cannot be empty.");
    return;
  }

  const duplicate = families.some(
    (item) =>
      item.id !== family.id &&
      normalizeName(item.name) === normalizeName(name)
  );

  if (duplicate) {
    msg($("#familyMessage"), "That family already exists.");
    return;
  }

  const { error } = await supabase
    .from("product_families")
    .update({ name })
    .eq("id", family.id);

  if (error) {
    msg($("#familyMessage"), error.message);
    return;
  }

  msg($("#familyMessage"), `Family renamed to ${name}.`);
  await refreshAll();
}

async function deleteFamily(family) {
  if (!isSenior()) return;

  const count = products.filter(
    (product) => product.family_id === family.id
  ).length;

  const ok = window.confirm(
    `Delete ${family.name} family?${
      count
        ? `\n\n${count} assigned product${count === 1 ? "" : "s"} will become unassigned.`
        : ""
    }`
  );

  if (!ok) return;

  const { error } = await supabase
    .from("product_families")
    .delete()
    .eq("id", family.id);

  if (error) {
    msg($("#familyMessage"), error.message);
    return;
  }

  msg($("#familyMessage"), `${family.name} family deleted.`);
  await refreshAll();
}

async function assignProductFamily(product, familyId) {
  if (!isSenior()) return;

  const { error } = await supabase
    .from("products")
    .update({ family_id: familyId })
    .eq("id", product.id);

  if (error) {
    msg($("#familyMessage"), error.message);
    await refreshAll();
    return;
  }

  const family = families.find((item) => item.id === familyId);

  msg(
    $("#familyMessage"),
    family
      ? `${product.name} moved to ${family.name} family.`
      : `${product.name} removed from its family.`
  );

  await refreshAll();
}

/* =====================================================
   CURRENT ORDERS
===================================================== */

function renderCurrentOrders() {
  const host = $("#weekList");

  if (!host) return;

  host.innerHTML = "";

  const oldBtn = $("#completeOrderBtn");

  if (oldBtn) {
    oldBtn.remove();
  }

  const searchText =
    $("#currentOrderSearch")?.value?.trim() || "";
  const query = normalizeName(searchText);
  const familyIds = matchingFamilyIds(searchText);

  const matchRank = (order) => {
    if (!query) return 0;

    const product = productForOrder(order);

    if (
      product?.family_id &&
      familyIds.has(product.family_id)
    ) {
      return 0;
    }

    if (
      normalizeName(order.product_name).includes(query)
    ) {
      return 1;
    }

    return 2;
  };

  const active = [...activeOrders()].sort(
    (a, b) =>
      matchRank(a) - matchRank(b) ||
      String(a.product_name || "").localeCompare(
        String(b.product_name || "")
      )
  );

  const hasMatches =
    !!query && active.some((order) => matchRank(order) < 2);

  const empty = $("#weekEmpty");

  if (!active.length) {
    if (empty) {
      empty.classList.remove("hidden");

      const h = empty.querySelector("h3");
      const p = empty.querySelector("p");

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

  if (hasMatches) {
    const heading = document.createElement("div");
    heading.className = "order-group-heading";
    heading.textContent = "Matching family orders";
    host.append(heading);
  }

  let otherHeadingAdded = false;

  active.forEach((order) => {
    if (
      hasMatches &&
      matchRank(order) === 2 &&
      !otherHeadingAdded
    ) {
      const heading = document.createElement("div");
      heading.className = "order-group-heading other-orders";
      heading.textContent = "Other current orders";
      host.append(heading);
      otherHeadingAdded = true;
    }

    const row = document.createElement("div");

    row.className = "order-row";

    if (hasMatches && matchRank(order) < 2) {
      row.classList.add("family-match");
    }

    const check = document.createElement("input");

    check.type = "checkbox";
    check.className = "check";

    check.checked =
      selectedOrderIds.has(order.id);

    check.addEventListener(
      "change",
      (event) => {
        event.stopPropagation();

        if (check.checked) {
          selectedOrderIds.add(order.id);
        } else {
          selectedOrderIds.delete(order.id);
        }

        updateCompleteSelectedButton();
      }
    );

    const body = document.createElement("div");

    const title = document.createElement("div");

    title.className = "item-title";
    title.textContent = order.product_name;

    const qty = document.createElement("div");

    qty.className = "meta";

    const product = productForOrder(order);
    const family = familyForProduct(product);

    qty.textContent =
      `Qty ${Math.max(
        0,
        Number(order.quantity) || 0
      )}${family ? ` · ${family.name} family` : ""}`;

    body.append(title, qty);

    const change = button(
      "Change",
      "mini",
      () => openOrderInProducts(order)
    );

    row.append(check, body, change);

    host.append(row);
  });

  ensureCompleteSelectedButton();
}

function openOrderInProducts(order) {
  const product = productForOrder(order);

  if (!product) return;

  draftQty.set(
    product.id,
    Math.max(0, Number(order.quantity) || 0)
  );

  $("#productName").value = product.name;
  showMain("products");
  renderProducts();
  returnToCurrentOrdersAfterDelete = true;
  $("#productName")?.focus();
}

$("#currentOrderSearch")?.addEventListener(
  "input",
  renderCurrentOrders
);

/* =====================================================
   COMPLETE BUTTON
===================================================== */

function ensureCompleteSelectedButton() {
  const host = $("#weekList");

  if (!host) return;

  if (!isSenior()) return;

  const btn = document.createElement("button");

  btn.id = "completeOrderBtn";
  btn.type = "button";
  btn.className = "primary";

  btn.addEventListener(
    "click",
    completeSelectedOrders
  );

  /*
    Bottom of pending orders.
  */
  host.parentElement.append(btn);

  updateCompleteSelectedButton();
}

function updateCompleteSelectedButton() {
  const btn = $("#completeOrderBtn");

  if (!btn) return;

  const count = selectedOrderIds.size;

  btn.disabled = count === 0;

  btn.textContent = count
    ? `Complete Selected (${count})`
    : "Complete Selected";
}

/* =====================================================
   COMPLETE SELECTED
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
        selectedOrderIds.has(o.id)
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
      (sum, o) =>
        sum +
        Math.max(
          0,
          Number(o.quantity) || 0
        ),
      0
    );

  const ok = window.confirm(
    `Complete ${selected.length} product${
      selected.length === 1 ? "" : "s"
    } with total quantity ${totalQty}?`
  );

  if (!ok) return;

  const batchId = crypto.randomUUID();
  const completedAt =
    new Date().toISOString();

  const ids =
    selected.map((o) => o.id);

  const { error } = await supabase
    .from("orders")
    .update({
      status: "completed",
      completed_at: completedAt,
      completed_by: session.user.id,
      completed_by_name: currentUserName(),
      completion_batch_id: batchId,
    })
    .in("id", ids);

  if (error) {
    msg($("#appMessage"), error.message);
    return;
  }

  selected.forEach((order) => {
    selectedOrderIds.delete(order.id);
    draftQty.delete(order.product_id);
  });

  await refreshAll();

  msg(
    $("#appMessage"),
    `Order completed: ${selected.length} product${
      selected.length === 1 ? "" : "s"
    }, ${totalQty} total quantity.`
  );

  showMain("week");
}

/* =====================================================
   HISTORY
===================================================== */

function renderHistory() {
  const host = $("#historyList");

  if (!host) return;

  host.innerHTML = "";

  const query = normalizeName(
    $("#historySearch")?.value || ""
  );

  const history =
    [...completedOrders()]
      .filter((order) => {
        if (!query) return true;

        const completedValue =
          order.completed_at ||
          order.updated_at ||
          order.created_at;

        const dateKey = completedValue
          ? localDateKey(new Date(completedValue))
          : order.ordered_on;

        const searchable = [
          order.product_name,
          fmtDate(dateKey),
          fmtTime(completedValue),
          order.completed_by_name,
        ]
          .filter(Boolean)
          .join(" ");

        return normalizeName(searchable).includes(query);
      })
      .sort(
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

  const empty = $("#historyEmpty");

  if (empty) {
    empty.textContent = query
      ? "No completed orders match this search."
      : "No completed orders yet.";

    empty.classList.toggle(
      "hidden",
      history.length > 0
    );
  }

  if (!history.length) return;

  const dateGroups = new Map();

  history.forEach((order) => {
    const completedValue =
      order.completed_at ||
      order.updated_at ||
      order.created_at;

    const dateKey = completedValue
      ? localDateKey(new Date(completedValue))
      : order.ordered_on;

    if (!dateGroups.has(dateKey)) {
      dateGroups.set(dateKey, []);
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

  dates.forEach((dateKey, dateIndex) => {
    const dateOrders =
      dateGroups.get(dateKey);

    const dayFolder =
      document.createElement("details");

    dayFolder.className = "history-day";
    dayFolder.open = query ? true : dateIndex === 0;

    const daySummary =
      document.createElement("summary");

    daySummary.className =
      "history-day-summary";

    const dateTitle = document.createElement("span");
    dateTitle.textContent = fmtDate(dateKey);

    const dateCount = document.createElement("span");
    dateCount.className = "history-count";

    dayFolder.append(daySummary);

    const batches = new Map();

    dateOrders.forEach((order) => {
      const batchKey =
        order.completion_batch_id ||
        `old-${order.id}`;

      if (!batches.has(batchKey)) {
        batches.set(batchKey, []);
      }

      batches
        .get(batchKey)
        .push(order);
    });

    const batchList =
      [...batches.values()].sort(
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

    dateCount.textContent = `${batchList.length} order${
      batchList.length === 1 ? "" : "s"
    }`;

    daySummary.append(dateTitle, dateCount);

    batchList.forEach((batch) => {
      const productCount =
        batch.length;

      const totalQty =
        batch.reduce(
          (sum, order) =>
            sum +
            Math.max(
              0,
              Number(order.quantity) || 0
            ),
          0
        );

      const completedAt =
        batch[0].completed_at ||
        batch[0].created_at;

      const batchCard = document.createElement("article");
      batchCard.className = "history-batch";

      const batchHeader = document.createElement("div");
      batchHeader.className = "history-batch-summary";

      const check = document.createElement("span");
      check.className = "history-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";

      const headerText = document.createElement("div");

      const summary = document.createElement("strong");

      const time = fmtTime(completedAt);

      summary.textContent =
        `Completed${time ? ` at ${time}` : ""}`;

      const meta = document.createElement("div");
      meta.className = "history-batch-meta";
      meta.textContent = `${productCount} product${
        productCount === 1 ? "" : "s"
      } • ${totalQty} total unit${totalQty === 1 ? "" : "s"}`;

      headerText.append(summary, meta);
      batchHeader.append(check, headerText);
      batchCard.append(batchHeader);

      batch.forEach((order) => {
        const row =
          document.createElement("div");

        row.className =
          "history-row";

        const title =
          document.createElement("div");

        title.className =
          "history-date";

        title.textContent =
          order.product_name;

        const qty =
          document.createElement("div");

        qty.className =
          "history-qty";

        qty.textContent =
          `Qty ${Math.max(
            0,
            Number(order.quantity) || 0
          )}`;

        row.append(title, qty);

        batchCard.append(row);
      });

      const completedBy = document.createElement("div");
      completedBy.className = "history-completed-by";

      const savedName = batch.find(
        (order) => order.completed_by_name
      )?.completed_by_name;

      const completedUserId = batch.find(
        (order) => order.completed_by
      )?.completed_by;

      completedBy.textContent = `Completed by ${
        savedName ||
        (completedUserId === session?.user?.id
          ? currentUserName()
          : "Team member")
      }`;

      batchCard.append(completedBy);
      dayFolder.append(batchCard);
    });

    host.append(dayFolder);
  });
}

$("#historySearch")?.addEventListener(
  "input",
  renderHistory
);

/* =====================================================
   AUTH
===================================================== */

$("#authForm")?.addEventListener(
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

$("#signUpBtn")?.addEventListener(
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

$("#forgotPasswordBtn")?.addEventListener(
  "click",
  async () => {
    if (!supabase) return;

    const email = $("#email").value.trim();

    if (!email) {
      msg(
        $("#authMessage"),
        "Enter your email address first."
      );
      $("#email")?.focus();
      return;
    }

    msg($("#authMessage"), "Sending reset email...");

    const redirectTo =
      `${window.location.origin}${window.location.pathname}`;

    const { error } =
      await supabase.auth.resetPasswordForEmail(
        email,
        { redirectTo }
      );

    if (error) {
      msg($("#authMessage"), error.message);
      return;
    }

    msg(
      $("#authMessage"),
      "Password reset email sent. Open the newest email and use its link once."
    );
  }
);

function showResetPasswordDialog() {
  msg($("#resetPasswordMessage"));
  $("#newPassword").value = "";
  $("#confirmNewPassword").value = "";

  const dialog = $("#resetPasswordDialog");

  if (dialog && !dialog.open) {
    dialog.showModal();
  }

  window.setTimeout(
    () => $("#newPassword")?.focus(),
    0
  );
}

$("#resetPasswordForm")?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const password = $("#newPassword").value;
    const confirmation = $("#confirmNewPassword").value;

    if (password.length < 6) {
      msg(
        $("#resetPasswordMessage"),
        "Password must be at least 6 characters."
      );
      return;
    }

    if (password !== confirmation) {
      msg(
        $("#resetPasswordMessage"),
        "The two passwords do not match."
      );
      return;
    }

    const { error } =
      await supabase.auth.updateUser({ password });

    if (error) {
      msg($("#resetPasswordMessage"), error.message);
      return;
    }

    $("#resetPasswordDialog")?.close();

    window.history.replaceState(
      {},
      document.title,
      window.location.pathname
    );

    msg(
      $("#appMessage"),
      "Password updated successfully."
    );

    if (session) {
      await loadWorkspace();
    }
  }
);

/* =====================================================
   WORKSPACE
===================================================== */

$("#createWorkspaceForm")?.addEventListener(
  "submit",
  async (e) => {
    e.preventDefault();

    const name =
      $("#workspaceName").value.trim();

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

$("#joinWorkspaceForm")?.addEventListener(
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

/* =====================================================
   DEMO PRODUCTS
===================================================== */

$("#demoBtn")?.addEventListener(
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
          normalizeName(p.name)
        )
      );

    const rows = demo
      .filter(
        (name) =>
          !existingNames.has(
            normalizeName(name)
          )
      )
      .map((name) => ({
        workspace_id: workspace.id,
        name,
        default_quantity: 1,
        active: true,
        created_by: session.user.id,
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
    () => {
      returnToCurrentOrdersAfterDelete = false;
      showMain(btn.dataset.screen);
    }
  )
);

function showMain(name) {
  $("#weekScreen")?.classList.toggle(
    "hidden",
    name !== "week"
  );

  $("#productsScreen")?.classList.toggle(
    "hidden",
    name !== "products"
  );

  $("#historyScreen")?.classList.toggle(
    "hidden",
    name !== "history"
  );

  $$(".main-tab").forEach((btn) =>
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

$("#goProductsBtn")?.addEventListener(
  "click",
  () => showMain("products")
);

/* =====================================================
   INVITE
===================================================== */

$("#inviteBtn")?.addEventListener(
  "click",
  () => {
    msg($("#inviteMessage"));
    if ($("#inviteEmail")) {
      $("#inviteEmail").value = "";
    }
    $("#inviteDialog")?.showModal();
    window.setTimeout(
      () => $("#inviteEmail")?.focus(),
      0
    );
  }
);

$("#closeInviteBtn")?.addEventListener(
  "click",
  () => $("#inviteDialog")?.close()
);

$("#inviteForm")?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const email = $("#inviteEmail").value.trim();
    const sendButton = $("#sendInviteBtn");

    if (!email) {
      msg($("#inviteMessage"), "Enter an email address.");
      return;
    }

    if (!workspace?.invite_code) {
      msg($("#inviteMessage"), "Store invite code is unavailable.");
      return;
    }

    if (
      normalizeName(email) ===
      normalizeName(session?.user?.email)
    ) {
      msg(
        $("#inviteMessage"),
        "Enter the other team member's email address."
      );
      return;
    }

    sendButton.disabled = true;
    sendButton.textContent = "Sending…";
    msg($("#inviteMessage"), "Sending invitation…");

    const redirectUrl = new URL(
      `${window.location.origin}${window.location.pathname}`
    );
    redirectUrl.searchParams.set(
      "join",
      workspace.invite_code
    );

    const { error } =
      await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: redirectUrl.toString(),
          data: {
            invited_to_store: workspace.name,
          },
        },
      });

    sendButton.disabled = false;
    sendButton.textContent = "Send invite";

    if (error) {
      msg(
        $("#inviteMessage"),
        `Invite could not be sent: ${error.message}`
      );
      return;
    }

    msg(
      $("#inviteMessage"),
      `Invitation sent to ${email}.`
    );
  }
);

/* =====================================================
   SIGN OUT
===================================================== */

async function signOut() {
  if (channel) {
    await supabase.removeChannel(channel);
  }

  await supabase.auth.signOut();

  session = null;
  workspace = null;
  memberRole = "staff";

  products = [];
  families = [];
  orders = [];

  $("#menuBtn")?.classList.add("hidden");
  $("#familiesDialog")?.close();

  draftQty.clear();
  selectedOrderIds.clear();

  setScreen("auth");
}

$("#signOutBtn")?.addEventListener(
  "click",
  signOut
);

$("#workspaceSignOut")?.addEventListener(
  "click",
  signOut
);

if (supabase) {
  supabase.auth.onAuthStateChange(
    (event, s) => {
      session = s;

      if (event === "PASSWORD_RECOVERY") {
        window.setTimeout(
          showResetPasswordDialog,
          0
        );
        return;
      }

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
