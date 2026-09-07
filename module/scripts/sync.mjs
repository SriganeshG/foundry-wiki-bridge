import { MODULE_ID, FORMATS, STATUS, SETTINGS, FOLDER_ICON } from "./constants.mjs";
import { entryLink, folderLink, saveEntryLink, saveFolderLink, clearEntryLink } from "./links.mjs";
import { htmlForWiki, htmlFromWiki, makeResolver, makePuller, pruneItemMap, itemsRootId } from "./content.mjs";

export { entryLink, folderLink } from "./links.mjs";

/*
 * Mapping model (v4): one Outline collection per game, mirrored as a three-level tree.
 *
 *   collection root          <->  the selected top-level journal folders (each a 📁 document)
 *   document with 📁 icon    <->  Journal folder            folder flag "link": {documentId, url, parent}
 *   any other document       <->  JournalEntry              entry flag "link": {documentId, url, parent, pages}
 *   child of an entry doc    <->  one text page             link.pages[pageId] = {documentId, url, outlineUpdatedAt, pageModifiedTime}
 *   the entry doc's own text <->  a "body" page, mapped to the entry's documentId, only if it has text
 *   document with 📦 icon    <->  item cards (see content.mjs); never part of the journal tree
 *
 * A wiki document's kind follows from its parent: under the root or a folder it is a folder when
 * it carries the 📁 icon and an entry otherwise; under an entry it is a page. Anything under a
 * page is reported and ignored.
 *
 * Change detection compares the wiki's updatedAt and the page's _stats.modifiedTime against the
 * values recorded at the last sync. Content bytes are never compared, because Outline normalises
 * markdown on the way out. Titles are compared by name. Moves compare each side's parent against
 * the parent recorded at the last sync.
 */

const NONE = Symbol("none"); // "nothing on this side" while walking

export function settings() {
  let roots = [];
  try {
    roots = JSON.parse(game.settings.get(MODULE_ID, SETTINGS.rootFolderIds) || "[]");
  } catch {
    roots = [];
  }
  return {
    collectionId: game.settings.get(MODULE_ID, SETTINGS.collectionId) || null,
    rootFolderIds: Array.isArray(roots) ? roots : [],
    looseEntries: Boolean(game.settings.get(MODULE_ID, SETTINGS.looseEntries)),
  };
}

/** The selected top-level journal folders, each mirrored as a 📁 document at the collection root. */
export function selectedRoots() {
  return settings().rootFolderIds.map((id) => game.folders.get(id)).filter((f) => f?.type === "JournalEntry");
}

export async function setRoots(ids) {
  await game.settings.set(MODULE_ID, SETTINGS.rootFolderIds, JSON.stringify([...new Set(ids)]));
}

async function addRoot(folderId) {
  const ids = settings().rootFolderIds;
  if (!ids.includes(folderId)) await setRoots([...ids, folderId]);
}

// ------------------------------------------------------------------ helpers

/** Outline answers 404 for unknown documents and 403 for trashed ones; both mean "recreate". */
function isGone(err) {
  return err?.status === 404 || err?.status === 403;
}

function folderForDoc(docId) {
  return game.folders.find((f) => f.type === "JournalEntry" && folderLink(f)?.documentId === docId) ?? null;
}

function entryForDoc(docId) {
  return game.journal.find((e) => entryLink(e)?.documentId === docId) ?? null;
}

export function textPages(entry) {
  return [...entry.pages.contents].filter((p) => p.type === "text").sort((a, b) => a.sort - b.sort);
}

function sortedPages(entry) {
  return [...entry.pages.contents].sort((a, b) => a.sort - b.sort);
}

const byName = (a, b) => a.name.localeCompare(b.name);
const byTitle = (a, b) => a.title.localeCompare(b.title);

function foldersIn(parent) {
  if (parent === NONE) return [];
  const pid = parent?.id ?? null;
  return game.folders.filter((f) => f.type === "JournalEntry" && (f.folder?.id ?? null) === pid).sort(byName);
}

function entriesIn(parent) {
  if (parent === NONE) return [];
  const pid = parent?.id ?? null;
  return game.journal.filter((e) => (e.folder?.id ?? null) === pid).sort(byName);
}

/** Is this entry or folder inside the selected folders (or a loose entry while those sync)? */
export function inScope(x) {
  const isFolder = x instanceof Folder;
  const f = isFolder ? x : x.folder;
  if (!f) return isFolder ? false : settings().looseEntries;
  let top = f;
  while (top.folder) top = top.folder;
  return settings().rootFolderIds.includes(top.id);
}

/**
 * The wiki parent an entry or folder should have, judging by where it sits in Foundry:
 * null at the journal root, a document id under a mapped folder, undefined when the folder it
 * sits in has no wiki counterpart yet.
 */
export function foundryParentDocId(x) {
  const f = x.folder;
  if (!f) return null;
  return folderLink(f)?.documentId;
}

/**
 * Which side moved an entry/folder since the last sync: null, "foundry", "wiki" or "both".
 * Links written before moves were tracked have no recorded parent; then a difference between the
 * two sides cannot be attributed and counts as "both".
 */
function movement(x, link, doc) {
  const wikiParent = doc.parentDocumentId ?? null;
  const expected = foundryParentDocId(x);
  if (expected === undefined) return null; // its Foundry folder is not in the wiki yet
  if (!("parent" in link)) return expected === wikiParent ? null : "both";
  const foundryMoved = expected !== link.parent;
  const wikiMoved = wikiParent !== link.parent;
  if (foundryMoved && wikiMoved) return expected === wikiParent ? null : "both";
  if (foundryMoved) return "foundry";
  if (wikiMoved) return "wiki";
  return null;
}

