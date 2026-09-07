/**
 * Foundry Wiki Bridge proxy.
 *
 * Sits between a Foundry VTT module (running in the GM's browser) and an Outline wiki.
 * Holds the Outline API key server-side, authenticates the module with a separate shared
 * secret, answers CORS for the configured Foundry origins, and converts between the
 * HTML Foundry's editor produces and the markdown Outline speaks.
 *
 * Zero framework: Node's http module, a tiny router, two converters.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { htmlToMarkdown, markdownToHtml } from "./convert.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const config = {
  outlineUrl: required("OUTLINE_URL").replace(/\/+$/, ""),
  /** Browser-facing Outline URL for links; defaults to OUTLINE_URL. */
  outlinePublicUrl: (process.env.OUTLINE_PUBLIC_URL ?? required("OUTLINE_URL")).replace(/\/+$/, ""),
  outlineApiKey: required("OUTLINE_API_KEY"),
  bridgeSecret: required("BRIDGE_SECRET"),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  port: Number(process.env.PORT ?? 3002),
  host: process.env.HOST ?? "0.0.0.0",
};

// ---------------------------------------------------------------------------
// Outline client
// ---------------------------------------------------------------------------

class OutlineError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Seconds Outline asked us to wait, from its Retry-After header (429 only). */
    public retryAfter?: number,
  ) {
    super(message);
  }
}

interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  icon: string | null;
  updatedAt: string;
  revision: number;
  collectionId: string | null;
  parentDocumentId: string | null;
  url: string;
}

/** Optional emoji icon from a request body, or undefined when absent. */
function iconFromBody(body: Record<string, unknown>): string | null | undefined {
  if (body.icon === null) return null;
  return typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : undefined;
}

interface OutlineCollection {
  id: string;
  name: string;
}

async function outline<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.outlineUrl}/api/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.outlineApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    success?: boolean;
    data?: T;
    error?: string;
    message?: string;
    status?: number;
  };
  if (!res.ok || json.ok === false || json.success === false) {
    const ra = Number(res.headers.get("retry-after"));
    throw new OutlineError(
      json.status ?? res.status,
      json.error ?? "outline_error",
      json.message ?? `Outline returned HTTP ${res.status} for ${endpoint}`,
      Number.isFinite(ra) && ra > 0 ? ra : undefined,
    );
  }
  return (json.data ?? json) as T;
}

/**
 * Fetch an attachment's bytes. Outline answers `attachments.redirect` with a signed URL on its
 * public host; that host is swapped for the internal one so the bytes never leave the Docker network.
 */
