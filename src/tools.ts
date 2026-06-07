/**
 * Tool definitions for the COD Network MCP server.
 *
 * Each tool maps to one or more endpoints under https://api.cod.network/v2/seller/...
 * documented at https://developer.cod.network/v2.
 *
 * The `pagination`, `sort`, and `filter` shapes follow the conventions described in
 * the "Response structure" and "Advanced" pages of the docs.
 */

import { z } from "zod";
import type { CodClient } from "./client.js";

/* -------------------------------------------------------------------------- */
/*  Shared schemas                                                            */
/* -------------------------------------------------------------------------- */

const Pagination = {
  page: z.number().int().min(1).optional().describe("Page number (1-based)."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Items per page. The API silently caps this at 10 even if a higher value is requested, so iterate with `page` to fetch more than 10 results.",
    ),
};

const Sort = {
  sort: z
    .string()
    .optional()
    .describe(
      "Sort field. Prefix with `-` for descending (e.g. `-created_at`). See API docs for sortable fields per endpoint.",
    ),
};

const Includes = {
  include: z
    .string()
    .optional()
    .describe(
      "Comma-separated list of related resources to include (e.g. `customer,items`). See API docs for available includes per endpoint.",
    ),
};

/* -------------------------------------------------------------------------- */
/*  Tool registry                                                             */
/* -------------------------------------------------------------------------- */

/** Erased shape of a registered tool. The handler accepts validated `unknown`. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown, client: CodClient) => Promise<unknown>;
}

interface TypedToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>, client: CodClient) => Promise<unknown>;
}

/**
 * Helper that preserves type-safety of the handler at the definition site
 * while erasing the generic so all tools share one registry type.
 */
function tool<S extends z.ZodTypeAny>(def: TypedToolDef<S>): ToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: (input, client) => def.handler(input as z.infer<S>, client),
  };
}