function bodyFor(page, ctx) {
  if (page.text?.format === FORMATS.MARKDOWN) return Promise.resolve({ markdown: page.text.markdown ?? "" });
  return htmlForWiki(page, ctx).then((html) => ({ html }));
}

function pageMapping(page, doc) {
  return { documentId: doc.id, url: doc.url, outlineUpdatedAt: doc.updatedAt, pageModifiedTime: page._stats?.modifiedTime ?? null };
}

function pushCtx(client, docs, log) {
  return makeResolver(client, docs, { createCards: true, log });
}

function pullCtx(client, log) {
  return makePuller(client, { log, outlinePublicUrl: client.outlinePublicUrl ?? "" });
}

// ------------------------------------------------------------------ status table

function decorate(row) {
  const s = STATUS[row.status];
  row.statusLabel = s.label;
  row.canPull = s.pull;
  row.canPush = s.push;
  if (row.moved) {
    row.statusLabel += row.moved === "both" ? " · moved on both sides" : row.moved === "foundry" ? " · moved in Foundry" : " · moved in wiki";
    row.canPull = true;
    row.canPush = true;
  }
  row.indentPx = row.depth * 18;
  row.isFolder = row.kind === "folder";
  row.isEntry = row.kind === "entry";
  row.canDeleteWiki = Boolean(s.deleteWiki) && typeof row.docId === "string";
  row.canDeleteFoundry = Boolean(s.deleteFoundry) && Boolean(row.folderId || row.entryId || row.pageId);
  return row;
}

function pageStatus(page, mapping, doc) {
  if (!mapping) return "foundry-only";
  if (!doc) return "wiki-missing";
  const wikiChanged = doc.updatedAt !== mapping.outlineUpdatedAt;
  const foundryChanged = page._stats?.modifiedTime !== mapping.pageModifiedTime;
  if (wikiChanged && foundryChanged) return "conflict";
  if (wikiChanged) return "wiki-changed";
  if (foundryChanged) return "foundry-changed";
  return "in-sync";
}

function aggregate(statuses) {
  const live = statuses.filter((s) => s !== "skipped" && s !== "too-deep");
  if (live.includes("conflict")) return "conflict";
  const changed = new Set(live.filter((s) => s !== "in-sync"));
  if (changed.size === 0) return "in-sync";
  if (changed.size === 1) return [...changed][0];
  return "mixed";
}

