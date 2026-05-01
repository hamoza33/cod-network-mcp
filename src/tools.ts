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
    .max(100)
    .optional()
    .describe("Items per page (max 100)."),
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
    "List the seller's orders. Each order includes customer info, status, shipping and delivery dates. Supports filtering, pagination, sorting and includes.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Filter by order status (e.g. `delivered`, `shipped`, `cancelled`)."),
    reference: z.string().optional().describe("Filter by order reference."),
    customer_phone: z.string().optional(),
    customer_country: z.string().optional().describe("Country ISO code 2."),
    created_from: z
      .string()
      .optional()
      .describe("Created at >= this ISO date (YYYY-MM-DD)."),
    created_to: z
      .string()
      .optional()
      .describe("Created at <= this ISO date (YYYY-MM-DD)."),
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
    "List leads (incoming orders before confirmation). Includes customer details, status and source.",
  inputSchema: z.object({
    status: z.string().optional(),
    customer_phone: z.string().optional(),
    customer_country: z.string().optional().describe("Country ISO code 2."),
    created_from: z.string().optional(),
    created_to: z.string().optional(),
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
  description: "List the seller's invoices (remittance / payouts).",
  inputSchema: z.object({
    status: z.string().optional(),
    created_from: z.string().optional(),
    created_to: z.string().optional(),
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
  rawRequest,
];
