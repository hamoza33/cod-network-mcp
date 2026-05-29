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
  page: z.number().int().min(1).optional().describe("Page number (1-based). Each page returns `per_page` items."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Items per page (max 100, default 10). The tool internally paginates through the API to collect this many items. For example, per_page=100 fetches 10 internal API pages and returns 100 items. May take a few seconds for large values.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Alias for `per_page`. If both are provided, `per_page` takes priority.",
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

const API_PAGE_SIZE = 10;

interface CodListResponse<T> {
  data: T[];
  meta?: { pagination?: { total?: number; current_page?: number; total_pages?: number } };
}

/**
 * Fetch items with virtual pagination. The COD API hard-caps at 10 items per
 * page, but callers can request up to 100 via `per_page`. This function
 * internally fetches multiple API pages to fill the requested page size, and
 * uses the caller's `page` to compute the correct offset.
 *
 * Also accepts `limit` as a backward-compatible alias for `per_page`.
 *
 * Example: per_page=100, page=2 → fetches API pages 11-20 (items 101-200).
 */
async function fetchWithPagination<T>(
  client: CodClient,
  path: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  // Accept `limit` as backward-compat alias for `per_page`.
  const rawPerPage = typeof input.per_page === "number"
    ? input.per_page
    : typeof input.limit === "number"
      ? input.limit
      : 10;
  const requestedPerPage = Math.min(rawPerPage, 100);
  const requestedPage = typeof input.page === "number" ? input.page : 1;

  if (requestedPerPage <= API_PAGE_SIZE) {
    // No internal pagination needed — pass through directly (strip limit).
    const passQuery = q(input);
    delete passQuery.limit;
    return client.request({ path, query: passQuery });
  }

  // Strip page/per_page/limit from query — we manage them internally.
  const query = q(input);
  delete query.page;
  delete query.per_page;
  delete query.limit;

  const internalPagesNeeded = Math.ceil(requestedPerPage / API_PAGE_SIZE);
  const startApiPage = (requestedPage - 1) * internalPagesNeeded + 1;

  const items: T[] = [];
  let totalItems: number | undefined;
  let totalApiPages: number | undefined;

  for (let i = 0; i < internalPagesNeeded; i++) {
    const apiPage = startApiPage + i;
    if (totalApiPages !== undefined && apiPage > totalApiPages) break;

    const resp = await client.request<CodListResponse<T>>({
      path,
      query: { ...query, page: apiPage, per_page: API_PAGE_SIZE },
    });
    const batch = resp.data ?? [];
    if (batch.length === 0) break;
    items.push(...batch);

    const meta = resp.meta?.pagination;
    if (meta?.total !== undefined) totalItems = meta.total;
    if (meta?.total_pages !== undefined) totalApiPages = meta.total_pages;
  }

  const virtualTotalPages = totalApiPages !== undefined
    ? Math.ceil(totalApiPages / internalPagesNeeded)
    : undefined;

  return {
    data: items.slice(0, requestedPerPage),
    meta: {
      pagination: {
        total: totalItems,
        current_page: requestedPage,
        per_page: requestedPerPage,
        total_pages: virtualTotalPages,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Catalog: products, drop products, marketplace, stocks                     */
/* -------------------------------------------------------------------------- */

const listProducts = tool({
  name: "cod_list_products",
  description:
    "List the seller's products (catalog of items the seller manages, with stock per warehouse). Use `per_page` (up to 100) to get more items per page. The API ignores `name=` / `q=` filters server-side — for name/SKU substring search use `cod_search_products` instead.",
  inputSchema: z.object({ ...Pagination, ...Sort }),
  handler: (input, client) =>
    fetchWithPagination(client, "/seller/products", input),
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
    "List the seller's drop products (dropshipping catalog with up-sell pricing, media and landing pages). Use `per_page` (up to 100) to get more items per page. The `name=` and `sku=` filters are EXACT-match server-side — for substring search use `cod_search_products` with `kind: 'drop_products'`.",
  inputSchema: z.object({
    name: z.string().optional().describe("Filter by exact drop product name (case-sensitive)."),
    sku: z.string().optional().describe("Filter by exact SKU."),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    fetchWithPagination(client, "/seller/drop-products", input),
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
  description: "List stock levels per product per warehouse / country. Use `per_page` (up to 100) to get more items per page.",
  inputSchema: z.object({
    product_id: z.union([z.string(), z.number()]).optional(),
    sku: z.string().optional(),
    country: z.string().optional().describe("Country ISO code 2."),
    project: z.string().optional().describe("Warehouse project name."),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    fetchWithPagination(client, "/seller/stocks", input),
});

/* -------------------------------------------------------------------------- */
/*  Orders & leads                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Strip an order down to essential fields for compact mode.
 * Keeps: id, reference, status, customer info, totals, dates, tracking, items
 * summary. Drops: large HTML descriptions, nested product blobs, media, etc.
 */
function compactOrder(order: Record<string, unknown>): Record<string, unknown> {
  const items = order.items as { data?: Record<string, unknown>[] } | undefined;
  const compactItems = items?.data?.map((item: Record<string, unknown>) => {
    const product = item.product as { data?: Record<string, unknown> } | undefined;
    return {
      quantity: item.quantity,
      price: item.price,
      product_id: product?.data?.id,
      product_name: product?.data?.name,
      product_sku: product?.data?.sku,
    };
  });

  const customer = order.customer as { data?: Record<string, unknown> } | undefined;
  const compactCustomer = customer?.data
    ? {
        name: customer.data.name,
        phone: customer.data.phone,
        city: customer.data.city,
        country: customer.data.country_name ?? customer.data.country,
      }
    : undefined;

  return {
    id: order.id,
    reference: order.reference,
    status: order.status,
    customer_name: order.customer_name ?? compactCustomer?.name,
    customer_phone: order.customer_phone ?? compactCustomer?.phone,
    customer_city: order.customer_city ?? compactCustomer?.city,
    customer_country: order.customer_country_name ?? compactCustomer?.country,
    total: order.total,
    total_usd: order.total_usd,
    currency: order.currency,
    tracking_number: order.tracking_number,
    tracking_status: order.tracking_status,
    tracking_url: order.tracking_url,
    shipped_at: order.shipped_at,
    delivered_at: order.delivered_at,
    returned_at: order.returned_at,
    created_at: order.created_at,
    ...(compactItems ? { items: compactItems } : {}),
    ...(compactCustomer && !order.customer_name ? { customer: compactCustomer } : {}),
  };
}

const listOrders = tool({
  name: "cod_list_orders",
  description:
    "List the seller's orders, newest first. Each order includes customer info, status, shipping and delivery dates. Use `per_page` (up to 100) to get more items per page (may take a few seconds). Use `page` to paginate through all results. Set `compact: true` (recommended for large fetches) to strip heavy fields like product descriptions and keep only essential order data — this dramatically reduces response size.",
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
    compact: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "When true (default), strips large nested objects (product descriptions, HTML, media) and returns only essential fields per order. Set to false for full API response.",
      ),
    ...Includes,
    ...Pagination,
    ...Sort,
  }),
  handler: async (input, client) => {
    const compact = input.compact !== false;
    const { compact: _compact, ...rest } = input;
    const result = await fetchWithPagination(client, "/seller/orders", rest) as Record<string, unknown>;
    if (!compact) return result;
    const data = result.data as Record<string, unknown>[] | undefined;
    if (!data) return result;
    return { ...result, data: data.map(compactOrder) };
  },
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
    "List leads (incoming orders before confirmation), newest first. Includes customer details, status and source. Use `per_page` (up to 100) to get more items per page. Set `compact: true` (recommended) to reduce response size.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Filter by lead status (e.g. `new`, `confirmed`, `cancelled`)."),
    customer_phone: z.string().optional(),
    compact: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "When true (default), strips large nested objects and returns only essential fields.",
      ),
    ...Includes,
    ...Pagination,
    ...Sort,
  }),
  handler: async (input, client) => {
    const compact = input.compact !== false;
    const { compact: _compact, ...rest } = input;
    const result = await fetchWithPagination(client, "/seller/leads", rest) as Record<string, unknown>;
    if (!compact) return result;
    const data = result.data as Record<string, unknown>[] | undefined;
    if (!data) return result;
    return { ...result, data: data.map(compactOrder) };
  },
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
    "List the seller's connected stores (e.g. Shopify, WooCommerce, YouCan integrations). Use `per_page` (up to 100) to get more items per page.",
  inputSchema: z.object({ ...Pagination, ...Sort }),
  handler: (input, client) =>
    fetchWithPagination(client, "/seller/stores", input),
});

const listInvoices = tool({
  name: "cod_list_invoices",
  description:
    "List the seller's invoices (remittance / payouts), newest first. Use `per_page` (up to 100) to get more items per page.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Filter by invoice status (e.g. `paid`, `pending`)."),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    fetchWithPagination(client, "/seller/invoices", input),
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
  description: "List sourcing requests submitted to COD Network. Use `per_page` (up to 100) to get more items per page.",
  inputSchema: z.object({
    status: z.string().optional(),
    ...Pagination,
    ...Sort,
  }),
  handler: (input, client) =>
    fetchWithPagination(client, "/seller/source-requests", input),
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
 * The API hard-caps at 10 per page, so concurrent fetching is important
 * for large date ranges.
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
          query: { ...query, page: p, per_page: API_PAGE_SIZE, sort: "-created_at" },
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
          query: { page, per_page: API_PAGE_SIZE },
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
          query: { page, per_page: API_PAGE_SIZE },
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
        query: { sku: input.sku.trim(), page: 1, per_page: API_PAGE_SIZE },
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

/* -------------------------------------------------------------------------- */

export const tools: ReadonlyArray<ToolDef> = [
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
];