/** Walk wiki and Foundry side by side from the root and emit a flat, parent-first row list. */
export function computeRows(docs) {
  const itemsRoot = itemsRootId();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const kids = new Map();
  for (const d of docs) {
    const k = d.parentDocumentId ?? null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(d);
  }
  const childrenOf = (id) => (id === NONE ? [] : [...(kids.get(id) ?? [])].sort(byTitle));
  const folderByDoc = new Map();
  for (const f of game.folders) if (f.type === "JournalEntry") { const l = folderLink(f); if (l) folderByDoc.set(l.documentId, f); }
  const entryByDoc = new Map();
  for (const e of game.journal) { const l = entryLink(e); if (l) entryByDoc.set(l.documentId, e); }

  const rows = [];
  const used = new Set();
  const add = (row, depth, parent) => {
    row.depth = depth;
    row.parentKey = parent?.key ?? null;
    row.ancestors = parent ? [...parent.ancestors, parent.key] : [];
    rows.push(decorate(row));
    return row;
  };

  /** Page rows for a wiki entry document that has no Foundry counterpart. */
  const wikiPageRows = (doc, entryKey) => {
    const out = [];
    if (doc.hasText) out.push({ kind: "page", key: `${entryKey}:body`, title: `${doc.title} (body)`, status: "wiki-only", docId: doc.id });
    for (const c of childrenOf(doc.id)) {
      out.push({ kind: "page", key: `${entryKey}:${c.id}`, title: c.title, status: "wiki-only", docId: c.id, url: c.url });
      for (const g of childrenOf(c.id)) out.push({ kind: "page", key: `${entryKey}:${g.id}`, title: g.title, status: "too-deep", docId: g.id, url: g.url });
    }
    return out;
  };

  const emitEntry = (entry, doc, depth, parent) => {
    const link = entryLink(entry);
    const key = `e:${entry.id}`;
    if (doc && !inScope(entry)) {
      // mapped, but dragged out of the synced folders in Foundry: never sync it again, offer the trash
      add({ kind: "entry", key, title: entry.name, status: "out-of-scope", docId: doc.id, entryId: entry.id, url: doc.url, pageCount: textPages(entry).length }, depth, parent);
      return;
    }
    const pageRows = [];
    const mapped = new Set();
    for (const page of sortedPages(entry)) {
      if (page.type !== "text") {
        pageRows.push({ kind: "page", key: `${key}:${page.id}`, title: page.name, status: "skipped", pageId: page.id, entryId: entry.id });
        continue;
      }
      const m = link?.pages?.[page.id];
      const d = m ? byId.get(m.documentId) : null;
      if (m) mapped.add(m.documentId);
      const status = doc ? pageStatus(page, m, d) : (link ? "wiki-missing" : "foundry-only");
      pageRows.push({ kind: "page", key: `${key}:${page.id}`, title: page.name, status, pageId: page.id, docId: m?.documentId, entryId: entry.id, url: d?.url });
    }
    if (doc) {
      // mappings whose Foundry page is gone: the page was deleted here, the wiki copy remains
      for (const [pageId, m] of Object.entries(link?.pages ?? {})) {
        if (entry.pages.get(pageId) || !byId.has(m.documentId) || mapped.has(m.documentId)) continue;
        mapped.add(m.documentId);
        const d = byId.get(m.documentId);
        pageRows.push({ kind: "page", key: `${key}:${m.documentId}`, title: d.id === doc.id ? `${d.title} (body)` : d.title, status: "foundry-deleted", docId: d.id, mappedPageId: pageId, entryId: entry.id, url: d.url });
      }
      if (doc.hasText && !mapped.has(doc.id)) pageRows.push({ kind: "page", key: `${key}:body`, title: `${doc.title} (body)`, status: "wiki-only", docId: doc.id, entryId: entry.id });
      for (const c of childrenOf(doc.id)) {
        if (!mapped.has(c.id)) pageRows.push({ kind: "page", key: `${key}:${c.id}`, title: c.title, status: "wiki-only", docId: c.id, entryId: entry.id, url: c.url });
        for (const g of childrenOf(c.id)) pageRows.push({ kind: "page", key: `${key}:${g.id}`, title: g.title, status: "too-deep", docId: g.id, entryId: entry.id, url: g.url });
      }
    }
    let status;
    if (!doc) status = link ? "wiki-missing" : "foundry-only";
    else {
      status = aggregate(pageRows.map((r) => r.status));
      if (status === "in-sync" && entry.name !== doc.title) status = "title-differs";
    }
    const moved = doc && link ? movement(entry, link, doc) : null;
    const row = add({ kind: "entry", key, title: entry.name, status, moved, docId: doc?.id ?? link?.documentId, entryId: entry.id, url: doc?.url, pageCount: textPages(entry).length }, depth, parent);
    for (const pr of pageRows) add(pr, depth + 1, row);
  };

  const emitWikiOnlyEntry = (doc, depth, parent) => {
    const key = `d:${doc.id}`;
    const row = add({ kind: "entry", key, title: doc.title, status: "wiki-only", docId: doc.id, url: doc.url, pageCount: childrenOf(doc.id).length + (doc.hasText ? 1 : 0) }, depth, parent);
    for (const pr of wikiPageRows(doc, key)) add(pr, depth + 1, row);
  };

  const emitMappedFolder = (folder, doc, depth, parent) => {
    used.add(folder.id);
    if (!inScope(folder)) {
      add({ kind: "folder", key: `f:${folder.id}`, title: folder.name, status: "out-of-scope", docId: doc.id, folderId: folder.id, url: doc.url }, depth, parent);
      return;
    }
    const moved = movement(folder, folderLink(folder), doc);
    const row = add({ kind: "folder", key: `f:${folder.id}`, title: folder.name, status: folder.name === doc.title ? "in-sync" : "title-differs", moved, docId: doc.id, folderId: folder.id, url: doc.url }, depth, parent);
    walk(doc.id, folder, depth + 1, row);
  };

  const walk = (parentDocId, parentFolder, depth, parent) => {
    for (const doc of childrenOf(parentDocId)) {
      const folder = folderByDoc.get(doc.id);
      const entry = entryByDoc.get(doc.id);
      if (folder) {
        emitMappedFolder(folder, doc, depth, parent);
      } else if (entry) {
        used.add(entry.id);
        emitEntry(entry, doc, depth, parent);
      } else if (doc.icon === FOLDER_ICON) {
        const row = add({ kind: "folder", key: `d:${doc.id}`, title: doc.title, status: "wiki-only", docId: doc.id, url: doc.url }, depth, parent);
        walk(doc.id, NONE, depth + 1, row);
      } else {
        emitWikiOnlyEntry(doc, depth, parent);
      }
    }
    for (const folder of foldersIn(parentFolder)) {
      if (used.has(folder.id)) continue;
      used.add(folder.id);
      const l = folderLink(folder);
      const row = add({ kind: "folder", key: `f:${folder.id}`, title: folder.name, status: l ? "wiki-missing" : "foundry-only", folderId: folder.id, docId: l?.documentId }, depth, parent);
      walk(NONE, folder, depth + 1, row);
    }
    for (const entry of entriesIn(parentFolder)) {
      if (used.has(entry.id)) continue;
      used.add(entry.id);
      emitEntry(entry, null, depth, parent);
    }
  };

  // Root level: only the selected top-level folders take part. Each is a 📁 document at the
  // collection root. Anything else at the root is listed as excluded and never touched.
  const { looseEntries } = settings();
  const roots = selectedRoots();
  const rootIds = new Set(roots.map((f) => f.id));
  for (const doc of childrenOf(null)) {
    if (doc.id === itemsRoot) continue; // item cards live here; not part of the journal tree
    const folder = folderByDoc.get(doc.id);
    const entry = entryByDoc.get(doc.id);
    if (folder) {
      used.add(folder.id);
      if (!rootIds.has(folder.id)) {
        add({ kind: "folder", key: `x:${doc.id}`, title: doc.title, status: "excluded", docId: doc.id, url: doc.url }, 0, null);
        continue;
      }
      emitMappedFolder(folder, doc, 0, null);
    } else if (entry) {
      used.add(entry.id);
      if (looseEntries) emitEntry(entry, doc, 0, null);
      else add({ kind: "entry", key: `x:${doc.id}`, title: doc.title, status: "excluded", docId: doc.id, url: doc.url }, 0, null);
    } else if (doc.icon === FOLDER_ICON) {
      const row = add({ kind: "folder", key: `d:${doc.id}`, title: doc.title, status: "wiki-only", docId: doc.id, url: doc.url }, 0, null);
      walk(doc.id, NONE, 1, row);
    } else if (looseEntries) {
      emitWikiOnlyEntry(doc, 0, null);
    } else {
      add({ kind: "entry", key: `x:${doc.id}`, title: doc.title, status: "excluded", docId: doc.id, url: doc.url }, 0, null);
    }
  }
  for (const folder of roots) {
    if (used.has(folder.id)) continue;
    used.add(folder.id);
    const l = folderLink(folder);
    const row = add({ kind: "folder", key: `f:${folder.id}`, title: folder.name, status: l ? "wiki-missing" : "foundry-only", folderId: folder.id, docId: l?.documentId }, 0, null);
    walk(NONE, folder, 1, row);
  }
  if (looseEntries) {
    for (const entry of entriesIn(null)) {
      if (used.has(entry.id)) continue;
      used.add(entry.id);
      emitEntry(entry, null, 0, null);
    }
  }
  return rows;
}

