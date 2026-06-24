#!/usr/bin/env node
/**
 * Clearspar Part 135 MCP server
 * ------------------------------
 * Turns Claude into a Part 135 market analyst over John's LIVE Clearspar FAA
 * operator dataset (1,890 active US Part 135 charter certificate holders).
 *
 * It wraps the real, key-gated endpoint:
 *   GET https://clearspar.binnacleai.com/api/prospects
 * Response shape: { total: number, rows: Prospect[] }
 *
 * Analyst tools COMPUTE over the data — they don't just list it. They are built
 * only on the dimensions the live data actually populates:
 *   - state     (2-letter USPS, 100% populated, indexed)  -> geography
 *   - fleetSize (FAA tail count, 100% populated, 1..386)  -> size/ranking
 *   - name      (100% populated)                          -> identity/lookup
 *   - crmStatus (NEW|CONTACTED|... ; all NEW today)       -> pipeline filter
 *
 * Deliberately NOT built (data doesn't support it — see README):
 *   geo/proximity (no lat/lng/airport), style segmentation (style 100% NULL),
 *   contact/email tools (email/phone/website ~0.5% populated),
 *   cert-date/aircraft-type tools (no such fields exist).
 *
 * API caveats handled here:
 *   - limit is HARD-CAPPED at 500 server-side -> we paginate by offset to cover
 *     the whole universe and cache rows in-memory for the process lifetime.
 *   - There is NO server-side free-text search -> operator lookup pages + filters
 *     client-side.
 *   - Endpoint is gated by DIGEST_API_KEY (X-API-Key header); 401 without it.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (
  process.env.CLEARSPAR_BASE_URL ?? "https://clearspar.binnacleai.com"
).replace(/\/+$/, "");
const API_KEY = process.env.CLEARSPAR_API_KEY ?? "";

// The route hard-caps `limit` at Math.min(limit, 500). Use the cap as page size.
const PAGE_SIZE = 500;

// USPS 2-letter codes (+ DC and common territories) for input validation, so a
// bad `state` arg yields a useful message instead of a silent empty result.
const VALID_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR","VI","GU","AS","MP",
]);

// ---------------------------------------------------------------------------
// Types — mirrors the real Prospect model (only the fields we rely on are typed
// strictly; the rest are present but sparse in the live data).
// ---------------------------------------------------------------------------

interface Prospect {
  id: string;
  certNo: string;
  name: string;
  state: string | null;
  fleetSize: number | null;
  crmStatus: string;
  city: string | null;
  certType: string;
  status: string;
  [k: string]: unknown;
}

interface ProspectsResponse {
  total: number;
  rows: Prospect[];
}

// ---------------------------------------------------------------------------
// Fetch layer
// ---------------------------------------------------------------------------

class ClearsparError extends Error {}

/** One page of GET /api/prospects with the real query params + auth header. */
async function fetchPage(params: {
  state?: string;
  crmStatus?: string;
  limit: number;
  offset: number;
}): Promise<ProspectsResponse> {
  if (!API_KEY) {
    throw new ClearsparError(
      "CLEARSPAR_API_KEY is not set. The /api/prospects endpoint is key-gated " +
        "(returns 401 without it). Set CLEARSPAR_API_KEY to the DIGEST_API_KEY " +
        "value (see README)."
    );
  }

  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.crmStatus) qs.set("crmStatus", params.crmStatus);
  qs.set("limit", String(params.limit));
  qs.set("offset", String(params.offset));

  const url = `${BASE_URL}/api/prospects?${qs.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-API-Key": API_KEY } });
  } catch (e) {
    throw new ClearsparError(
      `Network error reaching ${BASE_URL}: ${(e as Error).message}`
    );
  }

  if (res.status === 401) {
    throw new ClearsparError(
      "401 unauthorized from /api/prospects — CLEARSPAR_API_KEY is missing or wrong."
    );
  }
  if (!res.ok) {
    throw new ClearsparError(`HTTP ${res.status} from ${url}`);
  }

  const data = (await res.json()) as ProspectsResponse;
  if (typeof data?.total !== "number" || !Array.isArray(data?.rows)) {
    throw new ClearsparError("Unexpected response shape from /api/prospects.");
  }
  return data;
}

/**
 * Fetch ALL matching rows by paging offset until we've collected `total`.
 * Required because the API caps a single page at 500. Guarded against runaway
 * loops. Used by every tool that needs correct aggregates over a filter.
 */
async function fetchAll(filter: { state?: string; crmStatus?: string }): Promise<{
  total: number;
  rows: Prospect[];
}> {
  const first = await fetchPage({ ...filter, limit: PAGE_SIZE, offset: 0 });
  const rows = [...first.rows];
  const total = first.total;

  for (
    let offset = PAGE_SIZE;
    offset < total && rows.length < total;
    offset += PAGE_SIZE
  ) {
    const page = await fetchPage({ ...filter, limit: PAGE_SIZE, offset });
    if (page.rows.length === 0) break; // safety: stop if server returns nothing
    rows.push(...page.rows);
  }
  return { total, rows };
}

// Process-lifetime cache of the full universe (~1,890 rows) for tools that need
// to scan everything (operator lookup, cross-state ranking). The dataset only
// refreshes when John re-runs the FAA scraper, so this is safe for a session.
let universeCache: Prospect[] | null = null;
async function getUniverse(): Promise<Prospect[]> {
  if (universeCache) return universeCache;
  const { rows } = await fetchAll({});
  universeCache = rows;
  return rows;
}

// ---------------------------------------------------------------------------
// Analyst helpers (pure math over the real fields)
// ---------------------------------------------------------------------------

function fleets(rows: Prospect[]): number[] {
  return rows
    .map((r) => r.fleetSize)
    .filter((n): n is number => typeof n === "number" && n >= 0);
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function topByFleet(rows: Prospect[], n: number): Prospect[] {
  return [...rows]
    .sort((a, b) => (b.fleetSize ?? 0) - (a.fleetSize ?? 0))
    .slice(0, n);
}

/** Top-K share of total tails — a simple market-concentration proxy. */
function topKShare(rows: Prospect[], k: number): number {
  const all = fleets(rows);
  const totalTails = sum(all);
  if (totalTails === 0) return 0;
  const topK = sum(fleets(topByFleet(rows, k)));
  return round((topK / totalTails) * 100, 1);
}

/** Herfindahl-Hirschman Index over tail share (0–10000). Higher = more concentrated. */
function hhi(rows: Prospect[]): number {
  const all = fleets(rows);
  const totalTails = sum(all);
  if (totalTails === 0) return 0;
  const h = all.reduce((acc, f) => {
    const share = (f / totalTails) * 100;
    return acc + share * share;
  }, 0);
  return Math.round(h);
}

function fleetBuckets(rows: Prospect[]) {
  const buckets = {
    "1 (single-aircraft)": 0,
    "2-5 (small)": 0,
    "6-10 (mid)": 0,
    "11-25 (large)": 0,
    "26+ (major)": 0,
  };
  for (const f of fleets(rows)) {
    if (f <= 1) buckets["1 (single-aircraft)"]++;
    else if (f <= 5) buckets["2-5 (small)"]++;
    else if (f <= 10) buckets["6-10 (mid)"]++;
    else if (f <= 25) buckets["11-25 (large)"]++;
    else buckets["26+ (major)"]++;
  }
  return buckets;
}

function asLine(p: Prospect): { name: string; state: string | null; fleetSize: number | null; certNo: string; crmStatus: string } {
  return {
    name: p.name,
    state: p.state,
    fleetSize: p.fleetSize,
    certNo: p.certNo,
    crmStatus: p.crmStatus,
  };
}

function normState(s: unknown): string {
  return String(s ?? "").trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function marketSummary(args: { state: string; topN?: number }) {
  const state = normState(args.state);
  if (!VALID_STATES.has(state)) {
    throw new ClearsparError(
      `"${args.state}" is not a valid 2-letter US state code. Use e.g. AK, HI, TX. ` +
        `Geography in this dataset is state-level only.`
    );
  }
  const topN = Math.max(1, Math.min(args.topN ?? 5, 25));
  const { total, rows } = await fetchAll({ state });
  if (total === 0) {
    return {
      state,
      operatorCount: 0,
      message: `No active Part 135 operators on file for ${state}.`,
    };
  }
  const fs = fleets(rows);
  const totalTails = sum(fs);
  return {
    state,
    operatorCount: total,
    totalTails,
    avgFleetSize: round(totalTails / Math.max(fs.length, 1), 1),
    medianFleetSize: median(fs),
    largestOperatorTails: Math.max(...fs),
    top5ShareOfTails_pct: topKShare(rows, 5),
    concentrationHHI: hhi(rows),
    topOperators: topByFleet(rows, topN).map(asLine),
    note:
      "Tails = derived FAA fleetSize (1.0 per active record). Computed live over " +
      `all ${total} active ${state} operators. Contact/email fields omitted (data gap).`,
  };
}

async function fleetRanking(args: { state?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  let rows: Prospect[];
  let scope: string;
  if (args.state) {
    const state = normState(args.state);
    if (!VALID_STATES.has(state)) {
      throw new ClearsparError(
        `"${args.state}" is not a valid 2-letter US state code (e.g. AK, HI, TX).`
      );
    }
    rows = (await fetchAll({ state })).rows;
    scope = state;
  } else {
    rows = await getUniverse(); // whole 1,890-operator universe
    scope = "US (all states)";
  }
  return {
    scope,
    pool: rows.length,
    ranking: topByFleet(rows, limit).map((p, i) => ({ rank: i + 1, ...asLine(p) })),
    note: "Ranked by fleetSize (FAA tail count). Ties broken by source order.",
  };
}

async function compareOperators(args: { names: string[] }) {
  if (!Array.isArray(args.names) || args.names.length < 2) {
    throw new ClearsparError("Provide at least 2 operator names to compare.");
  }
  const universe = await getUniverse();
  const results = args.names.map((query) => {
    const q = query.trim().toLowerCase();
    // exact (case-insensitive) first, then substring — no server search exists.
    const exact = universe.find((p) => p.name.toLowerCase() === q);
    const partial =
      exact ?? universe.find((p) => p.name.toLowerCase().includes(q));
    if (!partial) return { query, matched: false as const };
    return {
      query,
      matched: true as const,
      matchedExactly: !!exact,
      ...asLine(partial),
    };
  });

  const found = results.filter((r) => r.matched) as Array<
    ReturnType<typeof asLine> & { query: string; matched: true; matchedExactly: boolean }
  >;
  let comparison: Record<string, unknown> | undefined;
  if (found.length >= 2) {
    const sorted = [...found].sort((a, b) => (b.fleetSize ?? 0) - (a.fleetSize ?? 0));
    comparison = {
      largestByFleet: sorted[0].name,
      fleetSpread: `${sorted[0].fleetSize} vs ${sorted[sorted.length - 1].fleetSize} tails`,
      states: [...new Set(found.map((f) => f.state))],
      allSameState: new Set(found.map((f) => f.state)).size === 1,
    };
  }
  return {
    operators: results,
    comparison,
    note: "Matched client-side (no server text search). Fields shown are the only reliably-populated ones.",
  };
}

async function competitiveLandscape(args: { state: string }) {
  const state = normState(args.state);
  if (!VALID_STATES.has(state)) {
    throw new ClearsparError(
      `"${args.state}" is not a valid 2-letter US state code (e.g. AK, HI, TX).`
    );
  }
  const { total, rows } = await fetchAll({ state });
  if (total === 0) {
    return { state, operatorCount: 0, message: `No active operators on file for ${state}.` };
  }
  const fs = fleets(rows);
  const totalTails = sum(fs);
  const hhiVal = hhi(rows);
  return {
    state,
    operatorCount: total,
    totalTails,
    avgFleetSize: round(totalTails / Math.max(fs.length, 1), 1),
    fleetDistribution: fleetBuckets(rows),
    concentration: {
      top1Share_pct: topKShare(rows, 1),
      top3Share_pct: topKShare(rows, 3),
      top5Share_pct: topKShare(rows, 5),
      hhi: hhiVal,
      interpretation: hhiInterpretation(hhiVal),
    },
    leaders: topByFleet(rows, 3).map(asLine),
    note: "Concentration computed live over all active operators in this state. Based on state + fleetSize only.",
  };
}

async function crmPipelineSummary(args: { state?: string }) {
  // crmStatus is indexed + filterable; today everything is NEW (no outreach yet),
  // but this reports the live distribution honestly so it stays correct as the
  // pipeline moves.
  const statuses = ["NEW", "CONTACTED", "REPLIED", "DEMO", "CLOSED", "DEAD"];
  const stateArg = args.state ? normState(args.state) : undefined;
  if (stateArg && !VALID_STATES.has(stateArg)) {
    throw new ClearsparError(`"${args.state}" is not a valid 2-letter US state code.`);
  }
  const counts: Record<string, number> = {};
  let grand = 0;
  for (const s of statuses) {
    // total ignores pagination, so a limit:1 probe gets the exact count cheaply.
    const r = await fetchPage({ state: stateArg, crmStatus: s, limit: 1, offset: 0 });
    counts[s] = r.total;
    grand += r.total;
  }
  return {
    scope: stateArg ?? "US (all states)",
    totalActive: grand,
    byCrmStatus: counts,
    note: "Counts pulled live per crmStatus. All-NEW today means no outreach has started yet.",
  };
}

// ---------------------------------------------------------------------------
// small stats helpers used above
// ---------------------------------------------------------------------------

function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2, 1);
}

function hhiInterpretation(h: number): string {
  if (h < 1500) return "competitive / unconcentrated (HHI < 1500)";
  if (h < 2500) return "moderately concentrated (HHI 1500-2500)";
  return "highly concentrated (HHI > 2500)";
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "market_summary",
    description:
      "Analyst summary of a state's Part 135 charter market: operator count, total tails, avg/median fleet, largest operator, top-5 tail share, HHI concentration, and the top operators. Computed live over all operators in the state.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "2-letter US state code, e.g. AK, HI, TX." },
        topN: { type: "number", description: "How many top operators to list (default 5, max 25)." },
      },
      required: ["state"],
    },
  },
  {
    name: "fleet_ranking",
    description:
      "Operators ranked by fleet size (FAA tail count). Optionally scope to one state; otherwise ranks the whole ~1,890-operator US universe.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Optional 2-letter US state code to scope the ranking." },
        limit: { type: "number", description: "How many to return (default 20, max 100)." },
      },
    },
  },
  {
    name: "compare_operators",
    description:
      "Side-by-side comparison of 2+ named operators (state, fleet size, certNo, CRM status), with which is largest and whether they share a state. Names are matched client-side (no server text search).",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Operator names (full or partial), at least 2, e.g. ['Grant Aviation','Bering Air'].",
        },
      },
      required: ["names"],
    },
  },
  {
    name: "competitive_landscape",
    description:
      "Competitive structure of a state's Part 135 market: operator count, fleet-size distribution buckets, top-1/3/5 tail concentration, HHI with plain-English interpretation, and the leaders.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "2-letter US state code, e.g. AK, HI." },
      },
      required: ["state"],
    },
  },
  {
    name: "crm_pipeline_summary",
    description:
      "Live distribution of operators across CRM stages (NEW/CONTACTED/REPLIED/DEMO/CLOSED/DEAD), optionally scoped to a state. Reflects outreach progress in the dataset.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Optional 2-letter US state code to scope the pipeline." },
      },
    },
  },
] as const;

const server = new Server(
  { name: "clearspar-part135-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result: unknown;
    switch (name) {
      case "market_summary":
        result = await marketSummary(args as any);
        break;
      case "fleet_ranking":
        result = await fleetRanking(args as any);
        break;
      case "compare_operators":
        result = await compareOperators(args as any);
        break;
      case "competitive_landscape":
        result = await competitiveLandscape(args as any);
        break;
      case "crm_pipeline_summary":
        result = await crmPipelineSummary(args as any);
        break;
      default:
        throw new ClearsparError(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text", text: `Error in ${name}: ${msg}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP stdio channel.
  console.error(
    `clearspar-part135-mcp running on stdio (base=${BASE_URL}, key=${API_KEY ? "set" : "MISSING"})`
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
