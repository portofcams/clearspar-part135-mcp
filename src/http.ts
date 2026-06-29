#!/usr/bin/env node
/**
 * Clearspar Part 135 MCP — remote HTTP entry (MCP Streamable HTTP transport).
 * --------------------------------------------------------------------------
 * Serves the SAME Part 135 market-analytics tools as the stdio server
 * (src/index.ts) over HTTPS, so the server is reachable as a *remote* MCP
 * connector (and is eligible for the Anthropic Connectors Directory).
 *
 * The tools proxy a key-gated backend (clearspar.binnacleai.com /api/prospects)
 * using a server-side CLEARSPAR_API_KEY, so callers never see the raw key — and
 * the tools return AGGREGATE analytics (market summary, HHI, rankings), not the
 * raw operator export. A per-IP rate limiter caps abuse of the backend.
 *
 * Stateful: a session id is minted on initialize and reused for that client's
 * calls (the lifecycle Claude's connector expects).
 *
 * Endpoints:
 *   POST/GET/DELETE /mcp   MCP Streamable HTTP
 *   GET /healthz           liveness probe
 *   GET /privacy           public privacy policy (Connectors Directory requirement)
 *   GET /                  human-readable info
 */
import express, { type Request, type Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, CLEARSPAR_INFO } from "./index.js";

const PORT = Number(process.env.PORT || 8091);
const HERE = dirname(fileURLToPath(import.meta.url));

// Active sessions keyed by mcp-session-id.
const transports: Record<string, StreamableHTTPServerTransport> = {};

const app = express();
app.set("trust proxy", 1); // behind Nginx Proxy Manager — required for correct per-IP rate limiting
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["mcp-session-id"],
    allowedHeaders: ["content-type", "mcp-session-id", "mcp-protocol-version", "authorization", "last-event-id"],
  })
);

// Rate-limit the MCP endpoint — every tool proxies a key-gated backend, so cap abuse.
app.use(
  "/mcp",
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false })
);

// --- MCP endpoint ---
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = createServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session id (send an initialize request first)." },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("MCP request error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// GET = server->client SSE stream; DELETE = end session. Both need a session id.
async function handleSessionRequest(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// --- Health ---
app.get("/healthz", (_req: Request, res: Response) =>
  res.json({ status: "ok", sessions: Object.keys(transports).length, ...CLEARSPAR_INFO })
);

// --- Privacy policy (Connectors Directory requires a public one) ---
app.get("/privacy", (_req: Request, res: Response) => {
  try {
    const md = readFileSync(join(HERE, "..", "PRIVACY.md"), "utf8");
    res.type("text/markdown").send(md);
  } catch {
    res.status(404).type("text/plain").send("Privacy policy not found.");
  }
});

// --- Info ---
app.get("/", (_req: Request, res: Response) => {
  res
    .type("text/plain")
    .send(
      `${CLEARSPAR_INFO.name} v${CLEARSPAR_INFO.version} — remote MCP server (Streamable HTTP).\n` +
        `MCP endpoint: POST /mcp\nHealth: GET /healthz\nPrivacy: GET /privacy\n` +
        `Part 135 market analytics over ${CLEARSPAR_INFO.dataBase}. Read-only, aggregate.\n`
    );
});

app.listen(PORT, () => {
  console.log(
    `clearspar-part135-mcp (remote) listening on :${PORT} — POST /mcp (backend key ${CLEARSPAR_INFO.keyConfigured ? "set" : "MISSING"})`
  );
});
