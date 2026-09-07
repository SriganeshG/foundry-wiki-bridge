import { MODULE_ID, SETTINGS, ITEMS_ICON, ITEMS_TITLE, PULLED_FILES_DIR } from "./constants.mjs";
import { entryLink, linksVersion, urlIdOf } from "./links.mjs";

/*
 * Page content on its way to and from the wiki.
 *
 * To the wiki: Foundry's enricher runs first with secrets off, so GM-only blocks never leave
 * Foundry and @UUID links, inline rolls and system enrichers become anchors. Links to synced
 * entries, pages and item cards get the wiki URL of their counterpart; other links become plain
 * text. Image sources become absolute (Foundry serves world files without a login).
 *
 * From the wiki: links back to synced documents turn into @UUID[...] text, images uploaded to the
 * wiki are copied into the world's data directory, and hotlinks to this Foundry become relative.
 */

const ATTACHMENT_RE = /\/api\/attachments\.redirect\?id=([0-9a-f-]{36})/i;
const MENTION_RE = /^mention:\/\/[^/]+\/document\/([0-9a-f-]{36})/i;

function textEditor() {
  return foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
}

function parse(html) {
  return new DOMParser().parseFromString(html ?? "", "text/html");
}

function esc(s) {
  return foundry.utils.escapeHTML(String(s ?? ""));
}

/** Browser-facing base URL of this Foundry, with a trailing slash. */
export function foundryBase() {
  const custom = (game.settings.get(MODULE_ID, SETTINGS.publicUrl) || "").trim().replace(/\/+$/, "");
  if (custom) return `${custom}/`;
  return `${location.origin}${foundry.utils.getRoute("/")}`;
}

export async function enrich(html, relativeTo) {
  const TE = textEditor();
  let rollData = {};
  try { rollData = relativeTo?.getRollData?.() ?? relativeTo?.parent?.getRollData?.() ?? {}; } catch { rollData = {}; }
  return TE.enrichHTML(html ?? "", { secrets: false, documents: true, links: true, rolls: true, embeds: true, relativeTo, rollData });
}

function stripSecrets(doc) {
  for (const el of doc.querySelectorAll("section.secret")) if (!el.classList.contains("revealed")) el.remove();
}

// ------------------------------------------------------------------ to the wiki

/**
 * Enriched, wiki-ready HTML for a text page.
 * `ctx`: { client, docs, log, createCards } from `makeResolver`.
 */
export async function htmlForWiki(page, ctx) {
  const raw = page.text?.content ?? "";
  let html;
  try {
    html = await enrich(raw, page);
  } catch (err) {
    console.warn(`${MODULE_ID} | enrichHTML failed for "${page.name}": ${err.message}`);
    html = raw;
  }
  const doc = parse(html);
  stripSecrets(doc);
  await rewriteLinksForWiki(doc, ctx);
  rewriteImagesForWiki(doc);
  return doc.body.innerHTML;
}

async function rewriteLinksForWiki(doc, ctx) {
  for (const a of [...doc.querySelectorAll("a[data-uuid]")]) {
    const uuid = a.dataset.uuid;
    const label = (a.textContent ?? "").trim() || uuid;
    let url = null;
    if (ctx?.resolve && !a.classList.contains("broken")) {
      try {
        url = await ctx.resolve(uuid, label);
      } catch (err) {
        ctx.log?.("warn", `Link "${label}": ${err.message}`);
      }
    }
    if (url) {
      a.setAttribute("href", url);
      a.removeAttribute("data-tooltip");
    } else {
      a.replaceWith(doc.createTextNode(label));
    }
  }
}