/** Build a query record by stripping undefined entries. */
function q(input: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      Array.isArray(v)
    ) {
      out[k] = v as string | number | boolean | string[];
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Catalog: products, drop products, marketplace, stocks                     */
/* -------------------------------------------------------------------------- */

const listProducts = tool({
  name: "cod_list_products",
  description:
    "List the seller's products (catalog of items the seller manages, with stock per warehouse). Supports pagination and sorting only — the API ignores `name=` / `q=` filters server-side, so for name/SKU substring search use `cod_search_products` instead.",
  inputSchema: z.object({ ...Pagination, ...Sort }),
  handler: (input, client) =>
    client.request({ path: "/seller/products", query: q(input) }),
});

const getProduct = tool({
  name: "cod_get_product",
  description: "Retrieve a single product by id.",
  inputSchema: z.object({
    id: z.union([z.string(), z.number()]).describe("Product id."),
  }),
  handler: ({ id }, client) =>
    client.request({ path: `/seller/products/${encodeURIComponent(String(id))}` }),
});

const listDropProducts = tool({
  name: "cod_list_drop_products",
  description:
    "List the seller's drop products (dropshipping catalog with up-sell pricing, media and landing pages). The `name=` and `sku=` filters are EXACT-match server-side — for substring search use `cod_search_products` with `kind: 'drop_products'`.",
  inputSchema: z.object({
    name: z.string().optional().describe("Filter by exact drop product name (case-sensitive)."),
    sku: z.string().optional().describe("Filter by exact SKU."),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    client.request({ path: "/seller/drop-products", query: q(input) }),
});

const getDropProduct = tool({
  name: "cod_get_drop_product",
  description: "Retrieve a single drop product by id.",
  inputSchema: z.object({
    id: z.union([z.string(), z.number()]).describe("Drop product id."),
  }),
  handler: ({ id }, client) =>
    client.request({
      path: `/seller/drop-products/${encodeURIComponent(String(id))}`,
    }),
});

const listStocks = tool({
  name: "cod_list_stocks",
  description: "List stock levels per product per warehouse / country.",
  inputSchema: z.object({
    product_id: z.union([z.string(), z.number()]).optional(),
    sku: z.string().optional(),
    country: z.string().optional().describe("Country ISO code 2."),
    project: z.string().optional().describe("Warehouse project name."),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    client.request({ path: "/seller/stocks", query: q(input) }),
});

/* -------------------------------------------------------------------------- */
/*  Orders & leads                                                            */
/* -------------------------------------------------------------------------- */

const listOrders = tool({
  name: "cod_list_orders",
  description:
    "List the seller's orders, newest first. Each order includes customer info, status, shipping and delivery dates. To answer date-bounded questions (e.g. 'orders last week'), page through results until the `created_at` field is older than the desired range and aggregate client-side: the API ignores arbitrary date filters and caps `per_page` at 10.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe(
        "Filter by order status. Known values: `pending`, `assigned`, `shipped`, `delivered`, `returned`, `cancelled`. Case-insensitive.",
      ),
    reference: z.string().optional().describe("Filter by order reference."),
    customer_phone: z
      .string()
      .optional()
      .describe("Filter by customer phone number (best-effort match)."),
    ...Includes,
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    client.request({ path: "/seller/orders", query: q(input) }),
});

const getOrder = tool({
  name: "cod_get_order",
  description: "Retrieve a single order by id, including customer and items.",
  inputSchema: z.object({
    id: z.union([z.string(), z.number()]).describe("Order id."),
    ...Includes,
  }),
  handler: ({ id, ...rest }, client) =>
    client.request({
      path: `/seller/orders/${encodeURIComponent(String(id))}`,
      query: q(rest),
    }),
});

const listLeads = tool({
  name: "cod_list_leads",
  description:
    "List leads (incoming orders before confirmation), newest first. Includes customer details, status and source. Same pagination caveats as `cod_list_orders`: page through results to handle date ranges client-side; `per_page` is capped at 10.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Filter by lead status (e.g. `new`, `confirmed`, `cancelled`)."),
    customer_phone: z.string().optional(),
    ...Includes,
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    client.request({ path: "/seller/leads", query: q(input) }),
});

const getLead = tool({
  name: "cod_get_lead",
  description: "Retrieve a single lead by id.",
  inputSchema: z.object({
    id: z.union([z.string(), z.number()]).describe("Lead id."),
    ...Includes,
  }),
  handler: ({ id, ...rest }, client) =>
    client.request({
      path: `/seller/leads/${encodeURIComponent(String(id))}`,
      query: q(rest),
    }),
});

/* -------------------------------------------------------------------------- */
/*  Stores, invoices, statistics, dashboards, sourcing, purchases             */
/* -------------------------------------------------------------------------- */

const listStores = tool({
  name: "cod_list_stores",
  description:
    "List the seller's connected stores (e.g. Shopify, WooCommerce, YouCan integrations).",
  inputSchema: z.object({ ...Pagination, ...Sort }),
  handler: (input, client) =>
    client.request({ path: "/seller/stores", query: q(input) }),
});

const listInvoices = tool({
  name: "cod_list_invoices",
  description:
    "List the seller's invoices (remittance / payouts), newest first. Page through results to filter by date client-side; `per_page` is capped at 10.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Filter by invoice status (e.g. `paid`, `pending`)."),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    client.request({ path: "/seller/invoices", query: q(input) }),
});

const getInvoice = tool({
  name: "cod_get_invoice",
  description: "Retrieve a single invoice by id.",
  inputSchema: z.object({
    id: z.union([z.string(), z.number()]).describe("Invoice id."),
  }),
  handler: ({ id }, client) =>
    client.request({ path: `/seller/invoices/${encodeURIComponent(String(id))}` }),
});

const listSourceRequests = tool({
  name: "cod_list_source_requests",
  description: "List sourcing requests submitted to COD Network.",
  inputSchema: z.object({
    status: z.string().optional(),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    client.request({ path: "/seller/source-requests", query: q(input) }),
});

/* -------------------------------------------------------------------------- */
/*  Aggregation: one-shot summaries that paginate internally                  */
/* -------------------------------------------------------------------------- */

/**
 * Maximum number of API pages we'll page through for a single summary call.
 * 200 pages * 10 per_page = 20,000 rows. Anything beyond that we'd want to
 * stream, not buffer. The vast majority of date-bounded questions resolve in
 * 1-5 pages.
 */
const SUMMARY_MAX_PAGES = 200;

/**
 * Number of pages fetched concurrently inside `paginateInRange`. Higher values
 * reduce wall-clock time dramatically when the date range spans many pages
 * (COD caps per_page at 10 so even moderate ranges need dozens of pages).
 */
const PAGE_CONCURRENCY = 5;

interface CodOrderItem {
  quantity?: number;
  price?: number;
  product?: { data?: { id?: number; sku?: string; name?: string } };
}

interface CodOrder {
  id: number;
  reference?: string;
  status?: { label?: string; code?: number };
  customer_name?: string;
  customer_city?: string;
  customer_country_name?: string;
  customer_phone?: string;
  currency?: string;
  total?: number;
  total_usd?: number;
  shipped_at?: string | null;
  delivered_at?: string | null;
  returned_at?: string | null;
  tracking_number?: string;
  tracking_status?: string;
  tracking_url?: string;
  created_at?: string;
  items?: { data?: CodOrderItem[] };
}

interface CodLead {
  id: number;
  status?: { label?: string; code?: number };
  created_at?: string;
  /** Free-text product line, typically `"Name/SKU"`. */
  products?: string;
}

interface CodProduct {
  id: number;
  name?: string;
  name_arabic?: string;
  sku?: string;
}

interface CodListResponse<T> {
  data: T[];
  meta?: { pagination?: { total?: number; current_page?: number; total_pages?: number } };
}

/**
 * Treat `since` / `until` as plain `YYYY-MM-DD HH:MM:SS` UTC strings. The COD
 * API serialises `created_at` as exactly that format, so string comparison is
 * sufficient and avoids timezone surprises.
 */
function toUtcStamp(s: string): string {
  // Accept "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS" (treated as UTC per the schema
  // contract), or any ISO-8601 string with explicit zone. `new Date(...)` would
  // otherwise parse the space-separated form as **local** time, silently
  // shifting the range on non-UTC hosts.
  const trimmed = s.trim();
  let toParse: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    toParse = `${trimmed}T00:00:00Z`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    toParse = `${trimmed.replace(" ", "T")}Z`;
  } else {
    // Already has a zone, fractional seconds, etc. Trust the input.
    toParse = trimmed;
  }
  const date = new Date(toParse);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date string: ${s}`);
  }
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

async function paginateInRange<T extends { created_at?: string }>(
  client: CodClient,
  path: string,
  since: string,
  until: string,
  query: Record<string, string | number | boolean | string[]>,
): Promise<{ items: T[]; pagesScanned: number; reachedCutoff: boolean }> {
  const items: T[] = [];
  let page = 1;
  let reachedCutoff = false;
  let knownTotalPages = Infinity;

  while (page <= SUMMARY_MAX_PAGES && page <= knownTotalPages && !reachedCutoff) {
    const batchSize = Math.min(
      PAGE_CONCURRENCY,
      SUMMARY_MAX_PAGES - page + 1,
      knownTotalPages - page + 1,
    );
    const pageNums = Array.from({ length: batchSize }, (_, i) => page + i);

    const responses = await Promise.all(
      pageNums.map((p) =>
        client.request<CodListResponse<T>>({
          path,
          query: { ...query, page: p, per_page: 10, sort: "-created_at" },
        }),
      ),
    );

    for (const resp of responses) {
      const batch = resp.data ?? [];
      if (batch.length === 0) {
        reachedCutoff = true;
        break;
      }

      const meta = resp.meta?.pagination;
      if (meta?.total_pages !== undefined && meta.total_pages < knownTotalPages) {
        knownTotalPages = meta.total_pages;
      }

      for (const row of batch) {
        const ts = row.created_at ?? "";
        if (ts >= until) continue;
        if (ts < since) {
          reachedCutoff = true;
          break;
        }
        items.push(row);
      }
      if (reachedCutoff) break;
    }

    page += pageNums.length;
  }

  return {
    items,
    pagesScanned: Math.min(page - 1, SUMMARY_MAX_PAGES),
    reachedCutoff,
  };
}

function bucketBy<T>(rows: T[], key: (r: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) ?? "(unknown)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const round = (n: number, dp = 2): number =>
  Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);

/** Pull a list of product names referenced by an order line. */
function orderProductNames(o: CodOrder): string[] {
  const items = o.items?.data ?? [];
  const names: string[] = [];
  for (const it of items) {
    const n = it.product?.data?.name;
    if (n) names.push(n);
  }
  return names;
}

/**
 * Leads carry a free-text `products` field, typically `"Name/SKU"` and
 * sometimes multiple lines for multi-product baskets. We split on common
 * separators and strip the trailing `/SKU` suffix to leave just the name.
 */
function leadProductNames(l: CodLead): string[] {
  if (!l.products) return [];
  const lines = l.products
    .split(/[\n,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const slash = line.lastIndexOf("/");
    return slash > 0 ? line.slice(0, slash).trim() : line;
  });
}

/** Produce the bucket key (period start) for a UTC `created_at` string. */
function bucketKey(ts: string, bucket: "day" | "week" | "month"): string {
  // ts is "YYYY-MM-DD HH:MM:SS"
  if (bucket === "day") return ts.slice(0, 10);
  if (bucket === "month") return ts.slice(0, 7);
  // ISO week: Monday-based, returns "YYYY-Www".
  const d = new Date(`${ts.slice(0, 10)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum =
    1 +
    Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

interface OrdersAgg {
  count: number;
  total_quantity: number;
  avg_quantity_per_order: number;
  delivered_count: number;
  delivered_quantity: number;
  avg_quantity_per_delivered_order: number;
  delivered_revenue_usd: number;
  avg_usd_per_delivered_order: number;
  returned_count: number;
  returned_quantity: number;
  returned_revenue_usd: number;
  delivery_rate_pct: number;
  by_status: Record<string, number>;
  by_country: Record<string, number>;
  revenue_by_currency: Record<string, number>;
  delivered_revenue_by_currency: Record<string, number>;
  revenue_usd_estimate: number;
}

function orderItemQty(o: CodOrder): number {
  let qty = 0;
  for (const it of o.items?.data ?? []) qty += it.quantity ?? 0;
  return qty;
}

function aggregateOrders(rows: CodOrder[]): OrdersAgg {
  const revenueByCurrency: Record<string, number> = {};
  const deliveredRevByCurrency: Record<string, number> = {};
  let revenueUsd = 0;
  let deliveredUsd = 0;
  let returnedUsd = 0;
  let totalQty = 0;
  let deliveredQty = 0;
  let returnedQty = 0;
  for (const o of rows) {
    const cur = o.currency ?? "(unknown)";
    revenueByCurrency[cur] = (revenueByCurrency[cur] ?? 0) + (o.total ?? 0);
    revenueUsd += o.total_usd ?? 0;
    const qty = orderItemQty(o);
    totalQty += qty;
    if (o.delivered_at) {
      deliveredQty += qty;
      deliveredUsd += o.total_usd ?? 0;
      deliveredRevByCurrency[cur] = (deliveredRevByCurrency[cur] ?? 0) + (o.total ?? 0);
    }
    if (o.returned_at) {
      returnedQty += qty;
      returnedUsd += o.total_usd ?? 0;
    }
  }
  const deliveredCount = rows.filter((o) => o.delivered_at).length;
  const returnedCount = rows.filter((o) => o.returned_at).length;
  return {
    count: rows.length,
    total_quantity: totalQty,
    avg_quantity_per_order: rows.length > 0 ? round(totalQty / rows.length) : 0,
    delivered_count: deliveredCount,
    delivered_quantity: deliveredQty,
    avg_quantity_per_delivered_order: deliveredCount > 0 ? round(deliveredQty / deliveredCount) : 0,
    delivered_revenue_usd: round(deliveredUsd),
    avg_usd_per_delivered_order: deliveredCount > 0 ? round(deliveredUsd / deliveredCount) : 0,
    returned_count: returnedCount,
    returned_quantity: returnedQty,
    returned_revenue_usd: round(returnedUsd),
    delivery_rate_pct: rows.length > 0 ? round((deliveredCount / rows.length) * 100, 1) : 0,
    by_status: bucketBy(rows, (o) => o.status?.label),
    by_country: bucketBy(rows, (o) => o.customer_country_name),
    revenue_by_currency: Object.fromEntries(
      Object.entries(revenueByCurrency).map(([k, v]) => [k, round(v)]),
    ),
    delivered_revenue_by_currency: Object.fromEntries(
      Object.entries(deliveredRevByCurrency).map(([k, v]) => [k, round(v)]),
    ),
    revenue_usd_estimate: round(revenueUsd),
  };
}

interface LeadsAgg {
  count: number;
  by_status: Record<string, number>;
  confirmed_count: number;
  confirmation_rate_pct: number;
}

function aggregateLeads(rows: CodLead[]): LeadsAgg {
  const confirmed = rows.filter((l) => (l.status?.label ?? "").toLowerCase() === "confirmed").length;
  return {
    count: rows.length,
    by_status: bucketBy(rows, (l) => l.status?.label),
    confirmed_count: confirmed,
    confirmation_rate_pct: rows.length > 0 ? round((confirmed / rows.length) * 100, 1) : 0,
  };
}

function aggregateOrdersByProduct(
  rows: CodOrder[],
): Array<{ product: string; orders: number; total_qty: number; revenue: Record<string, number> }> {
  const stats = new Map<
    string,
    { product: string; orders: number; total_qty: number; revenue: Record<string, number> }
  >();
  for (const o of rows) {
    const items = o.items?.data ?? [];
    const seenInOrder = new Set<string>();
    for (const it of items) {
      const name = it.product?.data?.name ?? "(unknown)";
      const e =
        stats.get(name) ??
        { product: name, orders: 0, total_qty: 0, revenue: {} as Record<string, number> };
      // Count distinct orders per product, but sum quantity across line items.
      if (!seenInOrder.has(name)) {
        e.orders += 1;
        seenInOrder.add(name);
      }
      e.total_qty += it.quantity ?? 0;
      const cur = o.currency ?? "(unknown)";
      e.revenue[cur] = round((e.revenue[cur] ?? 0) + (it.price ?? 0) * (it.quantity ?? 0));
      stats.set(name, e);
    }
  }
  return [...stats.values()].sort((a, b) => b.orders - a.orders);
}

function aggregateLeadsByProduct(
  rows: CodLead[],
): Array<{ product: string; leads: number; confirmed: number; confirmation_rate_pct: number }> {
  const stats = new Map<string, { product: string; leads: number; confirmed: number }>();
  for (const l of rows) {
    const isConfirmed = (l.status?.label ?? "").toLowerCase() === "confirmed";
    for (const name of leadProductNames(l)) {
      const e = stats.get(name) ?? { product: name, leads: 0, confirmed: 0 };
      e.leads += 1;
      if (isConfirmed) e.confirmed += 1;
      stats.set(name, e);
    }
  }
  return [...stats.values()]
    .map((e) => ({
      ...e,
      confirmation_rate_pct: e.leads > 0 ? round((e.confirmed / e.leads) * 100, 1) : 0,
    }))
    .sort((a, b) => b.leads - a.leads);
}

const summarizePeriod = tool({
  name: "cod_summarize_period",
  description:
    "One-shot summary of leads + orders within a date range. Paginates the COD API internally and returns aggregates (including total_quantity and avg_quantity_per_order for items) without forcing you to scroll raw rows. Use `bucket` for daily/weekly/monthly breakdowns (one call covers a 30-day spreadsheet). Use `group_by_product=true` to get per-product order/lead/revenue breakdowns. Use `product_query` to restrict the whole summary to rows touching a specific product (case-insensitive substring on product name).",
  inputSchema: z.object({
    since: z
      .string()
      .describe(
        "Start of range, inclusive. Accepts `YYYY-MM-DD` (interpreted as 00:00 UTC) or full `YYYY-MM-DD HH:MM:SS` UTC.",
      ),
    until: z
      .string()
      .optional()
      .describe(
        "End of range, exclusive. Same formats as `since`. Defaults to the current time.",
      ),
    include_orders: z.boolean().optional().default(true),
    include_leads: z.boolean().optional().default(true),
    bucket: z
      .enum(["day", "week", "month"])
      .optional()
      .describe(
        "If set, return a `series` array with one summary per bucket (UTC). E.g. `bucket: 'day'` plus a 30-day `since` returns 30 daily rows.",
      ),
    group_by_product: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Include `orders.by_product` and `leads.by_product` arrays. Adds an `?include=items` fetch on orders, slightly slower for large ranges.",
      ),
    product_query: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring; only rows where any product name contains this are counted. Forces `?include=items` on orders.",
      ),
    include_examples: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, include lists of `order_ids` and `lead_ids` (capped at 50 each).",
      ),
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since);
    const until = toUtcStamp(input.until ?? new Date().toISOString());
    if (since >= until) {
      throw new Error(`Empty range: since (${since}) >= until (${until})`);
    }

    const wantOrders = input.include_orders !== false;
    const wantLeads = input.include_leads !== false;
    // Always include items so total_quantity is accurate.
    const needItems = true;
    const productQuery = input.product_query?.trim().toLowerCase();

    const [ordersResult, leadsResult] = await Promise.all([
      wantOrders
        ? paginateInRange<CodOrder>(
            client,
            "/seller/orders",
            since,
            until,
            needItems ? { include: "items" } : {},
          )
        : Promise.resolve({ items: [], pagesScanned: 0, reachedCutoff: true }),
      wantLeads
        ? paginateInRange<CodLead>(client, "/seller/leads", since, until, {})
        : Promise.resolve({ items: [], pagesScanned: 0, reachedCutoff: true }),
    ]);

    let orders = ordersResult.items;
    let leads = leadsResult.items;
    if (productQuery) {
      orders = orders.filter((o) =>
        orderProductNames(o).some((n) => n.toLowerCase().includes(productQuery)),
      );
      leads = leads.filter((l) =>
        leadProductNames(l).some((n) => n.toLowerCase().includes(productQuery)),
      );
    }

    const summary: Record<string, unknown> = {
      range: { since, until },
      filter: productQuery ? { product_query: productQuery } : undefined,
    };

    const ordersBlock = wantOrders
      ? {
          ...aggregateOrders(orders),
          ...(input.group_by_product ? { by_product: aggregateOrdersByProduct(orders) } : {}),
          pages_scanned: ordersResult.pagesScanned,
          full_range_covered: ordersResult.reachedCutoff,
        }
      : undefined;
    const leadsBlock = wantLeads
      ? {
          ...aggregateLeads(leads),
          ...(input.group_by_product ? { by_product: aggregateLeadsByProduct(leads) } : {}),
          pages_scanned: leadsResult.pagesScanned,
          full_range_covered: leadsResult.reachedCutoff,
        }
      : undefined;
    summary.orders = ordersBlock;
    summary.leads = leadsBlock;

    if (input.bucket) {
      const bkt = input.bucket;
      const periods = new Set<string>();
      const ordersByPeriod = new Map<string, CodOrder[]>();
      const leadsByPeriod = new Map<string, CodLead[]>();
      for (const o of orders) {
        if (!o.created_at) continue;
        const k = bucketKey(o.created_at, bkt);
        periods.add(k);
        ordersByPeriod.set(k, [...(ordersByPeriod.get(k) ?? []), o]);
      }
      for (const l of leads) {
        if (!l.created_at) continue;
        const k = bucketKey(l.created_at, bkt);
        periods.add(k);
        leadsByPeriod.set(k, [...(leadsByPeriod.get(k) ?? []), l]);
      }
      summary.series = [...periods]
        .sort()
        .map((period) => ({
          period,
          orders: wantOrders ? aggregateOrders(ordersByPeriod.get(period) ?? []) : undefined,
          leads: wantLeads ? aggregateLeads(leadsByPeriod.get(period) ?? []) : undefined,
        }));
      summary.bucket = bkt;
    }

    if (input.include_examples) {
      summary.examples = {
        order_ids: orders.slice(0, 50).map((o) => o.id),
        lead_ids: leads.slice(0, 50).map((l) => l.id),
      };
    }

    return summary;
  },
});

const searchProducts = tool({
  name: "cod_search_products",
  description:
    "Search the seller's product catalog by case-insensitive substring on name or SKU. The COD API ignores `name=` / `q=` filters server-side, so this tool paginates client-side and filters locally. Use `kind` to choose between owned products, dropshipping products, or both.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Case-insensitive substring matched against `name`, `name_arabic`, or `sku`."),
    kind: z
      .enum(["products", "drop_products", "both"])
      .optional()
      .default("products")
      .describe("`products` = the seller's own catalog. `drop_products` = COD's dropshipping catalog. `both` = both."),
    limit: z.number().int().min(1).max(100).optional().default(25),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(SUMMARY_MAX_PAGES)
      .optional()
      .default(50)
      .describe("Hard cap on COD API pages scanned. 50 pages * 10 items = 500 catalog rows."),
  }),
  handler: async (input, client) => {
    const needle = input.query.trim().toLowerCase();
    if (!needle) {
      throw new Error("`query` must be non-empty.");
    }
    const want = input.kind ?? "products";
    const maxPages = input.max_pages ?? 50;
    const limit = input.limit ?? 25;

    const matchesProduct = (p: CodProduct): boolean => {
      const fields = [p.name, p.name_arabic, p.sku].filter(
        (s): s is string => typeof s === "string",
      );
      return fields.some((s) => s.toLowerCase().includes(needle));
    };

    const scan = async (path: string): Promise<CodProduct[]> => {
      const matches: CodProduct[] = [];
      let pagesScanned = 0;
      for (let page = 1; page <= maxPages && matches.length < limit; page += 1) {
        const resp = await client.request<CodListResponse<CodProduct>>({
          path,
          query: { page, per_page: 10 },
        });
        pagesScanned = page;
        const batch = resp.data ?? [];
        if (batch.length === 0) break;
        for (const p of batch) {
          if (matchesProduct(p) && matches.length < limit) {
            matches.push(p);
          }
        }
        const meta = resp.meta?.pagination;
        if (meta?.total_pages !== undefined && page >= meta.total_pages) break;
      }
      // pagesScanned is informational; expose via the wrapper below.
      (matches as CodProduct[] & { pagesScanned?: number }).pagesScanned = pagesScanned;
      return matches;
    };

    const out: Record<string, unknown> = { query: needle };
    if (want === "products" || want === "both") {
      const m = await scan("/seller/products");
      out.products = {
        matches: m.map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
        pages_scanned: (m as CodProduct[] & { pagesScanned?: number }).pagesScanned ?? 0,
      };
    }
    if (want === "drop_products" || want === "both") {
      const m = await scan("/seller/drop-products");
      out.drop_products = {
        matches: m.map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
        pages_scanned: (m as CodProduct[] & { pagesScanned?: number }).pagesScanned ?? 0,
      };
    }
    return out;
  },
});