async function fetchAttachment(id: string): Promise<{ contentType: string; body: Buffer; name?: string }> {
  const first = await fetch(`${config.outlineUrl}/api/attachments.redirect?id=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${config.outlineApiKey}` },
    redirect: "manual",
  });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location") ?? "";
    const target = new URL(location, config.outlineUrl);
    if (target.origin === new URL(config.outlinePublicUrl).origin) {
      const internal = new URL(config.outlineUrl);
      target.protocol = internal.protocol;
      target.host = internal.host;
    }
    res = await fetch(target, { headers: { authorization: `Bearer ${config.outlineApiKey}` } });
  }
  if (!res.ok) throw new OutlineError(res.status === 404 ? 404 : res.status, "attachment_error", `Outline returned HTTP ${res.status} for attachment ${id}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 50 * 1024 * 1024) throw new HttpError(413, "too_large", "Attachment exceeds 50 MB");
  const disposition = res.headers.get("content-disposition") ?? "";
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  return { contentType: res.headers.get("content-type") ?? "application/octet-stream", body, name: name ? decodeURIComponent(name) : undefined };
}

async function listAllDocuments(collectionId: string): Promise<OutlineDocument[]> {
  const out: OutlineDocument[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await outline<OutlineDocument[]>("documents.list", {
      collectionId,
      limit,
      offset,
      sort: "title",
      direction: "ASC",
    });
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Handler = (ctx: {
  req: http.IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
}) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  auth: boolean;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler, opts: { auth?: boolean } = {}) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "/?$",
  );
  routes.push({ method, pattern, keys, handler, auth: opts.auth ?? true });
}

function readBody(req: http.IncomingMessage): () => Promise<Record<string, unknown>> {
  let cached: Promise<Record<string, unknown>> | undefined;
  return () => {
    cached ??= new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 10 * 1024 * 1024) reject(new HttpError(413, "too_large", "Body exceeds 10 MB"));
        chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new HttpError(400, "bad_json", "Body is not valid JSON"));
        }
      });
      req.on("error", reject);
    });
    return cached;
  };
}

function checkSecret(req: http.IncomingMessage): void {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(config.bridgeSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, "unauthorized", "Missing or wrong bridge secret");
  }
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = (req.headers.origin ?? "").replace(/\/+$/, "");
  if (!origin) return true; // not a browser request
  if (!config.allowedOrigins.includes(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-expose-headers", "retry-after, x-attachment-name, content-type");
  res.setHeader("access-control-max-age", "600");
  return true;
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** A handler result that is sent as raw bytes instead of JSON. */
class RawResponse {
  constructor(public body: Buffer, public headers: Record<string, string>) {}
}

// ---------------------------------------------------------------------------
// Document shaping
// ---------------------------------------------------------------------------

function shapeDocument(doc: OutlineDocument, format: string | null) {
  return {
    id: doc.id,
    title: doc.title,
    icon: doc.icon ?? null,
    updatedAt: doc.updatedAt,
    revision: doc.revision,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId,
    url: `${config.outlinePublicUrl}${doc.url}`,
    markdown: doc.text,
    html: format === "html" ? markdownToHtml(doc.text) : undefined,
  };
}

/** The lightweight shape used by list endpoints. */
function shapeListed(d: OutlineDocument) {
  return {
    id: d.id,
    title: d.title,
    icon: d.icon ?? null,
    updatedAt: d.updatedAt,
    revision: d.revision,
    parentDocumentId: d.parentDocumentId,
    hasText: Boolean(d.text && d.text.trim()),
    url: `${config.outlinePublicUrl}${d.url}`,
  };
}

/** Accepts {markdown} or {html} in a request body and returns markdown for Outline. */
function textFromBody(body: Record<string, unknown>): string | undefined {
  if (typeof body.markdown === "string") return body.markdown;
  if (typeof body.html === "string") return htmlToMarkdown(body.html);
  return undefined;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

route("GET", "/health", async () => ({ ok: true, outline: config.outlineUrl, outlinePublicUrl: config.outlinePublicUrl }), { auth: false });

route("POST", "/api/convert", async ({ body }) => {
  const b = await body();
  if (typeof b.html === "string") return { markdown: htmlToMarkdown(b.html) };
  if (typeof b.markdown === "string") return { html: markdownToHtml(b.markdown) };
  throw new HttpError(400, "nothing_to_convert", "Provide html or markdown");
});

route("GET", "/api/collections", async () => {
  const cols = await outline<OutlineCollection[]>("collections.list", { limit: 100 });
  return cols.map((c) => ({ id: c.id, name: c.name }));
});

route("GET", "/api/collections/:id/documents", async ({ params }) => {
  const docs = await listAllDocuments(params.id);
  return docs.map(shapeListed);
});

/**
 * Documents in a collection updated after `since` (ISO timestamp), newest first, capped at `limit`.
 * One Outline call; the module polls this for auto-pull. Trashed documents do not appear.
 */
route("GET", "/api/collections/:id/changes", async ({ params, query }) => {
  const since = query.get("since") ?? "";
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? 50) || 50));
  const page = await outline<OutlineDocument[]>("documents.list", {
    collectionId: params.id,
    limit,
    offset: 0,
    sort: "updatedAt",
    direction: "DESC",
  });
  const docs = page.filter((d) => !since || d.updatedAt > since).map(shapeListed);
  return { since, latest: page[0]?.updatedAt ?? since, truncated: docs.length === limit, docs };
});

/** Raw bytes of an Outline attachment (images pasted into the wiki), for pulling into Foundry. */
route("GET", "/api/attachments/:id", async ({ params }) => {
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(400, "bad_id", "Attachment id must be a UUID");
  const { contentType, body, name } = await fetchAttachment(params.id);
  return new RawResponse(body, {
    "content-type": contentType,
    "content-length": String(body.length),
    "cache-control": "private, max-age=3600",
    ...(name ? { "x-attachment-name": encodeURIComponent(name) } : {}),
  });
});

route("GET", "/api/documents/:id", async ({ params, query }) => {
  const doc = await outline<OutlineDocument>("documents.info", { id: params.id });
  return shapeDocument(doc, query.get("format"));
});

route("PUT", "/api/documents/:id", async ({ params, query, body }) => {
  const b = await body();
  const text = textFromBody(b);
  const title = typeof b.title === "string" ? b.title : undefined;
  const icon = iconFromBody(b);
  if (text === undefined && title === undefined && icon === undefined) {
    throw new HttpError(400, "nothing_to_update", "Provide markdown, html, title, or icon");
  }
  const expected = typeof b.expectedUpdatedAt === "string" ? b.expectedUpdatedAt : undefined;
  if (expected && b.force !== true) {
    const current = await outline<OutlineDocument>("documents.info", { id: params.id });
    if (current.updatedAt !== expected) {
      throw new HttpError(409, "conflict", "Document changed in Outline since last sync", {
        current: { updatedAt: current.updatedAt, revision: current.revision },
      });
    }
  }
  const doc = await outline<OutlineDocument>("documents.update", {
    id: params.id,
    ...(title !== undefined ? { title } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(icon !== undefined ? { icon } : {}),
  });
  return shapeDocument(doc, query.get("format"));
});

/** Moves a document (and its children) to Outline's trash, recoverable there for 30 days. */
route("DELETE", "/api/documents/:id", async ({ params }) => {
  await outline<unknown>("documents.delete", { id: params.id });
  return { ok: true, id: params.id };
});

/**
 * Re-parent a document within its collection. `parentDocumentId: null` (or absent) moves it to the
 * collection root, which Outline expresses as a move with only `collectionId`.
 */
route("POST", "/api/documents/:id/move", async ({ params, query, body }) => {
  const b = await body();
  const parentDocumentId = typeof b.parentDocumentId === "string" && b.parentDocumentId ? b.parentDocumentId : null;
  const collectionId = typeof b.collectionId === "string" && b.collectionId ? b.collectionId : undefined;
  if (!parentDocumentId && !collectionId) throw new HttpError(400, "nothing_to_move", "Provide parentDocumentId or collectionId");
  const res = await outline<{ documents: OutlineDocument[] }>("documents.move", {
    id: params.id,
    ...(parentDocumentId ? { parentDocumentId } : { collectionId }),
  });
  const moved = res.documents?.find((d) => d.id === params.id) ?? (await outline<OutlineDocument>("documents.info", { id: params.id }));
  return shapeDocument(moved, query.get("format"));
});

route("POST", "/api/collections/:id/documents", async ({ params, query, body }) => {
  const b = await body();
  const text = textFromBody(b) ?? "";
  const title = typeof b.title === "string" && b.title.trim() ? b.title : "Untitled";
  const parentDocumentId = typeof b.parentDocumentId === "string" && b.parentDocumentId ? b.parentDocumentId : undefined;
  const icon = iconFromBody(b);
  const doc = await outline<OutlineDocument>("documents.create", {
    collectionId: params.id,
    title,
    text,
    publish: true,
    ...(parentDocumentId ? { parentDocumentId } : {}),
    ...(icon ? { icon } : {}),
  });
  return shapeDocument(doc, query.get("format"));
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  // HEAD is served by the matching GET route; Node omits the body automatically.
  const routeMethod = method === "HEAD" ? "GET" : method;
  let status = 500;
  try {
    const corsOk = applyCors(req, res);
    if (method === "OPTIONS") {
      status = corsOk ? 204 : 403;
      res.writeHead(status);
      res.end();
      return;
    }
    if (!corsOk) throw new HttpError(403, "origin_not_allowed", `Origin not in ALLOWED_ORIGINS`);

    for (const r of routes) {
      if (r.method !== routeMethod) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      if (r.auth) checkSecret(req);
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const result = await r.handler({ req, params, query: url.searchParams, body: readBody(req) });
      status = 200;
      if (result instanceof RawResponse) {
        res.writeHead(status, result.headers);
        res.end(result.body);
      } else {
        send(res, status, result);
      }
      return;
    }
    throw new HttpError(404, "not_found", `No route for ${method} ${url.pathname}`);
  } catch (err) {
    if (err instanceof HttpError) {
      status = err.status;
      send(res, status, { error: err.code, message: err.message, ...err.extra });
    } else if (err instanceof OutlineError) {
      status = err.status >= 400 && err.status < 600 ? err.status : 502;
      if (err.retryAfter) res.setHeader("retry-after", String(err.retryAfter));
      send(res, status, { error: `outline:${err.code}`, message: err.message, retryAfter: err.retryAfter });
    } else {
      status = 500;
      console.error(err);
      send(res, status, { error: "internal", message: "Unexpected proxy error" });
    }
  } finally {
    console.log(`${method} ${url.pathname} ${status} ${Date.now() - started}ms`);
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `wiki-bridge listening on ${config.host}:${config.port}, outline=${config.outlineUrl}, origins=${config.allowedOrigins.join(",") || "(none)"}`,
  );
});