function rewriteImagesForWiki(doc) {
  const base = foundryBase();
  const pulledDir = `worlds/${game.world.id}/${PULLED_FILES_DIR}/`;
  for (const img of doc.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src") ?? "";
    if (!src || /^(data:|blob:)/i.test(src)) continue;
    // an image that came from the wiki goes back as the wiki's own attachment
    const pulled = src.startsWith(pulledDir) ? /^([0-9a-f-]{36})\./i.exec(src.slice(pulledDir.length)) : null;
    if (pulled) {
      img.setAttribute("src", `/api/attachments.redirect?id=${pulled[1]}`);
      continue;
    }
    if (/^(https?:)?\/\//i.test(src)) continue;
    try {
      img.setAttribute("src", new URL(src, base).href);
    } catch { /* leave odd sources alone */ }
  }
}

// ------------------------------------------------------------------ from the wiki

/**
 * Foundry-ready HTML for a wiki document.
 * `ctx`: { client, log, pullAttachment } from `makePuller`.
 */
export async function htmlFromWiki(html, ctx) {
  const doc = parse(html);
  const reverse = reverseLinks();
  for (const a of [...doc.querySelectorAll("a[href]")]) {
    const href = a.getAttribute("href") ?? "";
    const uuid = reverse.lookup(href);
    if (!uuid) continue;
    const label = (a.textContent ?? "").trim();
    // Outline mentions serialise as "@[Title](mention://...)"; drop the leading @
    const prev = a.previousSibling;
    if (MENTION_RE.test(href) && prev?.nodeType === Node.TEXT_NODE && prev.textContent.endsWith("@")) {
      prev.textContent = prev.textContent.slice(0, -1);
    }
    a.replaceWith(doc.createTextNode(`@UUID[${uuid}]{${label}}`));
  }
  await rewriteImagesFromWiki(doc, ctx);
  return doc.body.innerHTML;
}

async function rewriteImagesFromWiki(doc, ctx) {
  const base = foundryBase();
  for (const img of doc.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src") ?? "";
    const att = ATTACHMENT_RE.exec(src);
    if (att) {
      let path = null;
      try {
        path = await ctx?.pullAttachment?.(att[1]);
      } catch (err) {
        ctx?.log?.("warn", `Image ${att[1]}: ${err.message}`);
      }
      if (path) img.setAttribute("src", path);
      else if (src.startsWith("/")) img.setAttribute("src", `${ctx?.outlinePublicUrl ?? ""}${src}`);
      continue;
    }
    if (src.startsWith(base)) img.setAttribute("src", src.slice(base.length));
  }
}

/** documentId / urlId -> uuid for every synced entry, page and item card. Cached per link table. */
let reverseCache = null;
function reverseLinks() {
  const version = `${linksVersion.n}:${game.journal.size}:${game.settings.get(MODULE_ID, SETTINGS.itemMap)?.length ?? 0}`;
  if (reverseCache?.version === version) return reverseCache;
  const byDoc = new Map();
  const byUrlId = new Map();
  const add = (docId, url, uuid) => {
    if (docId) byDoc.set(docId, uuid);
    const u = urlIdOf(url);
    if (u) byUrlId.set(u, uuid);
  };
  for (const [uuid, m] of Object.entries(itemMap())) add(m.documentId, m.url, uuid);
  for (const entry of game.journal) {
    const l = entryLink(entry);
    if (!l) continue;
    add(l.documentId, l.url, entry.uuid);
    for (const [pid, m] of Object.entries(l.pages)) {
      if (m.documentId === l.documentId) continue; // the body page is the entry itself
      add(m.documentId, m.url, `${entry.uuid}.JournalEntryPage.${pid}`);
    }
  }
  reverseCache = {
    version,
    lookup(href) {
      const mention = MENTION_RE.exec(href);
      if (mention) return byDoc.get(mention[1]) ?? null;
      const full = /\/doc\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(href);
      if (full && byDoc.has(full[1])) return byDoc.get(full[1]);
      const u = urlIdOf(href);
      return u ? byUrlId.get(u) ?? null : null;
    },
  };
  return reverseCache;
}

// ------------------------------------------------------------------ attachments

const MIME_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp",
};

function filePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

