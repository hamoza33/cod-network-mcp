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
    "List the seller's products (catalog of items the seller manages, with stock per warehouse). Supports pagination and sorting.",
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
    "List the seller's drop products (dropshipping catalog with up-sell pricing, media and landing pages). Supports filtering by name or sku.",
  inputSchema: z.object({
    name: z.string().optional().describe("Filter by drop product name."),
    sku: z.string().optional().describe("Filter by sku."),
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

interface CodOrder {
  id: number;
  status?: { label?: string; code?: number };
  customer_country_name?: string;
  currency?: string;
  total?: number;
  total_usd?: number;
  delivered_at?: string | null;
  returned_at?: string | null;
  created_at?: string;
}

interface CodLead {
  id: number;
  status?: { label?: string; code?: number };
  created_at?: string;
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
  while (page <= SUMMARY_MAX_PAGES) {
    const resp = await client.request<CodListResponse<T>>({
      path,
      query: { ...query, page, per_page: 10, sort: "-created_at" },
    });
    const batch = resp.data ?? [];
    if (batch.length === 0) break;
    for (const row of batch) {
      const ts = row.created_at ?? "";
      if (ts >= until) continue;
      if (ts < since) {
        reachedCutoff = true;
        break;
      }
      items.push(row);
    }
    // Newest first means once we cross `since` we're done.
    if (reachedCutoff) break;
    // Defensive stop if API runs out.
    const meta = resp.meta?.pagination;
    if (meta?.total_pages !== undefined && page >= meta.total_pages) break;
    page += 1;
  }
  // `page` is already incremented past the last fetched page when the loop
  // hits SUMMARY_MAX_PAGES; clamp so the count reflects actual API calls.
  return { items, pagesScanned: Math.min(page, SUMMARY_MAX_PAGES), reachedCutoff };
}

function bucketBy<T>(rows: T[], key: (r: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) ?? "(unknown)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const summarizePeriod = tool({
  name: "cod_summarize_period",
  description:
    "One-shot summary of leads + orders within a date range. Paginates the COD API internally and returns aggregate counts by status and country, revenue per currency, and confirmation/delivery rates — without you having to scroll through pages of raw rows. Prefer this for any 'today', 'last week', 'this month' style question.",
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
    include_examples: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, include lists of `order_ids` and `lead_ids` (capped at 50 each) so you can drill down with `cod_get_order` / `cod_get_lead`.",
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

    const [ordersResult, leadsResult] = await Promise.all([
      wantOrders
        ? paginateInRange<CodOrder>(client, "/seller/orders", since, until, {})
        : Promise.resolve({ items: [], pagesScanned: 0, reachedCutoff: true }),
      wantLeads
        ? paginateInRange<CodLead>(client, "/seller/leads", since, until, {})
        : Promise.resolve({ items: [], pagesScanned: 0, reachedCutoff: true }),
    ]);

    const ordersByStatus = bucketBy(ordersResult.items, (o) => o.status?.label);
    const ordersByCountry = bucketBy(ordersResult.items, (o) => o.customer_country_name);
    const revenueByCurrency: Record<string, number> = {};
    let revenueUsd = 0;
    for (const o of ordersResult.items) {
      const cur = o.currency ?? "(unknown)";
      revenueByCurrency[cur] = (revenueByCurrency[cur] ?? 0) + (o.total ?? 0);
      revenueUsd += o.total_usd ?? 0;
    }

    const delivered = ordersResult.items.filter((o) => o.delivered_at).length;
    const returned = ordersResult.items.filter((o) => o.returned_at).length;

    const leadsByStatus = bucketBy(leadsResult.items, (l) => l.status?.label);
    const confirmedLeads = leadsResult.items.filter(
      (l) => (l.status?.label ?? "").toLowerCase() === "confirmed",
    ).length;

    const round = (n: number, dp = 2): number =>
      Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);

    const summary: Record<string, unknown> = {
      range: { since, until },
      orders: wantOrders
        ? {
            count: ordersResult.items.length,
            by_status: ordersByStatus,
            by_country: ordersByCountry,
            revenue_by_currency: Object.fromEntries(
              Object.entries(revenueByCurrency).map(([k, v]) => [k, round(v)]),
            ),
            revenue_usd_estimate: round(revenueUsd),
            delivered_count: delivered,
            returned_count: returned,
            delivery_rate_pct:
              ordersResult.items.length > 0
                ? round((delivered / ordersResult.items.length) * 100, 1)
                : 0,
            pages_scanned: ordersResult.pagesScanned,
            full_range_covered: ordersResult.reachedCutoff,
          }
        : undefined,
      leads: wantLeads
        ? {
            count: leadsResult.items.length,
            by_status: leadsByStatus,
            confirmed_count: confirmedLeads,
            confirmation_rate_pct:
              leadsResult.items.length > 0
                ? round((confirmedLeads / leadsResult.items.length) * 100, 1)
                : 0,
            pages_scanned: leadsResult.pagesScanned,
            full_range_covered: leadsResult.reachedCutoff,
          }
        : undefined,
    };

    if (input.include_examples) {
      summary.examples = {
        order_ids: ordersResult.items.slice(0, 50).map((o) => o.id),
        lead_ids: leadsResult.items.slice(0, 50).map((l) => l.id),
      };
    }

    return summary;
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
  rawRequest,
];