/**
 * Housekeeping before a table refresh: forget item cards whose document is gone, and fill in
 * `url` / `parent` on links written by earlier versions (parent only when both sides agree, so
 * move detection starts from a known state).
 */
export async function reconcileLinks(docs) {
  await pruneItemMap(docs);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const base = `flags.${MODULE_ID}.link`;
  const entryUpdates = [];
  for (const entry of game.journal) {
    const l = entryLink(entry);
    const doc = l ? byId.get(l.documentId) : null;
    if (!doc) continue;
    const u = {};
    if (!l.url) u[`${base}.url`] = doc.url;
    if (!("parent" in l)) {
      const expected = foundryParentDocId(entry);
      if (expected !== undefined && expected === (doc.parentDocumentId ?? null)) u[`${base}.parent`] = expected;
    }
    for (const [pid, m] of Object.entries(l.pages)) {
      const d = byId.get(m.documentId);
      if (d && !m.url) u[`${base}.pages.${pid}.url`] = d.url;
    }
    if (Object.keys(u).length) entryUpdates.push({ _id: entry.id, ...u });
  }
  const folderUpdates = [];
  for (const folder of game.folders) {
    if (folder.type !== "JournalEntry") continue;
    const l = folderLink(folder);
    const doc = l ? byId.get(l.documentId) : null;
    if (!doc) continue;
    const u = {};
    if (!l.url) u[`${base}.url`] = doc.url;
    if (!("parent" in l)) {
      const expected = foundryParentDocId(folder);
      if (expected !== undefined && expected === (doc.parentDocumentId ?? null)) u[`${base}.parent`] = expected;
    }
    if (Object.keys(u).length) folderUpdates.push({ _id: folder.id, ...u });
  }
  for (let i = 0; i < entryUpdates.length; i += 200) await JournalEntry.updateDocuments(entryUpdates.slice(i, i + 200), { fwbSync: true });
  for (let i = 0; i < folderUpdates.length; i += 200) await Folder.updateDocuments(folderUpdates.slice(i, i + 200), { fwbSync: true });
  return entryUpdates.length + folderUpdates.length;
}

// ------------------------------------------------------------------ parents

function parentRow(rows, row) {
  return row.parentKey ? rows.find((r) => r.key === row.parentKey) ?? null : null;
}

/** The Foundry folder a folder/entry row belongs in, creating wiki-only ancestors on the way. */
async function ensureFoundryParent(client, rows, row, docs) {
  const p = parentRow(rows, row);
  if (!p) return null; // the journal's own root
  if (p.folderId) return game.folders.get(p.folderId) ?? null;
  return folderForDoc(p.docId) ?? pullFolder(client, rows, p, docs);
}

/** The wiki document a folder/entry row belongs under, creating foundry-only ancestors on the way. */
async function ensureWikiParent(client, rows, row) {
  const p = parentRow(rows, row);
  if (!p) return null;
  if (typeof p.docId === "string" && p.status !== "wiki-missing") return p.docId;
  const folder = p.folderId ? game.folders.get(p.folderId) : null;
  if (!folder) throw new Error(`Cannot resolve the wiki parent of "${row.title}"`);
  return (await pushFolder(client, rows, p)).id;
}

// ------------------------------------------------------------------ moves

/** Make the wiki parent match Foundry's. Returns true when a move happened. */
export async function alignWikiParent(client, x, link, doc) {
  const expected = foundryParentDocId(x);
  if (expected === undefined) return false; // the Foundry folder has no wiki document yet
  const current = doc?.parentDocumentId ?? null;
  let moved = false;
  if (doc && current !== expected) {
    await client.move(link.documentId, { parentDocumentId: expected, collectionId: settings().collectionId });
    doc.parentDocumentId = expected;
    moved = true;
  }
  if (!("parent" in link) || link.parent !== expected) {
    link.parent = expected;
    await (x instanceof Folder ? saveFolderLink(x, link) : saveEntryLink(x, link));
  }
  return moved;
}