/** Copies wiki attachments into `worlds/<world>/wiki-bridge/<attachmentId>.<ext>`, once each. */
export function makePuller(client, { log = () => {}, outlinePublicUrl = "" } = {}) {
  const dir = `worlds/${game.world.id}/${PULLED_FILES_DIR}`;
  let existing = null;
  const listExisting = async () => {
    if (existing) return existing;
    existing = new Set();
    try {
      const res = await filePicker().browse("data", dir);
      for (const f of res.files ?? []) existing.add(decodeURIComponent(f.split("/").pop()));
    } catch { /* directory does not exist yet */ }
    return existing;
  };
  const ensureDir = async () => {
    try { await filePicker().createDirectory("data", dir); } catch { /* exists, or the parent does */ }
  };
  return {
    client,
    log,
    outlinePublicUrl,
    async pullAttachment(id) {
      const files = await listExisting();
      const hit = [...files].find((f) => f.toLowerCase().startsWith(`${id.toLowerCase()}.`));
      if (hit) return `${dir}/${hit}`;
      const { blob, contentType, name } = await client.blob(`/api/attachments/${encodeURIComponent(id)}`);
      const fromName = /\.([a-z0-9]{2,5})$/i.exec(name ?? "")?.[1]?.toLowerCase();
      const ext = MIME_EXT[(contentType ?? "").split(";")[0].trim()] ?? fromName;
      if (!ext) throw new Error(`unsupported type ${contentType}`);
      const file = new File([blob], `${id}.${ext}`, { type: contentType });
      await ensureDir();
      const res = await filePicker().upload("data", dir, file, {}, { notify: false });
      if (!res?.path) throw new Error("upload failed");
      files.add(`${id}.${ext}`);
      log("info", `Copied wiki image into ${res.path}.`);
      return res.path;
    },
  };
}

// ------------------------------------------------------------------ item cards

