import { MODULE_ID, SETTINGS, FOLDER_ICON } from "./constants.mjs";
import { ProxyClient } from "./proxy-client.mjs";
import { entryLink, folderLink } from "./links.mjs";
import { settings, inScope, entryForDoc, folderForDoc, pushPageDirect, pushEntryDirect, pushPlacementDirect, pullPageDirect, trashPageDirect } from "./sync.mjs";

/*
 * Auto-sync.
 *
 * Push: journal edits made in this browser go to the wiki a few seconds after the last keystroke
 * settles (debounced per page). Only entries that already have a wiki document, inside the
 * selected folders, take part; new entries in a synced folder get a document of their own.
 * Deleting a synced page trashes its wiki copy, matching what Sync all would do.
 *
 * Pull: the active GM's browser polls the proxy once a minute for wiki documents updated since
 * the last poll and pulls those whose Foundry page has not changed meanwhile. Conflicts and new
 * folders are left for the Wiki Bridge window.
 *
 * Every write the module makes carries the `fwbSync` option, which these hooks ignore, so a pull
 * never triggers a push.
 */

const DEBOUNCE_MS = 4000;
const POLL_MS = 60_000;

const timers = new Map();
let since = null;
let polling = false;

export function log(level, message) {
  Hooks.callAll("fwbLog", level, message);
  console[level === "error" ? "error" : "log"](`${MODULE_ID} | ${message}`);
}

function enabled(key) {
  if (!game.user?.isGM) return false;
  if (!game.settings.get(MODULE_ID, key)) return false;
  if (!settings().collectionId) return false;
  return ProxyClient.fromSettings().configured;
}

function mine(options, userId) {
  return userId === game.user.id && !options?.fwbSync;
}

function client() {
  const c = ProxyClient.fromSettings();
  c.onWait = (seconds) => log("warn", `Auto-sync: wiki rate limit, waiting ${seconds}s.`);
  return c;
}

function schedule(key, label, fn) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    try {
      const msg = await fn();
      if (msg) log("info", msg);
    } catch (err) {
      log("error", `Auto-push ${label}: ${err.message}`);
      ui.notifications.warn(`Wiki Bridge: ${err.message}`);
    }
  }, DEBOUNCE_MS));
}

export function autoState() {
  return {
    push: Boolean(game.settings.get(MODULE_ID, SETTINGS.autoPush)),
    pull: Boolean(game.settings.get(MODULE_ID, SETTINGS.autoPull)),
    puller: game.users.activeGM?.id === game.user.id,
  };
}

export function initAuto() {
  // ---- push: pages
  const pageChanged = (page, options, userId) => {
    if (!mine(options, userId) || !enabled(SETTINGS.autoPush) || page.type !== "text") return;
    if (!page.parent || !entryLink(page.parent)) return;
    schedule(`page:${page.uuid}`, `"${page.name}"`, async () => {
      const doc = await pushPageDirect(client(), page, { log });
      return doc ? `Auto-pushed "${page.name}" to the wiki.` : null;
    });
  };
  Hooks.on("createJournalEntryPage", (page, options, userId) => pageChanged(page, options, userId));
  Hooks.on("updateJournalEntryPage", (page, changes, options, userId) => {
    if (!("text" in changes || "name" in changes)) return;
    pageChanged(page, options, userId);
  });
  Hooks.on("deleteJournalEntryPage", (page, options, userId) => {
    if (!mine(options, userId) || !enabled(SETTINGS.autoPush)) return;
    const entry = page.parent;
    if (!entry || !entryLink(entry)?.pages?.[page.id]) return;
    clearTimeout(timers.get(`page:${page.uuid}`));
    schedule(`trash:${page.uuid}`, `"${page.name}"`, async () => {
      const mode = await trashPageDirect(client(), entry, page.id);
      if (!mode) return null;
      return mode === "cleared" ? `Cleared the wiki body of "${entry.name}" (page deleted here).` : `Trashed "${page.name}" in the wiki (deleted here).`;
    });
  });

  // ---- push: entries and folders
  Hooks.on("createJournalEntry", (entry, options, userId) => {
    if (!mine(options, userId) || !enabled(SETTINGS.autoPush)) return;
    schedule(`entry:${entry.uuid}`, `"${entry.name}"`, async () => {
      const res = await pushEntryDirect(client(), entry, { log });
      return res ? `Auto-pushed new entry "${entry.name}" (${res.pushed} page(s)).` : null;
    });
  });
  Hooks.on("updateJournalEntry", (entry, changes, options, userId) => {
    if (!mine(options, userId) || !enabled(SETTINGS.autoPush)) return;
    if (!("name" in changes || "folder" in changes)) return;
    if (!entryLink(entry)) return;
    schedule(`place:${entry.uuid}`, `"${entry.name}"`, async () => {
      const ok = await pushPlacementDirect(client(), entry);
      return ok ? `Auto-pushed the name and place of "${entry.name}".` : null;
    });
  });
  Hooks.on("deleteJournalEntry", (entry, options, userId) => {
    if (!mine(options, userId) || !enabled(SETTINGS.autoPush)) return;
    const link = entryLink(entry);
    if (!link) return;
    schedule(`trash:${entry.uuid}`, `"${entry.name}"`, async () => {
      await client().remove(link.documentId);
      return `Trashed "${entry.name}" in the wiki (deleted here). Recoverable from Outline's trash for 30 days.`;
    });
  });
  Hooks.on("updateFolder", (folder, changes, options, userId) => {
    if (folder.type !== "JournalEntry" || !mine(options, userId) || !enabled(SETTINGS.autoPush)) return;
    if (!("name" in changes || "folder" in changes)) return;
    if (!folderLink(folder)) return;
    schedule(`place:${folder.uuid}`, `"${folder.name}"`, async () => {
      const ok = await pushPlacementDirect(client(), folder);
      return ok ? `Auto-pushed the name and place of folder "${folder.name}".` : null;
    });
  });

  // ---- pull
  since = new Date().toISOString();
  setInterval(() => { poll().catch((err) => log("warn", `Auto-pull: ${err.message}`)); }, POLL_MS);
}