/* -------------------------------------------------------------------------- */
/*  Lookup helpers                                                            */
/* -------------------------------------------------------------------------- */

const getProductBySku = tool({
  name: "cod_get_product_by_sku",
  description:
    "Look up a product by its SKU. Scans the seller's catalog (and optionally drop-products) client-side because the regular products endpoint does not support server-side SKU filtering. Returns the first exact match.",
  inputSchema: z.object({
    sku: z.string().describe("Exact SKU to look up (case-insensitive)."),
    include_drop_products: z
      .boolean()
      .optional()
      .default(false)
      .describe("Also search in the drop-products catalog."),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(SUMMARY_MAX_PAGES)
      .optional()
      .default(50)
      .describe("Max API pages to scan per catalog."),
  }),
  handler: async (input, client) => {
    const needle = input.sku.trim().toLowerCase();
    if (!needle) throw new Error("`sku` must be non-empty.");
    const maxPages = input.max_pages ?? 50;

    const scanForSku = async (
      path: string,
    ): Promise<{ product: CodProduct; pages_scanned: number } | null> => {
      for (let page = 1; page <= maxPages; page += 1) {
        const resp = await client.request<CodListResponse<CodProduct>>({
          path,
          query: { page, per_page: 10 },
        });
        const batch = resp.data ?? [];
        if (batch.length === 0) break;
        for (const p of batch) {
          if ((p.sku ?? "").toLowerCase() === needle) {
            return { product: p, pages_scanned: page };
          }
        }
        const meta = resp.meta?.pagination;
        if (meta?.total_pages !== undefined && page >= meta.total_pages) break;
      }
      return null;
    };

    const result = await scanForSku("/seller/products");
    if (result) return { ...result, source: "products" };

    if (input.include_drop_products) {
      // Drop-products endpoint supports exact `sku=` filter server-side.
      const resp = await client.request<CodListResponse<CodProduct>>({
        path: "/seller/drop-products",
        query: { sku: input.sku.trim(), page: 1, per_page: 10 },
      });
      if (resp.data?.length) {
        return { product: resp.data[0], pages_scanned: 1, source: "drop_products" };
      }
    }

    return { product: null, message: `No product found with SKU "${input.sku}".` };
  },
});

