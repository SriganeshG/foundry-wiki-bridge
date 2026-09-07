import { MODULE_ID } from "./constants.mjs";

export class BridgeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Thin fetch wrapper for the wiki-bridge proxy. The Outline key never reaches this code. */
export class ProxyClient {
  constructor(baseUrl, secret) {
    this.baseUrl = (baseUrl ?? "").trim().replace(/\/+$/, "");
    this.secret = (secret ?? "").trim();
  }

  static fromSettings() {
    return new ProxyClient(
      game.settings.get(MODULE_ID, "proxyUrl"),
      game.settings.get(MODULE_ID, "secret"),
    );
  }

  get configured() {
    return Boolean(this.baseUrl && this.secret);
  }

  /** Browser-facing Outline URL, learned from /health. */
  static info = null;

  get outlinePublicUrl() {
    return ProxyClient.info?.outlinePublicUrl ?? "";
  }

  /** Called before sleeping on a rate limit: (seconds, attempt, what). Set by the UI to log it. */
  onWait = null;

  static MAX_RETRIES = 4;

  async #fetch(method, path, body) {
    try {
      return await fetch(this.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.secret}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new BridgeError(0, "network", `Could not reach the proxy at ${this.baseUrl}: ${err.message}`);
    }
  }

  async request(method, path, body, attempt = 0) {
    const res = await this.#fetch(method, path, body);
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < ProxyClient.MAX_RETRIES) {
      // Outline caps some operations (25 document creates per minute); it tells us how long to wait
      const wait = Math.min(90, Math.max(1, Number(json.retryAfter) || 5));
      this.onWait?.(wait, attempt + 1, `${method} ${path}`);
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      return this.request(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      throw new BridgeError(res.status, json.error ?? "http_error", json.message ?? `Proxy returned HTTP ${res.status}`, json);
    }
    return json;
  }

  /** GET raw bytes: { blob, contentType, name }. */
  async blob(path) {
    const res = await this.#fetch("GET", path);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new BridgeError(res.status, json.error ?? "http_error", json.message ?? `Proxy returned HTTP ${res.status}`, json);
    }
    const name = res.headers.get("x-attachment-name");
    return { blob: await res.blob(), contentType: res.headers.get("content-type") ?? "", name: name ? decodeURIComponent(name) : null };
  }

  async health() {
    const info = await this.request("GET", "/health");
    ProxyClient.info = info;
    return info;
  }

  collections() {
    return this.request("GET", "/api/collections");
  }

  documents(collectionId) {
    return this.request("GET", `/api/collections/${encodeURIComponent(collectionId)}/documents`);
  }

  /** Documents updated after `since` (ISO), newest first: { since, latest, truncated, docs }. */
  changes(collectionId, since, limit = 50) {
    const q = new URLSearchParams({ since: since ?? "", limit: String(limit) });
    return this.request("GET", `/api/collections/${encodeURIComponent(collectionId)}/changes?${q}`);
  }

  document(id, format = "markdown") {
    return this.request("GET", `/api/documents/${encodeURIComponent(id)}?format=${format}`);
  }

  update(id, body) {
    return this.request("PUT", `/api/documents/${encodeURIComponent(id)}`, body);
  }

  create(collectionId, body) {
    return this.request("POST", `/api/collections/${encodeURIComponent(collectionId)}/documents`, body);
  }

  /** Re-parent a document: { parentDocumentId | null, collectionId }. */
  move(id, body) {
    return this.request("POST", `/api/documents/${encodeURIComponent(id)}/move`, body);
  }

  /** Moves a document and its children to Outline's trash. */
  remove(id) {
    return this.request("DELETE", `/api/documents/${encodeURIComponent(id)}`);
  }

  /** {html} -> {markdown} or {markdown} -> {html}. */
  convert(body) {
    return this.request("POST", "/api/convert", body);
  }
}