/** Make the Foundry folder match the wiki's parent. Returns true when a move happened. */
export async function alignFoundryParent(x, link, doc) {
  const wikiParent = doc.parentDocumentId ?? null;
  const target = wikiParent ? folderForDoc(wikiParent) : null;
  if (wikiParent && !target) throw new Error(`"${x.name}" moved under a wiki document that is not a journal folder here yet. Pull that folder first.`);
  let moved = false;
  if ((x.folder?.id ?? null) !== (target?.id ?? null)) {
    await x.update({ folder: target?.id ?? null }, { fwbSync: true });
    moved = true;
  }
  if (!("parent" in link) || link.parent !== wikiParent) {
    link.parent = wikiParent;
    await (x instanceof Folder ? saveFolderLink(x, link) : saveEntryLink(x, link));
  }
  return moved;
}

async function syncMove(client, row, docs, log) {
  const x = row.kind === "folder" ? game.folders.get(row.folderId) : game.journal.get(row.entryId);
  const link = row.kind === "folder" ? folderLink(x) : entryLink(x);
  const doc = docs.find((d) => d.id === row.docId);
  if (!x || !link || !doc) return;
  if (row.moved === "foundry") {
    if (await alignWikiParent(client, x, link, doc)) log("info", `Moved "${row.title}" in the wiki to follow Foundry.`);
  } else if (row.moved === "wiki") {
    if (await alignFoundryParent(x, link, doc)) log("info", `Moved "${row.title}" in Foundry to follow the wiki.`);
    if (x instanceof Folder && !x.folder) await addRoot(x.id);
  }
}

// ------------------------------------------------------------------ folders

export async function pullFolder(client, rows, row, docs) {
  const doc = docs.find((d) => d.id === row.docId);
  if (!doc) throw new Error(`"${row.title}" is no longer in the wiki`);
  const parent = await ensureFoundryParent(client, rows, row, docs);
  let folder = row.folderId ? game.folders.get(row.folderId) : folderForDoc(doc.id);
  if (folder) {
    if (folder.name !== doc.title) await folder.update({ name: doc.title }, { fwbSync: true });
    const link = folderLink(folder) ?? { documentId: doc.id };
    await alignFoundryParent(folder, { ...link, url: doc.url }, doc);
    if (!folder.folder) await addRoot(folder.id); // now top-level: keep it in the selection
    return folder;
  }
  folder = await Folder.create({
    name: doc.title,
    type: "JournalEntry",
    folder: parent?.id ?? null,
    flags: { [MODULE_ID]: { link: { documentId: doc.id, url: doc.url, parent: doc.parentDocumentId ?? null } } },
  }, { fwbSync: true });
  row.folderId = folder.id;
  // a wiki-first folder pulled to the journal root joins the selected roots, or it would vanish
  // from the table on the next refresh
  if (!parent) await addRoot(folder.id);
  return folder;
}