export function itemMap() {
  try {
    const m = JSON.parse(game.settings.get(MODULE_ID, SETTINGS.itemMap) || "{}");
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

async function saveItemMap(map) {
  await game.settings.set(MODULE_ID, SETTINGS.itemMap, JSON.stringify(map));
  reverseCache = null;
}

/** Drop card mappings whose wiki document is gone, and forget a trashed items root. */
export async function pruneItemMap(docs) {
  const ids = new Set(docs.map((d) => d.id));
  const map = itemMap();
  let changed = false;
  for (const [uuid, m] of Object.entries(map)) {
    if (!ids.has(m.documentId)) { delete map[uuid]; changed = true; }
  }
  if (changed) await saveItemMap(map);
  const rootId = game.settings.get(MODULE_ID, SETTINGS.itemsRootDocId);
  if (rootId && !ids.has(rootId)) await game.settings.set(MODULE_ID, SETTINGS.itemsRootDocId, "");
  if (!game.settings.get(MODULE_ID, SETTINGS.itemsRootDocId)) {
    const found = docs.find((d) => !d.parentDocumentId && d.icon === ITEMS_ICON && d.title === ITEMS_TITLE);
    if (found) await game.settings.set(MODULE_ID, SETTINGS.itemsRootDocId, found.id);
  }
}

export function itemsRootId() {
  return game.settings.get(MODULE_ID, SETTINGS.itemsRootDocId) || null;
}

async function ensureItemsRoot(client, docs) {
  let id = itemsRootId();
  if (id && (!docs || docs.some((d) => d.id === id))) return id;
  const collectionId = game.settings.get(MODULE_ID, SETTINGS.collectionId);
  const doc = await client.create(collectionId, {
    title: ITEMS_TITLE,
    icon: ITEMS_ICON,
    markdown: "Cards for items linked from journal pages. Managed by Foundry Wiki Bridge; hover a link in the wiki to preview one.",
  });
  await game.settings.set(MODULE_ID, SETTINGS.itemsRootDocId, doc.id);
  docs?.push({ id: doc.id, title: doc.title, icon: ITEMS_ICON, updatedAt: doc.updatedAt, parentDocumentId: null, hasText: true, url: doc.url });
  return doc.id;
}

function isGone(err) {
  return err?.status === 404 || err?.status === 403;
}

/**
 * A link resolver for one push: uuid -> wiki URL (or null for plain text).
 * Creates item cards on demand when `createCards` is on.
 */
export function makeResolver(client, docs, { createCards = true, log = () => {} } = {}) {
  const docById = new Map((docs ?? []).map((d) => [d.id, d]));
  const urlOf = (docId, fallback) => docById.get(docId)?.url ?? fallback ?? null;
  const wantCards = createCards && Boolean(game.settings.get(MODULE_ID, SETTINGS.itemCards));
  const ctx = { client, docs, log, created: 0 };

  async function createCard(uuid, item) {
    const collectionId = game.settings.get(MODULE_ID, SETTINGS.collectionId);
    const html = await cardHtml(item, makeResolver(client, docs, { createCards: false, log }));
    const body = { title: item.name, html };
    let doc;
    try {
      doc = await client.create(collectionId, { ...body, parentDocumentId: await ensureItemsRoot(client, docs) });
    } catch (err) {
      if (!isGone(err)) throw err;
      // the items root was trashed since we last looked
      await game.settings.set(MODULE_ID, SETTINGS.itemsRootDocId, "");
      doc = await client.create(collectionId, { ...body, parentDocumentId: await ensureItemsRoot(client, null) });
    }
    const map = itemMap();
    map[uuid] = { documentId: doc.id, url: doc.url, name: item.name };
    await saveItemMap(map);
    docs?.push({ id: doc.id, title: doc.title, icon: null, updatedAt: doc.updatedAt, parentDocumentId: itemsRootId(), hasText: true, url: doc.url });
    ctx.created++;
    log("info", `Created wiki card for "${item.name}".`);
    return doc.url;
  }

  ctx.resolve = async (uuid, label) => {
    let p;
    try { p = foundry.utils.parseUuid(uuid); } catch { return null; }
    if (!p?.type) return null;
    const inWorld = !uuid.startsWith("Compendium.");
    // parseUuid only fills primaryType/primaryId for embedded documents
    const primaryType = p.primaryType ?? p.type;
    const primaryId = p.primaryId ?? p.id;
    // synced journal entries and pages
    if (inWorld && primaryType === "JournalEntry") {
      const entry = game.journal.get(primaryId);
      const l = entry ? entryLink(entry) : null;
      if (!l) return null;
      if (p.type === "JournalEntryPage") {
        const m = l.pages[p.id];
        if (m) return urlOf(m.documentId, m.url);
      }
      return urlOf(l.documentId, l.url);
    }
    // top-level items (world or compendium), never an actor's owned items: those can carry private stat blocks
    if (p.type === "Item" && !p.primaryType) {
      const map = itemMap();
      const hit = map[uuid];
      if (hit && (!docs || docById.has(hit.documentId))) return hit.url;
      if (!wantCards) return null;
      const item = await fromUuid(uuid);
      if (!item) return null;
      return createCard(uuid, item);
    }
    return null;
  };
  return ctx;
}

/** Wiki-ready HTML for an item card: a stat line, the description, source, and picture. */
export async function cardHtml(item, ctx) {
  const parts = [];
  const stats = statLine(item);
  if (stats.length) parts.push(`<p><strong>${esc(stats[0])}</strong>${stats.slice(1).map((s) => ` · ${esc(s)}`).join("")}</p>`);
  const descRaw = item.system?.description?.value ?? (typeof item.system?.description === "string" ? item.system.description : "");
  if (descRaw) {
    let html;
    try { html = await enrich(descRaw, item); } catch { html = descRaw; }
    parts.push(html);
  }
  const source = item.system?.publication?.title || item.system?.source?.value;
  if (source) parts.push(`<p><em>Source: ${esc(source)}</em></p>`);
  if (item.img && !/mystery-man|item-bag\.svg$/.test(item.img)) parts.push(`<p><img src="${esc(item.img)}" alt="${esc(item.name)}"></p>`);
  const doc = parse(parts.join("\n"));
  stripSecrets(doc);
  await rewriteLinksForWiki(doc, ctx);
  rewriteImagesForWiki(doc);
  return doc.body.innerHTML;
}

const titleCase = (s) => String(s ?? "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function actionGlyph(actionType, n) {
  if (actionType === "reaction") return "↺";
  if (actionType === "free") return "◇";
  if (actionType === "action") return "◆".repeat(Math.min(3, Math.max(1, Number(n) || 1)));
  return null;
}

function castTime(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^[123]$/.test(v)) return "◆".repeat(Number(v));
  if (/^reaction$/i.test(v)) return "↺";
  if (/^free$/i.test(v)) return "◇";
  return v;
}

function formatPrice(v) {
  if (!v || typeof v !== "object") return null;
  const parts = [];
  for (const k of ["pp", "gp", "sp", "cp"]) if (Number(v[k])) parts.push(`${v[k]} ${k}`);
  return parts.length ? parts.join(", ") : null;
}

function formatBulk(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 0 && n < 1) return "L";
  return String(n);
}

