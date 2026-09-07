import { MODULE_ID } from "./constants.mjs";

/*
 * Link flags: how a Foundry document remembers its wiki counterpart.
 *
 *   entry.flags.<module>.link  = { documentId, url, parent, pages: { [pageId]: { documentId, url, outlineUpdatedAt, pageModifiedTime } } }
 *   folder.flags.<module>.link = { documentId, url, parent }
 *
 * `parent` is the wiki parent document id recorded at the last sync (null = collection root,
 * absent = never recorded); it is what move detection compares against.
 */

/** Bumped on every link write so caches keyed on the link table can invalidate. */
export const linksVersion = { n: 0 };

/** Entry link, migrated from any earlier shape to {documentId, url, parent, pages}. */
export function entryLink(entry) {
  const l = entry?.getFlag(MODULE_ID, "link");
  if (!l?.documentId) return null;
  const out = { documentId: l.documentId, pages: l.pages && typeof l.pages === "object" ? { ...l.pages } : {} };
  if (typeof l.url === "string") out.url = l.url;
  if ("parent" in l) out.parent = l.parent ?? null;
  return out;
}

export function folderLink(folder) {
  const l = folder?.getFlag(MODULE_ID, "link");
  if (!l?.documentId) return null;
  const out = { documentId: l.documentId };
  if (typeof l.url === "string") out.url = l.url;
  if ("parent" in l) out.parent = l.parent ?? null;
  return out;
}

/**
 * Persist an entry link. Foundry merges nested objects on update, so a mapping removed from
 * `link.pages` has to be deleted explicitly with the `-=` key syntax or it silently survives.
 */
export async function saveEntryLink(entry, link) {
  const raw = foundry.utils.getProperty(entry, `flags.${MODULE_ID}.link`) ?? {};
  const base = `flags.${MODULE_ID}.link`;
  const update = { [`${base}.documentId`]: link.documentId };
  if (typeof link.url === "string") update[`${base}.url`] = link.url;
  if ("parent" in link) update[`${base}.parent`] = link.parent ?? null;
  const oldPages = raw.pages && typeof raw.pages === "object" ? raw.pages : {};
  for (const [pid, m] of Object.entries(link.pages)) update[`${base}.pages.${pid}`] = m;
  for (const pid of Object.keys(oldPages)) if (!(pid in link.pages)) update[`${base}.pages.-=${pid}`] = null;
  for (const k of ["pageId", "outlineUpdatedAt", "pageModifiedTime", "foundryStamp", "collectionId"]) {
    if (k in raw) update[`${base}.-=${k}`] = null; // leftovers from earlier link shapes
  }
  await entry.update(update, { fwbSync: true });
  linksVersion.n++;
}

export async function saveFolderLink(folder, link) {
  const value = { documentId: link.documentId };
  if (typeof link.url === "string") value.url = link.url;
  if ("parent" in link) value.parent = link.parent ?? null;
  await folder.update({ [`flags.${MODULE_ID}.link`]: value }, { fwbSync: true });
  linksVersion.n++;
}

export async function clearEntryLink(entry) {
  await entry.update({ [`flags.${MODULE_ID}.-=link`]: null }, { fwbSync: true });
  linksVersion.n++;
}

/** The wiki url id (the trailing token of `/doc/<slug>-<urlId>`), or null. */
export function urlIdOf(url) {
  const m = /\/doc\/(?:[^/?#]*-)?([A-Za-z0-9]{8,})(?:[/?#]|$)/.exec(url ?? "");
  return m ? m[1] : null;
}