async function poll() {
  if (polling || !enabled(SETTINGS.autoPull)) return;
  if (game.users.activeGM?.id !== game.user.id) return; // one browser pulls, or two would race
  polling = true;
  try {
    const c = client();
    const res = await c.changes(settings().collectionId, since);
    for (const d of [...res.docs].reverse()) {
      try {
        await applyWikiChange(c, d);
      } catch (err) {
        log("error", `Auto-pull "${d.title}": ${err.message}`);
      }
    }
    if (res.latest && res.latest > since) since = res.latest;
    if (res.truncated) log("warn", "Auto-pull: more wiki changes than one poll covers. Open Wiki Bridge and Sync all.");
  } finally {
    polling = false;
  }
}

async function applyWikiChange(c, d) {
  // an entry's own document: title, and its body when mapped
  const entry = entryForDoc(d.id);
  if (entry) {
    if (!inScope(entry)) return;
    const link = entryLink(entry);
    if (entry.name !== d.title) {
      await entry.update({ name: d.title }, { fwbSync: true });
      log("info", `Auto-pulled the new title "${d.title}".`);
    }
    const bodyHit = Object.entries(link.pages).find(([, m]) => m.documentId === d.id);
    if (bodyHit) await pullMapped(c, entry, bodyHit[0], bodyHit[1], d);
    else if (d.hasText) await pullNew(c, entry, d);
    return;
  }
  // a folder document: title only
  const folder = folderForDoc(d.id);
  if (folder) {
    if (folder.name !== d.title && inScope(folder)) {
      await folder.update({ name: d.title }, { fwbSync: true });
      log("info", `Auto-pulled folder title "${d.title}".`);
    }
    return;
  }
  // a page document
  for (const e of game.journal) {
    const l = entryLink(e);
    if (!l) continue;
    const hit = Object.entries(l.pages).find(([, m]) => m.documentId === d.id);
    if (hit) {
      if (inScope(e)) await pullMapped(c, e, hit[0], hit[1], d);
      return;
    }
  }
  // a new document under a synced entry
  const parent = d.parentDocumentId ? entryForDoc(d.parentDocumentId) : null;
  if (parent && inScope(parent) && d.icon !== FOLDER_ICON) await pullNew(c, parent, d);
}

async function pullMapped(c, entry, pageId, mapping, d) {
  if (mapping.outlineUpdatedAt === d.updatedAt) return; // our own push, or already pulled
  const page = entry.pages.get(pageId);
  if (!page) return; // deleted here; Sync all decides
  if (page._stats?.modifiedTime !== mapping.pageModifiedTime) {
    log("warn", `"${page.name}" changed in both Foundry and the wiki. Open Wiki Bridge to resolve it.`);
    return;
  }
  await pullPageDirect(c, entry, d.id, { log, title: d.title });
  log("info", `Auto-pulled "${d.title}" from the wiki.`);
  ui.notifications.info(`Wiki Bridge: pulled "${d.title}" from the wiki.`);
}

async function pullNew(c, entry, d) {
  await pullPageDirect(c, entry, d.id, { log, title: d.title });
  log("info", `Auto-pulled new page "${d.title}" into "${entry.name}".`);
  ui.notifications.info(`Wiki Bridge: new page "${d.title}" pulled into "${entry.name}".`);
}