/** Segments of the stat line; the first is shown bold. PF2e-aware, generic otherwise. */
function statLine(item) {
  const s = item.system ?? {};
  const out = [];
  if (game.system.id !== "pf2e") {
    out.push(titleCase(item.type));
    return out;
  }
  const type = item.type;
  const level = s.level?.value;
  const traits = Array.isArray(s.traits?.value) ? s.traits.value : [];
  const labels = {
    weapon: "Weapon", armor: "Armor", shield: "Shield", equipment: "Item", consumable: "Consumable", treasure: "Treasure",
    backpack: "Container", spell: "Spell", feat: "Feat", action: "Action", condition: "Condition", effect: "Effect",
    ancestry: "Ancestry", heritage: "Heritage", background: "Background", class: "Class", deity: "Deity", kit: "Kit",
    lore: "Lore", melee: "Strike", affliction: "Affliction", campaignFeature: "Campaign feature",
  };
  let typeLabel = labels[type] ?? titleCase(type);
  if (type === "feat" && s.category) typeLabel = `${titleCase(s.category)} feat`;

  if (type === "spell") out.push(traits.includes("cantrip") ? "Cantrip" : `Rank ${level ?? "?"}`);
  else if (level !== undefined && level !== null && !["ancestry", "heritage", "background", "class", "deity"].includes(type)) out.push(`Level ${level}`);
  else out.push(typeLabel);
  if (out[0] !== typeLabel) out.push(typeLabel);

  const glyph = actionGlyph(s.actionType?.value, s.actions?.value);
  if (glyph && ["feat", "action"].includes(type)) out.push(glyph);
  const rarity = s.traits?.rarity;
  if (rarity && rarity !== "common") out.push(titleCase(rarity));
  if (traits.length) out.push(traits.filter((t) => t !== "cantrip").map(titleCase).join(", "));

  if (type === "weapon") {
    const d = s.damage;
    if (d?.dice && d?.die) out.push(`${d.dice}${d.die} ${d.damageType ?? ""}`.trim());
    if (s.range) out.push(`Range ${s.range} ft`);
    if (s.category) out.push(titleCase(s.category));
    if (s.group) out.push(titleCase(s.group));
  } else if (type === "armor") {
    if (s.acBonus != null) out.push(`AC +${s.acBonus}`);
    if (s.dexCap != null) out.push(`Dex cap +${s.dexCap}`);
    if (s.checkPenalty) out.push(`Check ${s.checkPenalty}`);
    if (s.speedPenalty) out.push(`Speed ${s.speedPenalty}`);
    if (s.strength != null) out.push(`Str ${s.strength}`);
    if (s.category) out.push(titleCase(s.category));
  } else if (type === "shield") {
    if (s.acBonus != null) out.push(`AC +${s.acBonus}`);
    if (s.hardness != null) out.push(`Hardness ${s.hardness}`);
    if (s.hp?.max != null) out.push(`HP ${s.hp.max} (BT ${s.hp.brokenThreshold ?? Math.floor(s.hp.max / 2)})`);
  } else if (type === "spell") {
    const traditions = Array.isArray(s.traits?.traditions) ? s.traits.traditions : [];
    if (traditions.length) out.push(`Traditions: ${traditions.map(titleCase).join(", ")}`);
    const cast = castTime(s.time?.value);
    if (cast) out.push(`Cast ${cast}`);
    if (s.range?.value) out.push(`Range ${s.range.value}`);
    if (s.area?.value && s.area?.type) out.push(`Area ${s.area.value}-foot ${s.area.type}`);
    if (s.target?.value) out.push(`Targets ${s.target.value}`);
    if (s.duration?.value) out.push(`Duration ${s.duration.value}`);
    const save = s.defense?.save;
    if (save?.statistic) out.push(`Save ${save.basic ? "basic " : ""}${titleCase(save.statistic)}`);
  } else if (type === "feat") {
    const prereqs = (s.prerequisites?.value ?? []).map((p) => p?.value).filter(Boolean);
    if (prereqs.length) out.push(`Prerequisites: ${prereqs.join(", ")}`);
  }
  const price = formatPrice(s.price?.value);
  if (price) out.push(price);
  const bulk = formatBulk(s.bulk?.value);
  if (bulk) out.push(`Bulk ${bulk}`);
  return out;
}