export async function pushFolder(client, rows, row, docs = []) {
  const folder = game.folders.get(row.folderId);
  if (!folder) throw new Error(`Folder "${row.title}" not found`);
  const parentDocId = await ensureWikiParent(client, rows, row);
  const l = folderLink(folder);
  let doc = null;
  if (l) {
    try {
      doc = await client.update(l.documentId, { title: folder.name, icon: FOLDER_ICON, force: true });
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
  if (!doc) {
    doc = await client.create(settings().collectionId, { title: folder.name, markdown: "", icon: FOLDER_ICON, parentDocumentId: parentDocId ?? undefined });
    docs.push({ id: doc.id, title: doc.title, icon: FOLDER_ICON, updatedAt: doc.updatedAt, parentDocumentId: parentDocId ?? null, hasText: false, url: doc.url });
  }
  const link = { documentId: doc.id, url: doc.url };
  await saveFolderLink(folder, link);
  await alignWikiParent(client, folder, link, docs.find((d) => d.id === doc.id) ?? doc);
  row.docId = doc.id;
  return doc;
}

// ------------------------------------------------------------------ entries

function entryRowOf(rows, row) {
  return row.kind === "entry" ? row : parentRow(rows, row);
}

/** Make sure the entry's own wiki document exists. Returns the link. */
async function ensureEntryDoc(client, rows, entryRow, docs) {
  const entry = game.journal.get(entryRow.entryId);
  const link = entryLink(entry);
  if (link && docs.some((d) => d.id === link.documentId)) return link;
  // the entry's document is gone (trashed or deleted): recreate it and forget the old page mappings,
  // since child documents were trashed with it
  const parentDocId = await ensureWikiParent(client, rows, entryRow);
  const doc = await client.create(settings().collectionId, { title: entry.name, markdown: "", parentDocumentId: parentDocId ?? undefined });
  const fresh = { documentId: doc.id, url: doc.url, parent: parentDocId ?? null, pages: {} };
  await saveEntryLink(entry, fresh);
  fresh.justCreated = true; // never persisted
  entryRow.docId = doc.id;
  docs.push({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt, parentDocumentId: parentDocId ?? null, hasText: false, icon: null, url: doc.url });
  return fresh;
}

/** Make sure the entry exists in Foundry. Returns it. */
async function ensureEntry(client, rows, entryRow, docs) {
  if (entryRow.entryId) return game.journal.get(entryRow.entryId);
  const doc = docs.find((d) => d.id === entryRow.docId);
  if (!doc) throw new Error(`"${entryRow.title}" is no longer in the wiki`);
  const parent = await ensureFoundryParent(client, rows, entryRow, docs);
  const entry = await JournalEntry.create({ name: doc.title, folder: parent?.id ?? null }, { fwbSync: true });
  await saveEntryLink(entry, { documentId: doc.id, url: doc.url, parent: doc.parentDocumentId ?? null, pages: {} });
  entryRow.entryId = entry.id;
  return entry;
}

/** Push one page to the wiki given its entry's link. Shared by the table and by auto-push. */
async function pushPageCore(client, entry, link, page, { force = false, docs = [], log = () => {} } = {}) {
  const m = link.pages[page.id];
  const isBody = Boolean(m?.documentId) && m.documentId === link.documentId;
  const body = { ...(await bodyFor(page, pushCtx(client, docs, log))), title: isBody ? entry.name : page.name };
  let doc = null;
  if (m?.documentId) {
    try {
      doc = await client.update(m.documentId, { ...body, expectedUpdatedAt: m.outlineUpdatedAt ?? undefined, force });
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
  if (!doc) doc = await client.create(settings().collectionId, { ...body, parentDocumentId: link.documentId });
  link.pages[page.id] = pageMapping(page, doc);
  await saveEntryLink(entry, link);
  return doc;
}

export async function pushPage(client, rows, row, docs, { force = false, log = () => {} } = {}) {
  const entryRow = entryRowOf(rows, row);
  const entry = game.journal.get(entryRow.entryId);
  const page = entry?.pages.get(row.pageId);
  if (!page) throw new Error(`Page "${row.title}" not found`);
  if (page.type !== "text") throw new Error(`"${page.name}" is not a text page`);
  const link = await ensureEntryDoc(client, rows, entryRow, docs);
  const doc = await pushPageCore(client, entry, link, page, { force, docs, log });
  row.docId = doc.id;
  return doc;
}

export async function pushEntry(client, rows, row, docs, { force = false, log = () => {} } = {}) {
  const entry = game.journal.get(row.entryId);
  if (!entry) throw new Error(`Entry "${row.title}" not found`);
  let link = await ensureEntryDoc(client, rows, row, docs);
  try {
    // a document created a moment ago already carries the title; skip the extra call
    if (!link.justCreated) await client.update(link.documentId, { title: entry.name, force: true });
  } catch (err) {
    if (!isGone(err)) throw err;
    // trashed between refresh and now: recreate and retry once
    await clearEntryLink(entry);
    docs.splice(0, docs.length, ...docs.filter((d) => d.id !== link.documentId));
    link = await ensureEntryDoc(client, rows, row, docs);
    await client.update(link.documentId, { title: entry.name, force: true });
  }
  const doc = docs.find((d) => d.id === link.documentId);
  if (doc) {
    doc.title = entry.name;
    if (await alignWikiParent(client, entry, link, doc)) log("info", `Moved "${entry.name}" in the wiki to follow Foundry.`);
  }
  const out = { entry, pushed: 0, skipped: 0 };
  for (const page of sortedPages(entry)) {
    if (page.type !== "text") { out.skipped++; continue; }
    await pushPageCore(client, entry, link, page, { force, docs, log });
    out.pushed++;
  }
  return out;
}

/** Pull one wiki document into a page of `entry` (creating the page when `page` is null). */
async function pullPageCore(client, entry, link, page, docId, { log = () => {}, fallbackTitle = "" } = {}) {
  // Pages land as HTML (Foundry's default editor format); only pages the GM keeps in markdown
  // format receive markdown. Markdown pages can't show underline or highlight.
  const wantMarkdown = Boolean(page && page.text?.format === FORMATS.MARKDOWN);
  const doc = await client.document(docId, wantMarkdown ? "markdown" : "html");
  const name = doc.title || fallbackTitle || "Untitled";
  const html = wantMarkdown ? null : await htmlFromWiki(doc.html, pullCtx(client, log));
  if (page) {
    await page.update(wantMarkdown
      ? { name, "text.markdown": doc.markdown, "text.format": FORMATS.MARKDOWN }
      : { name, "text.content": html, "text.format": FORMATS.HTML }, { fwbSync: true });
  } else {
    [page] = await entry.createEmbeddedDocuments("JournalEntryPage", [
      { name, type: "text", text: { format: FORMATS.HTML, content: html } },
    ], { fwbSync: true });
  }
  link.pages[page.id] = pageMapping(page, doc);
  await saveEntryLink(entry, link);
  return { doc, page };
}

export async function pullPage(client, rows, row, docs, { log = () => {} } = {}) {
  const entryRow = entryRowOf(rows, row);
  const entry = await ensureEntry(client, rows, entryRow, docs);
  const link = entryLink(entry) ?? { documentId: entryRow.docId, pages: {} };
  let page = row.pageId ? entry.pages.get(row.pageId) : null;
  if (!page) {
    const hit = Object.entries(link.pages).find(([, m]) => m.documentId === row.docId);
    if (hit) page = entry.pages.get(hit[0]) ?? null;
  }
  if (!page) {
    const mappedIds = new Set(Object.keys(link.pages));
    page = textPages(entry).find((p) => !mappedIds.has(p.id) && p.name === row.title) ?? null;
  }
  const { doc, page: written } = await pullPageCore(client, entry, link, page, row.docId, { log, fallbackTitle: row.title });
  row.pageId = written.id;
  return doc;
}

export async function pullEntry(client, rows, row, docs, { log = () => {} } = {}) {
  const entry = await ensureEntry(client, rows, row, docs);
  const doc = docs.find((d) => d.id === row.docId);
  if (!doc) throw new Error(`"${row.title}" is no longer in the wiki`);
  if (entry.name !== doc.title) await entry.update({ name: doc.title }, { fwbSync: true });
  let link = entryLink(entry);
  if (await alignFoundryParent(entry, link, doc)) log("info", `Moved "${entry.name}" in Foundry to follow the wiki.`);
  link = entryLink(entry);
  const mapped = new Set(Object.values(link.pages).map((m) => m.documentId));
  const out = { entry, pulled: 0, ignored: 0 };
  if (doc.hasText || mapped.has(doc.id)) {
    await pullPage(client, rows, { kind: "page", key: `${row.key}:body`, parentKey: row.key, docId: doc.id, title: doc.title }, docs, { log });
    out.pulled++;
  }
  for (const c of docs.filter((d) => d.parentDocumentId === doc.id).sort(byTitle)) {
    await pullPage(client, rows, { kind: "page", key: `${row.key}:${c.id}`, parentKey: row.key, docId: c.id, title: c.title }, docs, { log });
    out.pulled++;
    out.ignored += docs.filter((d) => d.parentDocumentId === c.id).length;
  }
  return out;
}

// ------------------------------------------------------------------ direct operations (auto-sync)

/**
 * Push a single page without the table: only for entries that already have a wiki document.
 * Returns the wiki document, or null when the entry is not synced.
 */
export async function pushPageDirect(client, page, { log = () => {} } = {}) {
  const entry = page.parent;
  const link = entry ? entryLink(entry) : null;
  if (!link || !inScope(entry) || page.type !== "text") return null;
  try {
    return await pushPageCore(client, entry, link, page, { force: false, docs: null, log });
  } catch (err) {
    if (err?.status === 409) throw new Error(`"${page.name}" changed in the wiki too. Open Wiki Bridge to resolve it.`);
    throw err;
  }
}

/** Create the wiki document for a new entry whose folder is already synced, then push its pages. */
export async function pushEntryDirect(client, entry, { log = () => {} } = {}) {
  if (!inScope(entry)) return null;
  const parent = foundryParentDocId(entry);
  if (parent === undefined) return null; // its folder has no wiki document yet; Sync all will handle it
  let link = entryLink(entry);
  if (!link) {
    const doc = await client.create(settings().collectionId, { title: entry.name, markdown: "", parentDocumentId: parent ?? undefined });
    link = { documentId: doc.id, url: doc.url, parent, pages: {} };
    await saveEntryLink(entry, link);
  }
  let pushed = 0;
  for (const page of textPages(entry)) {
    await pushPageCore(client, entry, link, page, { docs: null, log });
    pushed++;
  }
  return { link, pushed };
}

/** Rename and/or re-parent the wiki document of an entry or folder to follow Foundry. */
export async function pushPlacementDirect(client, x) {
  const link = x instanceof Folder ? folderLink(x) : entryLink(x);
  if (!link) return false;
  if (!inScope(x)) return false;
  await client.update(link.documentId, { title: x.name, force: true });
  const expected = foundryParentDocId(x);
  if (expected === undefined) return true;
  if (!("parent" in link) || link.parent !== expected) {
    await client.move(link.documentId, { parentDocumentId: expected, collectionId: settings().collectionId });
    link.parent = expected;
    await (x instanceof Folder ? saveFolderLink(x, link) : saveEntryLink(x, link));
  }
  return true;
}

/** Pull a wiki document into the entry that owns it (an existing page mapping, or a new page). */
export async function pullPageDirect(client, entry, docId, { log = () => {}, title = "" } = {}) {
  const link = entryLink(entry);
  if (!link) return null;
  const hit = Object.entries(link.pages).find(([, m]) => m.documentId === docId);
  const page = hit ? entry.pages.get(hit[0]) ?? null : null;
  if (hit && !page) return null; // deleted here; Sync all decides what happens to the wiki copy
  return pullPageCore(client, entry, link, page, docId, { log, fallbackTitle: title });
}

/** Trash a page's wiki document (or clear the entry body) after the page was deleted in Foundry. */
export async function trashPageDirect(client, entry, pageId) {
  const link = entryLink(entry);
  const m = link?.pages?.[pageId];
  if (!m) return null;
  let mode;
  if (m.documentId === link.documentId) {
    await client.update(m.documentId, { markdown: "", force: true });
    mode = "cleared";
  } else {
    await client.remove(m.documentId);
    mode = "trashed";
  }
  delete link.pages[pageId];
  await saveEntryLink(entry, link);
  return mode;
}

export { entryForDoc, folderForDoc };

// ------------------------------------------------------------------ deletions

/**
 * Move a row's wiki document (with its children) to Outline's trash and drop any mapping to it.
 * A "(body)" page row maps to the entry's own document, so only its text is cleared.
 * Returns "cleared" or "trashed".
 */
export async function trashInWiki(client, rows, row) {
  if (typeof row.docId !== "string") throw new Error(`"${row.title}" has no wiki document`);
  const entryRow = row.kind === "page" ? entryRowOf(rows, row) : null;
  const entry = entryRow?.entryId ? game.journal.get(entryRow.entryId) : null;
  const link = entry ? entryLink(entry) : null;
  const isBody = row.kind === "page" && typeof entryRow?.docId === "string" && row.docId === entryRow.docId;
  let mode;
  if (isBody) {
    await client.update(row.docId, { markdown: "", force: true });
    mode = "cleared";
  } else {
    await client.remove(row.docId);
    mode = "trashed";
  }
  if (link) {
    for (const [pageId, m] of Object.entries(link.pages)) if (m.documentId === row.docId) delete link.pages[pageId];
    await saveEntryLink(entry, link);
  }
  return mode;
}

/** Delete a row's Foundry counterpart. Folders take their contents with them. */
export async function deleteInFoundry(rows, row) {
  if (row.kind === "folder") {
    const folder = game.folders.get(row.folderId);
    if (!folder) throw new Error(`Folder "${row.title}" not found`);
    await folder.delete({ deleteSubfolders: true, deleteContents: true, fwbSync: true });
  } else if (row.kind === "entry") {
    const entry = game.journal.get(row.entryId);
    if (!entry) throw new Error(`Entry "${row.title}" not found`);
    await entry.delete({ fwbSync: true });
  } else {
    const entry = game.journal.get(entryRowOf(rows, row)?.entryId);
    const page = entry?.pages.get(row.pageId);
    if (!page) throw new Error(`Page "${row.title}" not found`);
    await page.delete({ fwbSync: true });
    const link = entryLink(entry);
    if (link && link.pages[row.pageId]) {
      delete link.pages[row.pageId];
      await saveEntryLink(entry, link);
    }
  }
}

// ------------------------------------------------------------------ batch

/**
 * Run a batch over `subset` (in row order, so parents come first).
 * direction "safe": only unambiguous moves, conflicts skipped.  "pull" / "push": that direction,
 * `force` overriding conflicts. Returns counts; `log(level, msg)` gets the details.
 */
export async function syncRows(client, rows, subset, docs, { direction = "safe", force = false, log = () => {}, onProgress = () => {} } = {}) {
  const out = { pulled: 0, pushed: 0, skipped: 0 };
  const wholeEntries = new Set(); // entry keys handled as a unit; their page rows are skipped

  // rough cost up front: every item without a wiki document is one create, and Outline allows 25/min
  const creates = subset.filter((r) => typeof r.docId !== "string" && r.status !== "skipped" && r.status !== "too-deep" && (direction !== "pull")).length;
  if (creates > 25) log("info", `About ${creates} documents to create (plus one card per newly linked item). Outline allows 25 per minute, so expect roughly ${Math.ceil(creates / 25)} minutes with pauses. Leave the window open.`);

  let i = 0;
  for (const row of subset) {
    onProgress(++i, subset.length, out);
    if (row.status === "excluded" || row.status === "out-of-scope") continue;
    if (row.kind === "page" && wholeEntries.has(row.parentKey)) continue;
    const hasWiki = typeof row.docId === "string" && row.status !== "wiki-missing";
    const hasFoundry = Boolean(row.folderId || row.entryId || row.pageId);
    let action = null;
    if (direction === "safe") {
      if (row.moved === "both") {
        log("warn", `"${row.title}" moved on both sides. Pull or Push it to settle where it lives.`);
      } else if (row.moved) {
        try {
          await syncMove(client, row, docs, log);
        } catch (err) {
          out.skipped++;
          log("error", `"${row.title}": ${err.message}`);
        }
      }
      if (row.kind === "folder") {
        if (row.status === "wiki-only") action = "pull";
        else if (row.status === "foundry-only" || row.status === "wiki-missing") action = "push";
      } else if (row.kind === "entry") {
        if (row.status === "wiki-only") { action = "pull"; wholeEntries.add(row.key); }
        else if (row.status === "foundry-only" || row.status === "wiki-missing") { action = "push"; wholeEntries.add(row.key); }
        else if (row.status === "title-differs") { out.skipped++; log("warn", `Skipped "${row.title}": title differs. Pull or Push the entry to settle it.`); }
        if (!action) continue; // other entry states are handled page by page
      } else {
        action = STATUS[row.status].safe;
        if (action === "trash") {
          try {
            const mode = await trashInWiki(client, rows, row);
            out.trashed = (out.trashed ?? 0) + 1;
            log("info", mode === "cleared"
              ? `Cleared the body text of "${row.title}" in the wiki (its page was deleted in Foundry).`
              : `Trashed "${row.title}" in the wiki (deleted in Foundry).`);
          } catch (err) {
            out.skipped++;
            log("error", `"${row.title}": ${err.message}`);
          }
          continue;
        }
        if (!action && !["in-sync", "skipped", "too-deep"].includes(row.status)) {
          out.skipped++;
          log("warn", `Skipped "${row.title}": ${STATUS[row.status].label}. Resolve it with Pull or Push.`);
          continue;
        }
      }
    } else if (direction === "pull") {
      action = hasWiki ? "pull" : null;
      if (row.kind === "entry" && action) wholeEntries.add(row.key);
    } else {
      action = hasFoundry ? "push" : null;
      if (row.kind === "entry" && action) wholeEntries.add(row.key);
    }
    if (!action) continue;
    try {
      if (action === "pull") {
        if (row.kind === "folder") await pullFolder(client, rows, row, docs);
        else if (row.kind === "entry") out.pulled += (await pullEntry(client, rows, row, docs, { log })).pulled - 1;
        else await pullPage(client, rows, row, docs, { log });
        out.pulled++;
      } else {
        if (row.kind === "folder") await pushFolder(client, rows, row, docs);
        else if (row.kind === "entry") out.pushed += (await pushEntry(client, rows, row, docs, { force, log })).pushed - 1;
        else await pushPage(client, rows, row, docs, { force, log });
        out.pushed++;
      }
    } catch (err) {
      out.skipped++;
      log("error", `"${row.title}": ${err.message}`);
    }
  }
  return out;
}