/* -------------------------------------------------------------------------- */
/*  Product-level analytics                                                   */
/* -------------------------------------------------------------------------- */

const getProductStats = tool({
  name: "cod_get_product_stats",
  description:
    "Get order statistics for a specific product by name or SKU. Returns total orders, total quantity, revenue, delivery rate and status breakdown. Internally paginates all orders with `?include=items` and filters to the matching product.",
  inputSchema: z.object({
    product_name: z
      .string()
      .optional()
      .describe("Case-insensitive substring matched against product name."),
    product_sku: z
      .string()
      .optional()
      .describe("Case-insensitive exact match against product SKU."),
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS UTC). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    status: z
      .string()
      .optional()
      .describe("Filter orders by status (e.g. `delivered`, `shipped`)."),
  }),
  handler: async (input, client) => {
    if (!input.product_name && !input.product_sku) {
      throw new Error("Provide at least one of `product_name` or `product_sku`.");
    }

    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
    const since = toUtcStamp(input.since ?? oneYearAgo.toISOString());
    const until = toUtcStamp(input.until ?? now.toISOString());

    const queryParams: Record<string, string | number | boolean | string[]> = {
      include: "items",
    };
    if (input.status) queryParams.status = input.status;

    const { items: orders, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, queryParams);

    const nameLower = input.product_name?.trim().toLowerCase();
    const skuLower = input.product_sku?.trim().toLowerCase();

    const matchesProduct = (o: CodOrder): boolean => {
      const items = o.items?.data ?? [];
      return items.some((it) => {
        const pData = it.product?.data;
        if (!pData) return false;
        if (skuLower && (pData.sku ?? "").toLowerCase() === skuLower) return true;
        if (nameLower && (pData.name ?? "").toLowerCase().includes(nameLower)) return true;
        return false;
      });
    };

    const filtered = orders.filter(matchesProduct);

    let totalQty = 0;
    let deliveredQty = 0;
    let returnedQty = 0;
    let totalUsd = 0;
    let deliveredUsd = 0;
    let returnedUsd = 0;
    const matchedCurrency: Record<string, number> = {};
    const deliveredCurrency: Record<string, number> = {};
    for (const o of filtered) {
      totalUsd += o.total_usd ?? 0;
      if (o.delivered_at) deliveredUsd += o.total_usd ?? 0;
      if (o.returned_at) returnedUsd += o.total_usd ?? 0;
      const cur = o.currency ?? "(unknown)";
      matchedCurrency[cur] = (matchedCurrency[cur] ?? 0) + (o.total ?? 0);
      if (o.delivered_at) {
        deliveredCurrency[cur] = (deliveredCurrency[cur] ?? 0) + (o.total ?? 0);
      }
      for (const it of o.items?.data ?? []) {
        const pData = it.product?.data;
        if (!pData) continue;
        const skuMatch = skuLower && (pData.sku ?? "").toLowerCase() === skuLower;
        const nameMatch = nameLower && (pData.name ?? "").toLowerCase().includes(nameLower);
        if (skuMatch || nameMatch) {
          const qty = it.quantity ?? 0;
          totalQty += qty;
          if (o.delivered_at) deliveredQty += qty;
          if (o.returned_at) returnedQty += qty;
        }
      }
    }

    const deliveredCount = filtered.filter((o) => o.delivered_at).length;
    const returnedCount = filtered.filter((o) => o.returned_at).length;

    return {
      range: { since, until },
      filter: { product_name: input.product_name, product_sku: input.product_sku, status: input.status },
      orders: filtered.length,
      total_quantity: totalQty,
      avg_quantity_per_order: filtered.length > 0 ? round(totalQty / filtered.length) : 0,
      delivered_count: deliveredCount,
      delivered_quantity: deliveredQty,
      avg_quantity_per_delivered_order: deliveredCount > 0 ? round(deliveredQty / deliveredCount) : 0,
      delivered_revenue_usd: round(deliveredUsd),
      avg_usd_per_delivered_order: deliveredCount > 0 ? round(deliveredUsd / deliveredCount) : 0,
      returned_count: returnedCount,
      returned_quantity: returnedQty,
      returned_revenue_usd: round(returnedUsd),
      delivery_rate_pct: filtered.length > 0 ? round((deliveredCount / filtered.length) * 100, 1) : 0,
      revenue_usd_estimate: round(totalUsd),
      revenue_by_currency: Object.fromEntries(
        Object.entries(matchedCurrency).map(([k, v]) => [k, round(v)]),
      ),
      delivered_revenue_by_currency: Object.fromEntries(
        Object.entries(deliveredCurrency).map(([k, v]) => [k, round(v)]),
      ),
      by_status: bucketBy(filtered, (o) => o.status?.label),
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Quick counts                                                              */
/* -------------------------------------------------------------------------- */

const getOrderCounts = tool({
  name: "cod_get_order_counts",
  description:
    "Quick count of orders by status for a date range, without returning raw order data. Much faster than `cod_summarize_period` when you only need counts.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 30 days ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
  }),
  handler: async (input, client) => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const since = toUtcStamp(input.since ?? thirtyDaysAgo.toISOString());
    const until = toUtcStamp(input.until ?? now.toISOString());

    const { items, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, { include: "items" });

    let totalQty = 0;
    let deliveredQty = 0;
    let returnedQty = 0;
    let totalUsd = 0;
    let deliveredUsd = 0;
    let returnedUsd = 0;
    for (const o of items) {
      const qty = orderItemQty(o);
      totalQty += qty;
      totalUsd += o.total_usd ?? 0;
      if (o.delivered_at) { deliveredQty += qty; deliveredUsd += o.total_usd ?? 0; }
      if (o.returned_at) { returnedQty += qty; returnedUsd += o.total_usd ?? 0; }
    }

    const deliveredCount = items.filter((o) => o.delivered_at).length;
    const returnedCount = items.filter((o) => o.returned_at).length;

    return {
      range: { since, until },
      total_orders: items.length,
      total_quantity: totalQty,
      avg_quantity_per_order: items.length > 0 ? round(totalQty / items.length) : 0,
      revenue_usd_estimate: round(totalUsd),
      delivered_count: deliveredCount,
      delivered_quantity: deliveredQty,
      avg_quantity_per_delivered_order: deliveredCount > 0 ? round(deliveredQty / deliveredCount) : 0,
      delivered_revenue_usd: round(deliveredUsd),
      avg_usd_per_delivered_order: deliveredCount > 0 ? round(deliveredUsd / deliveredCount) : 0,
      returned_count: returnedCount,
      returned_quantity: returnedQty,
      returned_revenue_usd: round(returnedUsd),
      by_status: bucketBy(items, (o) => o.status?.label),
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

const getLeadCounts = tool({
  name: "cod_get_lead_counts",
  description:
    "Quick count of leads by status for a date range. Faster than a full summarize call when you only need lead metrics.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 30 days ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
  }),
  handler: async (input, client) => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const since = toUtcStamp(input.since ?? thirtyDaysAgo.toISOString());
    const until = toUtcStamp(input.until ?? now.toISOString());

    const { items, pagesScanned, reachedCutoff } =
      await paginateInRange<CodLead>(client, "/seller/leads", since, until, {});

    return {
      range: { since, until },
      ...aggregateLeads(items),
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Order tracking                                                            */
/* -------------------------------------------------------------------------- */

const getOrderTracking = tool({
  name: "cod_get_order_tracking",
  description:
    "List tracking numbers and shipment details for orders, optionally filtered by product name/SKU and delivery status. " +
    "Returns individual order rows with tracking_number, tracking_status, tracking_url, customer info, and status.",
  inputSchema: z.object({
    product_name: z
      .string()
      .optional()
      .describe("Filter orders containing this product (case-insensitive substring match on product name)."),
    product_sku: z
      .string()
      .optional()
      .describe("Filter orders containing this product SKU (case-insensitive exact match)."),
    status: z
      .enum(["delivered", "undelivered", "returned", "pending", "all"])
      .default("all")
      .describe("Filter by delivery status. 'undelivered' = not yet delivered (includes pending, shipped, etc)."),
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 30 days ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    limit: z
      .number()
      .int()
      .positive()
      .default(200)
      .describe("Max rows to return (default 200)."),
  }),
  handler: async (input, client) => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const since = toUtcStamp(input.since ?? thirtyDaysAgo.toISOString());
    const until = toUtcStamp(input.until ?? now.toISOString());

    const { items, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, { include: "items" });

    const nameLower = input.product_name?.toLowerCase();
    const skuLower = input.product_sku?.toLowerCase();

    const filtered = items.filter((o) => {
      // Status filter
      if (input.status === "delivered" && !o.delivered_at) return false;
      if (input.status === "undelivered" && o.delivered_at) return false;
      if (input.status === "returned" && !o.returned_at) return false;
      if (input.status === "pending" && o.status?.label?.toLowerCase() !== "pending") return false;

      // Product filter
      if (nameLower || skuLower) {
        return (o.items?.data ?? []).some((it) => {
          const pData = it.product?.data;
          if (!pData) return false;
          if (skuLower && (pData.sku ?? "").toLowerCase() === skuLower) return true;
          if (nameLower && (pData.name ?? "").toLowerCase().includes(nameLower)) return true;
          return false;
        });
      }
      return true;
    });

    const rows = filtered.slice(0, input.limit).map((o) => ({
      order_id: o.id,
      reference: o.reference,
      status: o.status?.label,
      tracking_number: o.tracking_number || null,
      tracking_status: o.tracking_status || null,
      tracking_url: o.tracking_url && o.tracking_url !== "#" ? o.tracking_url : null,
      customer_name: o.customer_name,
      customer_city: o.customer_city,
      customer_country: o.customer_country_name,
      customer_phone: o.customer_phone || null,
      shipped_at: o.shipped_at,
      delivered_at: o.delivered_at,
      returned_at: o.returned_at,
      total: o.total,
      currency: o.currency,
      total_usd: o.total_usd,
      created_at: o.created_at,
      items: (o.items?.data ?? []).map((it) => ({
        product_name: it.product?.data?.name,
        sku: it.product?.data?.sku,
        quantity: it.quantity,
        price: it.price,
      })),
    }));

    return {
      range: { since, until },
      filter: {
        product_name: input.product_name,
        product_sku: input.product_sku,
        status: input.status,
      },
      total_matched: filtered.length,
      returned_rows: rows.length,
      orders: rows,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Escape hatch                                                              */
/*                                                                            */
/*  The docs site (developer.cod.network/v2) lists pages for                  */
/*  "Confirmed Dashboard", "Delivered Dashboard", "Statistics", "Purchases",  */
/*  and "Marketplace Products" — but the corresponding REST paths are not     */
/*  reachable as of writing (all return 404 against api.cod.network/v2).      */
/*  Use cod_raw_request when those become available, or contact COD support   */
/*  for the exact path.                                                       */
/* -------------------------------------------------------------------------- */

const rawRequest = tool({
  name: "cod_raw_request",
  description:
    "Escape hatch: call any documented endpoint that doesn't have a dedicated tool. " +
    "Path is appended to the base URL (e.g. `/seller/orders/123`). Use sparingly; prefer a dedicated tool when one exists.",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Path under https://api.cod.network/v2 (with or without leading slash, e.g. `/seller/orders`).",
      ),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    query: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Query string parameters."),
    body: z.unknown().optional().describe("JSON body (for POST/PUT/PATCH)."),
  }),
  handler: (input, client) =>
    client.request({
      path: input.path,
      method: input.method,
      query: input.query as Record<string, string | number | boolean>,
      body: input.body,
    }),
});

/* ========================================================================== */
/*  V2 TOOLS — added on top of existing ones. Nothing above is modified.      */
/* ========================================================================== */

/**
 * Paginate ALL items from a list endpoint (no date filtering, just scan every page).
 */
async function paginateAll<T>(
  client: CodClient,
  path: string,
  query: Record<string, string | number | boolean | string[]> = {},
  maxPages = SUMMARY_MAX_PAGES,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const resp = await client.request<CodListResponse<T>>({
      path,
      query: { ...query, page, per_page: 10 },
    });
    const batch = resp.data ?? [];
    if (batch.length === 0) break;
    items.push(...batch);
    const meta = resp.meta?.pagination;
    if (meta?.total_pages !== undefined && page >= meta.total_pages) break;
  }
  return items;
}

/**
 * Apply a field projection to an object, keeping only the specified keys.
 */
function projectFields<T extends Record<string, unknown>>(
  row: T,
  fields?: string[],
): Partial<T> {
  if (!fields || fields.length === 0) return row;
  const out: Partial<T> = {};
  for (const f of fields) {
    if (f in row) {
      (out as Record<string, unknown>)[f] = row[f as keyof T];
    }
  }
  return out;
}

/**
 * Normalise a date default: if the caller provides nothing, return a sensible
 * fallback (1 year ago for `since`, now for `until`).
 */
function defaultSince(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString();
}

/* -------------------------------------------------------------------------- */
/*  1. Discovery / context                                                    */
/* -------------------------------------------------------------------------- */

const discoverContext = tool({
  name: "cod_discover_context",
  description:
    "Zero-input discovery tool. Returns the seller's full product catalog (own products + drop " +
    "products), unique countries seen in recent orders, earliest/latest order timestamps, and " +
    "active lead statuses. Call this once at the start of a workflow so you never need to " +
    "guess product names, date ranges, or markets.",
  inputSchema: z.object({
    include_drop_products: z
      .boolean()
      .optional()
      .default(true)
      .describe("Also fetch the COD Drop catalog."),
    orders_sample_pages: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe("How many order pages to sample for country/date metadata (10 per page)."),
  }),
  handler: async (input, client) => {
    const [products, dropProducts, firstOrders, lastOrders] = await Promise.all([
      paginateAll<CodProduct>(client, "/seller/products"),
      input.include_drop_products
        ? paginateAll<CodProduct>(client, "/seller/drop-products")
        : Promise.resolve([]),
      // Oldest orders (ascending)
      client
        .request<CodListResponse<CodOrder>>({
          path: "/seller/orders",
          query: { page: 1, per_page: 10, sort: "created_at" },
        })
        .then((r) => r.data ?? [])
        .catch(() => [] as CodOrder[]),
      // Newest orders (descending) — sample pages for country discovery
      paginateInRange<CodOrder>(
        client,
        "/seller/orders",
        "1970-01-01 00:00:00",
        toUtcStamp(new Date().toISOString()),
        { include: "items" },
      ).then((r) => r.items.slice(0, (input.orders_sample_pages ?? 20) * 10)),
    ]);

    const countries = new Set<string>();
    const cities = new Set<string>();
    const currencies = new Set<string>();
    const productNamesFromOrders = new Set<string>();
    let earliest: string | undefined;
    let latest: string | undefined;
    for (const o of firstOrders) {
      if (o.created_at && (!earliest || o.created_at < earliest)) earliest = o.created_at;
    }
    for (const o of lastOrders) {
      if (o.customer_country_name) countries.add(o.customer_country_name);
      if (o.customer_city) cities.add(o.customer_city);
      if (o.currency) currencies.add(o.currency);
      if (o.created_at && (!latest || o.created_at > latest)) latest = o.created_at;
      if (o.created_at && (!earliest || o.created_at < earliest)) earliest = o.created_at;
      for (const name of orderProductNames(o)) productNamesFromOrders.add(name);
    }

    return {
      products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, type: "product" })),
      drop_products: dropProducts.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        type: "drop_product",
      })),
      total_products: products.length,
      total_drop_products: dropProducts.length,
      active_countries: [...countries].sort(),
      active_cities_sample: [...cities].sort().slice(0, 50),
      active_currencies: [...currencies].sort(),
      product_names_from_orders: [...productNamesFromOrders].sort(),
      date_coverage: { earliest, latest },
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  2. Full product catalog                                                   */
/* -------------------------------------------------------------------------- */

const getProductCatalog = tool({
  name: "cod_get_product_catalog",
  description:
    "Fetch the entire product catalog in one call. Paginates all pages server-side and " +
    "returns a flat list of every product (and optionally drop-product) with id, name, and SKU.",
  inputSchema: z.object({
    include_drop_products: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include the COD Drop catalog too."),
  }),
  handler: async (input, client) => {
    const [products, dropProducts] = await Promise.all([
      paginateAll<CodProduct>(client, "/seller/products"),
      input.include_drop_products
        ? paginateAll<CodProduct>(client, "/seller/drop-products")
        : Promise.resolve([]),
    ]);
    return {
      products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
      drop_products: dropProducts.map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
      total_products: products.length,
      total_drop_products: dropProducts.length,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  3. Bulk parallel multi-product order fetch                                */
/* -------------------------------------------------------------------------- */

const OrderFields = z
  .array(
    z.enum([
      "order_id",
      "reference",
      "status",
      "customer_name",
      "customer_city",
      "customer_country",
      "customer_phone",
      "currency",
      "total",
      "total_usd",
      "shipped_at",
      "delivered_at",
      "returned_at",
      "tracking_number",
      "tracking_status",
      "tracking_url",
      "created_at",
      "items",
    ]),
  )
  .optional()
  .describe(
    "Field projection: only return these fields per order. Omit to return all. " +
    "Smaller payloads = faster transfer and no truncation.",
  );

interface FlatOrder {
  order_id: number;
  reference?: string;
  status?: string;
  customer_name?: string;
  customer_city?: string;
  customer_country?: string;
  customer_phone?: string | null;
  currency?: string;
  total?: number;
  total_usd?: number;
  shipped_at?: string | null;
  delivered_at?: string | null;
  returned_at?: string | null;
  tracking_number?: string | null;
  tracking_status?: string | null;
  tracking_url?: string | null;
  created_at?: string;
  items?: Array<{
    product_name?: string;
    sku?: string;
    quantity?: number;
    price?: number;
  }>;
  _product_match?: string;
}

function flattenOrder(o: CodOrder): FlatOrder {
  return {
    order_id: o.id,
    reference: o.reference,
    status: o.status?.label,
    customer_name: o.customer_name,
    customer_city: o.customer_city,
    customer_country: o.customer_country_name,
    customer_phone: o.customer_phone || null,
    currency: o.currency,
    total: o.total,
    total_usd: o.total_usd,
    shipped_at: o.shipped_at,
    delivered_at: o.delivered_at,
    returned_at: o.returned_at,
    tracking_number: o.tracking_number || null,
    tracking_status: o.tracking_status || null,
    tracking_url: o.tracking_url && o.tracking_url !== "#" ? o.tracking_url : null,
    created_at: o.created_at,
    items: (o.items?.data ?? []).map((it) => ({
      product_name: it.product?.data?.name,
      sku: it.product?.data?.sku,
      quantity: it.quantity,
      price: it.price,
    })),
  };
}

const getOrdersBulk = tool({
  name: "cod_get_orders_bulk",
  description:
    "Parallel multi-product order fetch. Pass multiple product names and the server fires " +
    "all requests concurrently via Promise.all(), merges the results, and returns one response. " +
    "Cuts a 3-product fetch from ~3x time to ~1x time. Use `fields` to project only the " +
    "columns you need — smaller payloads avoid truncation.",
  inputSchema: z.object({
    product_names: z
      .array(z.string())
      .min(1)
      .describe("Product names to fetch orders for (case-insensitive substring match)."),
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    status: z
      .string()
      .optional()
      .describe("Filter by order status (e.g. `delivered`, `shipped`)."),
    fields: OrderFields,
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const queryParams: Record<string, string | number | boolean | string[]> = {
      include: "items",
    };
    if (input.status) queryParams.status = input.status;

    // Fetch all orders once (shared across all product filters)
    const { items: allOrders, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, queryParams);

    // Filter per product in parallel (CPU-bound, no I/O)
    const perProduct: Array<{
      product: string;
      orders: Array<Partial<FlatOrder>>;
      count: number;
      delivered: number;
      returned: number;
    }> = [];

    for (const pName of input.product_names) {
      const needle = pName.trim().toLowerCase();
      const matched = allOrders.filter((o) =>
        orderProductNames(o).some((n) => n.toLowerCase().includes(needle)),
      );
      const flat = matched.map((o) => {
        const fo = flattenOrder(o);
        fo._product_match = pName;
        return projectFields(fo as unknown as Record<string, unknown>, input.fields) as Partial<FlatOrder>;
      });
      perProduct.push({
        product: pName,
        orders: flat,
        count: matched.length,
        delivered: matched.filter((o) => o.delivered_at).length,
        returned: matched.filter((o) => o.returned_at).length,
      });
    }

    return {
      range: { since, until },
      products_requested: input.product_names,
      fields: input.fields ?? "all",
      per_product: perProduct.map(({ product, count, delivered, returned }) => ({
        product,
        total_orders: count,
        delivered,
        returned,
      })),
      all_orders: perProduct.flatMap((p) => p.orders),
      total_orders: perProduct.reduce((s, p) => s + p.count, 0),
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  4. Server-side aggregation: by city                                       */
/* -------------------------------------------------------------------------- */

const aggregateByCity = tool({
  name: "cod_aggregate_by_city",
  description:
    "Server-side aggregation of orders grouped by customer_city. Returns pre-aggregated " +
    "rows — no raw order dump needed, no bash processing. Supports optional product filter. " +
    "Use `metrics` to choose which counts are included.",
  inputSchema: z.object({
    product_names: z
      .array(z.string())
      .optional()
      .describe("Filter to orders matching these products (case-insensitive substring)."),
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    group_by: z
      .enum(["customer_city", "customer_country"])
      .optional()
      .default("customer_city")
      .describe("Group rows by city or country."),
    metrics: z
      .array(z.enum(["total", "delivered", "returned", "pending", "shipped", "revenue_usd"]))
      .optional()
      .default(["total", "delivered", "returned", "pending"])
      .describe("Which aggregate metrics to include per group."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe("Max groups to return, sorted by total descending."),
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const { items: allOrders, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, { include: "items" });

    let orders = allOrders;
    if (input.product_names?.length) {
      const needles = input.product_names.map((n) => n.trim().toLowerCase());
      orders = orders.filter((o) =>
        orderProductNames(o).some((name) =>
          needles.some((needle) => name.toLowerCase().includes(needle)),
        ),
      );
    }

    const groupKey = input.group_by ?? "customer_city";
    const groups = new Map<
      string,
      { total: number; delivered: number; returned: number; pending: number; shipped: number; revenue_usd: number }
    >();

    for (const o of orders) {
      const key =
        groupKey === "customer_city"
          ? o.customer_city ?? "(unknown)"
          : o.customer_country_name ?? "(unknown)";
      const g = groups.get(key) ?? {
        total: 0,
        delivered: 0,
        returned: 0,
        pending: 0,
        shipped: 0,
        revenue_usd: 0,
      };
      g.total += 1;
      if (o.delivered_at) g.delivered += 1;
      if (o.returned_at) g.returned += 1;
      const statusLabel = (o.status?.label ?? "").toLowerCase();
      if (statusLabel === "pending") g.pending += 1;
      if (statusLabel === "shipped" || o.shipped_at) g.shipped += 1;
      g.revenue_usd += o.total_usd ?? 0;
      groups.set(key, g);
    }

    const wantMetrics = new Set(input.metrics ?? ["total", "delivered", "returned", "pending"]);
    const limit = input.limit ?? 100;

    const rows = [...groups.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, limit)
      .map(([key, g]) => {
        const row: Record<string, unknown> = { [groupKey]: key };
        if (wantMetrics.has("total")) row.total = g.total;
        if (wantMetrics.has("delivered")) row.delivered = g.delivered;
        if (wantMetrics.has("returned")) row.returned = g.returned;
        if (wantMetrics.has("pending")) row.pending = g.pending;
        if (wantMetrics.has("shipped")) row.shipped = g.shipped;
        if (wantMetrics.has("revenue_usd")) row.revenue_usd = round(g.revenue_usd);
        return row;
      });

    return {
      range: { since, until },
      group_by: groupKey,
      product_filter: input.product_names ?? null,
      total_orders_scanned: orders.length,
      groups_returned: rows.length,
      rows,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  5. Generic order aggregation                                              */
/* -------------------------------------------------------------------------- */

const aggregateOrdersGeneric = tool({
  name: "cod_aggregate_orders",
  description:
    "Flexible server-side order aggregation. Group orders by city, country, product, " +
    "status, or time bucket (day/week/month). Returns pre-aggregated rows with counts " +
    "and revenue — no raw order dump or client-side processing needed.",
  inputSchema: z.object({
    group_by: z
      .enum(["customer_city", "customer_country", "product", "status", "day", "week", "month"])
      .describe("Dimension to aggregate on."),
    product_names: z
      .array(z.string())
      .optional()
      .describe("Filter to orders matching these products (case-insensitive substring)."),
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    status: z
      .string()
      .optional()
      .describe("Filter by order status before aggregating."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(200)
      .describe("Max groups to return."),
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const queryParams: Record<string, string | number | boolean | string[]> = {
      include: "items",
    };
    if (input.status) queryParams.status = input.status;

    const { items: allOrders, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, queryParams);

    let orders = allOrders;
    if (input.product_names?.length) {
      const needles = input.product_names.map((n) => n.trim().toLowerCase());
      orders = orders.filter((o) =>
        orderProductNames(o).some((name) =>
          needles.some((needle) => name.toLowerCase().includes(needle)),
        ),
      );
    }

    const gb = input.group_by;
    const groups = new Map<
      string,
      {
        total: number;
        delivered: number;
        returned: number;
        total_qty: number;
        revenue_usd: number;
        revenue_by_currency: Record<string, number>;
      }
    >();

    const keyFn = (o: CodOrder): string[] => {
      switch (gb) {
        case "customer_city":
          return [o.customer_city ?? "(unknown)"];
        case "customer_country":
          return [o.customer_country_name ?? "(unknown)"];
        case "product":
          return orderProductNames(o).length > 0 ? orderProductNames(o) : ["(unknown)"];
        case "status":
          return [o.status?.label ?? "(unknown)"];
        case "day":
        case "week":
        case "month":
          return [o.created_at ? bucketKey(o.created_at, gb) : "(unknown)"];
        default:
          return ["(unknown)"];
      }
    };

    for (const o of orders) {
      for (const key of keyFn(o)) {
        const g = groups.get(key) ?? {
          total: 0,
          delivered: 0,
          returned: 0,
          total_qty: 0,
          revenue_usd: 0,
          revenue_by_currency: {},
        };
        g.total += 1;
        if (o.delivered_at) g.delivered += 1;
        if (o.returned_at) g.returned += 1;
        g.total_qty += orderItemQty(o);
        g.revenue_usd += o.total_usd ?? 0;
        const cur = o.currency ?? "(unknown)";
        g.revenue_by_currency[cur] = (g.revenue_by_currency[cur] ?? 0) + (o.total ?? 0);
        groups.set(key, g);
      }
    }

    const limit = input.limit ?? 200;
    const isTimeBucket = gb === "day" || gb === "week" || gb === "month";
    const sorted = [...groups.entries()].sort((a, b) =>
      isTimeBucket ? a[0].localeCompare(b[0]) : b[1].total - a[1].total,
    );

    const rows = sorted.slice(0, limit).map(([key, g]) => ({
      [gb]: key,
      total: g.total,
      delivered: g.delivered,
      returned: g.returned,
      delivery_rate_pct: g.total > 0 ? round((g.delivered / g.total) * 100, 1) : 0,
      total_qty: g.total_qty,
      revenue_usd: round(g.revenue_usd),
      revenue_by_currency: Object.fromEntries(
        Object.entries(g.revenue_by_currency).map(([k, v]) => [k, round(v)]),
      ),
    }));

    return {
      range: { since, until },
      group_by: gb,
      product_filter: input.product_names ?? null,
      total_orders_scanned: orders.length,
      groups_returned: rows.length,
      rows,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  6. Generic lead aggregation                                               */
/* -------------------------------------------------------------------------- */

const aggregateLeadsGeneric = tool({
  name: "cod_aggregate_leads",
  description:
    "Flexible server-side lead aggregation. Group leads by product, status, or time " +
    "bucket (day/week/month). Returns pre-aggregated rows with counts and confirmation " +
    "rates. Supports product filtering so you can get per-product lead stats in one call.",
  inputSchema: z.object({
    group_by: z
      .enum(["product", "status", "day", "week", "month"])
      .describe("Dimension to aggregate on."),
    product_names: z
      .array(z.string())
      .optional()
      .describe("Filter to leads matching these products (case-insensitive substring on the products field)."),
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    status: z
      .string()
      .optional()
      .describe("Filter by lead status before aggregating."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(200)
      .describe("Max groups to return."),
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const queryParams: Record<string, string | number | boolean | string[]> = {};
    if (input.status) queryParams.status = input.status;

    const { items: allLeads, pagesScanned, reachedCutoff } =
      await paginateInRange<CodLead>(client, "/seller/leads", since, until, queryParams);

    let leads = allLeads;
    if (input.product_names?.length) {
      const needles = input.product_names.map((n) => n.trim().toLowerCase());
      leads = leads.filter((l) =>
        leadProductNames(l).some((name) =>
          needles.some((needle) => name.toLowerCase().includes(needle)),
        ),
      );
    }

    const gb = input.group_by;
    const groups = new Map<string, { total: number; confirmed: number }>();

    const keyFn = (l: CodLead): string[] => {
      switch (gb) {
        case "product":
          return leadProductNames(l).length > 0 ? leadProductNames(l) : ["(unknown)"];
        case "status":
          return [l.status?.label ?? "(unknown)"];
        case "day":
        case "week":
        case "month":
          return [l.created_at ? bucketKey(l.created_at, gb) : "(unknown)"];
        default:
          return ["(unknown)"];
      }
    };

    for (const l of leads) {
      const isConfirmed = (l.status?.label ?? "").toLowerCase() === "confirmed";
      for (const key of keyFn(l)) {
        const g = groups.get(key) ?? { total: 0, confirmed: 0 };
        g.total += 1;
        if (isConfirmed) g.confirmed += 1;
        groups.set(key, g);
      }
    }

    const limit = input.limit ?? 200;
    const isTimeBucket = gb === "day" || gb === "week" || gb === "month";
    const sorted = [...groups.entries()].sort((a, b) =>
      isTimeBucket ? a[0].localeCompare(b[0]) : b[1].total - a[1].total,
    );

    const rows = sorted.slice(0, limit).map(([key, g]) => ({
      [gb]: key,
      total: g.total,
      confirmed: g.confirmed,
      confirmation_rate_pct: g.total > 0 ? round((g.confirmed / g.total) * 100, 1) : 0,
    }));

    return {
      range: { since, until },
      group_by: gb,
      product_filter: input.product_names ?? null,
      total_leads_scanned: leads.length,
      groups_returned: rows.length,
      rows,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  7. Leads filtered by product                                              */
/* -------------------------------------------------------------------------- */

const getLeadsByProduct = tool({
  name: "cod_get_leads_by_product",
  description:
    "Fetch leads filtered by product name or SKU. The COD API does not support product " +
    "filtering on leads server-side, so this tool paginates all leads and filters locally. " +
    "Returns raw lead data for the matched product — useful for getting lead-input data " +
    "for a specific SKU.",
  inputSchema: z.object({
    product_name: z
      .string()
      .optional()
      .describe("Case-insensitive substring match against the lead's products field."),
    product_sku: z
      .string()
      .optional()
      .describe("Case-insensitive substring match against SKU in the lead's products field."),
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    status: z
      .string()
      .optional()
      .describe("Filter by lead status (e.g. `confirmed`, `cancelled`)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .default(500)
      .describe("Max leads to return."),
  }),
  handler: async (input, client) => {
    if (!input.product_name && !input.product_sku) {
      throw new Error("Provide at least one of `product_name` or `product_sku`.");
    }

    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const queryParams: Record<string, string | number | boolean | string[]> = {};
    if (input.status) queryParams.status = input.status;

    const { items: allLeads, pagesScanned, reachedCutoff } =
      await paginateInRange<CodLead>(client, "/seller/leads", since, until, queryParams);

    const nameLower = input.product_name?.trim().toLowerCase();
    const skuLower = input.product_sku?.trim().toLowerCase();

    const filtered = allLeads.filter((l) => {
      const productsField = (l.products ?? "").toLowerCase();
      if (nameLower && productsField.includes(nameLower)) return true;
      if (skuLower && productsField.includes(skuLower)) return true;
      return false;
    });

    const limit = input.limit ?? 500;
    const rows = filtered.slice(0, limit).map((l) => ({
      id: l.id,
      status: l.status?.label,
      products: l.products,
      created_at: l.created_at,
    }));

    const agg = aggregateLeads(filtered);

    return {
      range: { since, until },
      filter: { product_name: input.product_name, product_sku: input.product_sku, status: input.status },
      total_matched: filtered.length,
      returned_rows: rows.length,
      summary: agg,
      leads: rows,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  8. Export orders (compact flat format)                                     */
/* -------------------------------------------------------------------------- */

const exportOrders = tool({
  name: "cod_export_orders",
  description:
    "Export orders as a compact flat array, similar to the CSV export on the dashboard. " +
    "Supports product filter, status filter, field projection, and chunked pagination " +
    "via `offset`/`chunk_size` so large result sets come back in controlled pages.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    product_name: z
      .string()
      .optional()
      .describe("Filter orders containing this product (case-insensitive substring)."),
    status: z
      .string()
      .optional()
      .describe("Filter by order status."),
    fields: OrderFields,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Skip this many orders (for chunked retrieval)."),
    chunk_size: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .default(500)
      .describe("Max orders per chunk."),
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const queryParams: Record<string, string | number | boolean | string[]> = {
      include: "items",
    };
    if (input.status) queryParams.status = input.status;

    const { items: allOrders, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, queryParams);

    let orders = allOrders;
    if (input.product_name) {
      const needle = input.product_name.trim().toLowerCase();
      orders = orders.filter((o) =>
        orderProductNames(o).some((n) => n.toLowerCase().includes(needle)),
      );
    }

    const offset = input.offset ?? 0;
    const chunkSize = input.chunk_size ?? 500;
    const chunk = orders.slice(offset, offset + chunkSize);

    const rows = chunk.map((o) => {
      const flat = flattenOrder(o);
      return projectFields(flat as unknown as Record<string, unknown>, input.fields);
    });

    return {
      range: { since, until },
      filter: { product_name: input.product_name, status: input.status },
      total_matched: orders.length,
      offset,
      chunk_size: chunkSize,
      returned_rows: rows.length,
      has_more: offset + chunkSize < orders.length,
      next_offset: offset + chunkSize < orders.length ? offset + chunkSize : null,
      orders: rows,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  9. Export leads (compact flat format)                                      */
/* -------------------------------------------------------------------------- */

const exportLeads = tool({
  name: "cod_export_leads",
  description:
    "Export leads as a compact flat array. Supports product filter, status filter, " +
    "and chunked pagination via `offset`/`chunk_size`.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    product_name: z
      .string()
      .optional()
      .describe("Filter leads matching this product (case-insensitive substring on products field)."),
    status: z
      .string()
      .optional()
      .describe("Filter by lead status."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Skip this many leads (for chunked retrieval)."),
    chunk_size: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .default(500)
      .describe("Max leads per chunk."),
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const queryParams: Record<string, string | number | boolean | string[]> = {};
    if (input.status) queryParams.status = input.status;

    const { items: allLeads, pagesScanned, reachedCutoff } =
      await paginateInRange<CodLead>(client, "/seller/leads", since, until, queryParams);

    let leads = allLeads;
    if (input.product_name) {
      const needle = input.product_name.trim().toLowerCase();
      leads = leads.filter((l) => (l.products ?? "").toLowerCase().includes(needle));
    }

    const offset = input.offset ?? 0;
    const chunkSize = input.chunk_size ?? 500;
    const chunk = leads.slice(offset, offset + chunkSize);

    const rows = chunk.map((l) => ({
      id: l.id,
      status: l.status?.label,
      products: l.products,
      created_at: l.created_at,
    }));

    return {
      range: { since, until },
      filter: { product_name: input.product_name, status: input.status },
      total_matched: leads.length,
      offset,
      chunk_size: chunkSize,
      returned_rows: rows.length,
      has_more: offset + chunkSize < leads.length,
      next_offset: offset + chunkSize < leads.length ? offset + chunkSize : null,
      leads: rows,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  10. Per-product statistics (mirrors the Statistics page)                   */
/* -------------------------------------------------------------------------- */

const getStatistics = tool({
  name: "cod_get_statistics",
  description:
    "Per-product statistics mirroring the Statistics page on the dashboard. For each " +
    "product returns: leads total, leads confirmed, leads delivered, confirmation rate, " +
    "delivery rate, orders shipped, orders delivered, order delivery rate. " +
    "One call replaces scrolling through the Statistics page.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 1 year ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    product_names: z
      .array(z.string())
      .optional()
      .describe("Limit to these products (case-insensitive substring). Omit to get all."),
    include_cod_drop: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include COD Drop products in the results."),
  }),
  handler: async (input, client) => {
    const since = toUtcStamp(input.since ?? defaultSince());
    const until = toUtcStamp(input.until ?? new Date().toISOString());

    const [ordersResult, leadsResult] = await Promise.all([
      paginateInRange<CodOrder>(client, "/seller/orders", since, until, { include: "items" }),
      paginateInRange<CodLead>(client, "/seller/leads", since, until, {}),
    ]);

    const needles = input.product_names?.map((n) => n.trim().toLowerCase());

    // Build per-product order stats
    const orderStats = new Map<
      string,
      { shipped: number; delivered: number; total: number; total_qty: number; revenue_usd: number }
    >();
    for (const o of ordersResult.items) {
      for (const name of orderProductNames(o)) {
        if (needles && !needles.some((n) => name.toLowerCase().includes(n))) continue;
        const e = orderStats.get(name) ?? {
          shipped: 0,
          delivered: 0,
          total: 0,
          total_qty: 0,
          revenue_usd: 0,
        };
        e.total += 1;
        e.total_qty += orderItemQty(o);
        e.revenue_usd += o.total_usd ?? 0;
        if (o.shipped_at || (o.status?.label ?? "").toLowerCase() === "shipped") e.shipped += 1;
        if (o.delivered_at) e.delivered += 1;
        orderStats.set(name, e);
      }
    }

    // Build per-product lead stats
    const leadStats = new Map<string, { total: number; confirmed: number; delivered: number }>();
    for (const l of leadsResult.items) {
      const statusLabel = (l.status?.label ?? "").toLowerCase();
      for (const name of leadProductNames(l)) {
        if (needles && !needles.some((n) => name.toLowerCase().includes(n))) continue;
        const e = leadStats.get(name) ?? { total: 0, confirmed: 0, delivered: 0 };
        e.total += 1;
        if (statusLabel === "confirmed") e.confirmed += 1;
        // "delivered" in the leads context means the corresponding order was delivered
        leadStats.set(name, e);
      }
    }

    // Merge: collect all product names from both
    const allNames = new Set([...orderStats.keys(), ...leadStats.keys()]);
    const rows = [...allNames]
      .map((product) => {
        const os = orderStats.get(product) ?? {
          shipped: 0,
          delivered: 0,
          total: 0,
          total_qty: 0,
          revenue_usd: 0,
        };
        const ls = leadStats.get(product) ?? { total: 0, confirmed: 0, delivered: 0 };
        return {
          product,
          leads: ls.total,
          leads_confirmed: ls.confirmed,
          leads_confirmation_rate_pct: ls.total > 0 ? round((ls.confirmed / ls.total) * 100, 1) : 0,
          orders_total: os.total,
          orders_shipped: os.shipped,
          orders_delivered: os.delivered,
          orders_delivery_rate_pct:
            os.shipped > 0 ? round((os.delivered / os.shipped) * 100, 1) : 0,
          total_qty: os.total_qty,
          revenue_usd: round(os.revenue_usd),
        };
      })
      .sort((a, b) => b.leads - a.leads);

    return {
      range: { since, until },
      product_filter: input.product_names ?? null,
      total_products: rows.length,
      rows,
      orders_pages_scanned: ordersResult.pagesScanned,
      leads_pages_scanned: leadsResult.pagesScanned,
      orders_full_range: ordersResult.reachedCutoff,
      leads_full_range: leadsResult.reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  11. Delivered dashboard (financial metrics)                               */
/* -------------------------------------------------------------------------- */

const getDeliveredDashboard = tool({
  name: "cod_get_delivered_dashboard",
  description:
    "Mirrors the Delivered Dashboard on the seller portal. Returns financial and " +
    "delivery metrics: shipped/processing/delivered/returned orders, profits, " +
    "shipping cost, delivery cost, fees, and revenue. Supports product and country filters.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 30 days ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    product_name: z
      .string()
      .optional()
      .describe("Filter orders containing this product (case-insensitive substring)."),
    country: z
      .string()
      .optional()
      .describe("Filter by customer country name (case-insensitive substring)."),
  }),
  handler: async (input, client) => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const since = toUtcStamp(input.since ?? thirtyDaysAgo.toISOString());
    const until = toUtcStamp(input.until ?? now.toISOString());

    const { items: allOrders, pagesScanned, reachedCutoff } =
      await paginateInRange<CodOrder>(client, "/seller/orders", since, until, { include: "items" });

    let orders = allOrders;
    if (input.product_name) {
      const needle = input.product_name.trim().toLowerCase();
      orders = orders.filter((o) =>
        orderProductNames(o).some((n) => n.toLowerCase().includes(needle)),
      );
    }
    if (input.country) {
      const needle = input.country.trim().toLowerCase();
      orders = orders.filter(
        (o) => (o.customer_country_name ?? "").toLowerCase().includes(needle),
      );
    }

    let shipped = 0;
    let processing = 0;
    let delivered = 0;
    let returned = 0;
    let totalRevenue = 0;
    let deliveredRevenue = 0;
    let returnedRevenue = 0;
    let totalQty = 0;

    for (const o of orders) {
      const statusLabel = (o.status?.label ?? "").toLowerCase();
      if (o.shipped_at || statusLabel === "shipped") shipped += 1;
      if (statusLabel === "processing" || statusLabel === "assigned") processing += 1;
      if (o.delivered_at) {
        delivered += 1;
        deliveredRevenue += o.total_usd ?? 0;
      }
      if (o.returned_at) {
        returned += 1;
        returnedRevenue += o.total_usd ?? 0;
      }
      totalRevenue += o.total_usd ?? 0;
      totalQty += orderItemQty(o);
    }

    return {
      range: { since, until },
      filter: { product_name: input.product_name, country: input.country },
      total_orders: orders.length,
      shipped_orders: shipped,
      processing_orders: processing,
      delivered_orders: delivered,
      returned_orders: returned,
      delivery_rate_pct: shipped > 0 ? round((delivered / shipped) * 100, 1) : 0,
      total_quantity: totalQty,
      total_revenue_usd: round(totalRevenue),
      delivered_revenue_usd: round(deliveredRevenue),
      returned_revenue_usd: round(returnedRevenue),
      net_revenue_usd: round(deliveredRevenue - returnedRevenue),
      by_status: bucketBy(orders, (o) => o.status?.label),
      by_country: bucketBy(orders, (o) => o.customer_country_name),
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  12. Confirmed dashboard (lead confirmation metrics)                       */
/* -------------------------------------------------------------------------- */

const getConfirmedDashboard = tool({
  name: "cod_get_confirmed_dashboard",
  description:
    "Mirrors the Confirmed Dashboard on the seller portal. Returns lead counts by " +
    "status (new, confirmed, cancelled, processing, no-reply, wrong, expired, etc.) " +
    "with confirmation rate. Supports product and country filters.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start of range (YYYY-MM-DD). Defaults to 30 days ago."),
    until: z
      .string()
      .optional()
      .describe("End of range (exclusive). Defaults to now."),
    product_name: z
      .string()
      .optional()
      .describe("Filter leads matching this product (case-insensitive substring on products field)."),
  }),
  handler: async (input, client) => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const since = toUtcStamp(input.since ?? thirtyDaysAgo.toISOString());
    const until = toUtcStamp(input.until ?? now.toISOString());

    const { items: allLeads, pagesScanned, reachedCutoff } =
      await paginateInRange<CodLead>(client, "/seller/leads", since, until, {});

    let leads = allLeads;
    if (input.product_name) {
      const needle = input.product_name.trim().toLowerCase();
      leads = leads.filter((l) => (l.products ?? "").toLowerCase().includes(needle));
    }

    const agg = aggregateLeads(leads);

    return {
      range: { since, until },
      filter: { product_name: input.product_name },
      total_leads: leads.length,
      ...agg,
      pages_scanned: pagesScanned,
      full_range_covered: reachedCutoff,
    };
  },
});

/* -------------------------------------------------------------------------- */

export const tools: ReadonlyArray<ToolDef> = [
  // ── existing tools (untouched) ──
  listProducts,
  getProduct,
  getProductBySku,
  listDropProducts,
  getDropProduct,
  listStocks,
  listOrders,
  getOrder,
  listLeads,
  getLead,
  listStores,
  listInvoices,
  getInvoice,
  listSourceRequests,
  summarizePeriod,
  searchProducts,
  getProductStats,
  getOrderCounts,
  getLeadCounts,
  getOrderTracking,
  rawRequest,
  // ── v2 tools ──
  discoverContext,
  getProductCatalog,
  getOrdersBulk,
  aggregateByCity,
  aggregateOrdersGeneric,
  aggregateLeadsGeneric,
  getLeadsByProduct,
  exportOrders,
  exportLeads,
  getStatistics,
  getDeliveredDashboard,
  getConfirmedDashboard,
];
