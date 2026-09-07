export const MODULE_ID = "foundry-wiki-bridge";

/** Setting keys. */
export const SETTINGS = {
  proxyUrl: "proxyUrl", // world: base URL of the proxy
  secret: "secret", // client: shared secret, this browser only
  publicUrl: "publicUrl", // world: browser-facing Foundry URL used for image links; empty = this browser's address
  itemCards: "itemCards", // world: mirror linked items as wiki cards
  autoPush: "autoPush", // world: push journal edits to the wiki as they happen
  autoPull: "autoPull", // world: poll the wiki for changes and pull them
  collectionId: "collectionId",
  rootFolderId: "rootFolderId", // legacy single root, migrated into rootFolderIds on ready
  rootFolderIds: "rootFolderIds", // JSON array of top-level journal folder ids to sync
  looseEntries: "looseEntries", // also sync entries that sit outside any folder
  itemMap: "itemMap", // JSON: { [uuid]: { documentId, url, name } } for item cards
  itemsRootDocId: "itemsRootDocId", // the 📦 document item cards live under
};

/** Mirrors CONST.JOURNAL_ENTRY_PAGE_FORMATS. */
export const FORMATS = { HTML: 1, MARKDOWN: 2 };

/** Wiki documents carrying this icon are journal folders; anything else is an entry or a page. */
export const FOLDER_ICON = "📁";

/** The collection-root document that holds item cards. */
export const ITEMS_ICON = "📦";
export const ITEMS_TITLE = "Items";

/** Folder inside the world's data directory that receives images pulled from the wiki. */
export const PULLED_FILES_DIR = "wiki-bridge";

/**
 * Sync states a row can be in: the label shown, which actions make sense, and the "safe" move
 * Sync all may take on its own. `deleteWiki` / `deleteFoundry` expose the trash buttons.
 */
export const STATUS = {
  "in-sync": { label: "In sync", pull: true, push: true, safe: null },
  "wiki-only": { label: "Only in wiki", pull: true, push: false, safe: "pull", deleteWiki: true },
  "foundry-only": { label: "Only in Foundry", pull: false, push: true, safe: "push", deleteFoundry: true },
  "wiki-changed": { label: "Wiki changed", pull: true, push: true, safe: "pull" },
  "foundry-changed": { label: "Foundry changed", pull: true, push: true, safe: "push" },
  "conflict": { label: "Conflict: both changed", pull: true, push: true, safe: null },
  "wiki-missing": { label: "Gone from wiki", pull: false, push: true, safe: null, deleteFoundry: true },
  "foundry-deleted": { label: "Deleted in Foundry", pull: true, push: false, safe: "trash", deleteWiki: true },
  "mixed": { label: "Mixed changes", pull: true, push: true, safe: null },
  "title-differs": { label: "Title differs", pull: true, push: true, safe: null },
  "skipped": { label: "Not a text page", pull: false, push: false, safe: null },
  "too-deep": { label: "Nested too deep for a page", pull: false, push: false, safe: null },
  "excluded": { label: "Not selected for sync", pull: false, push: false, safe: null, deleteWiki: true },
  "out-of-scope": { label: "Moved out of the synced folders", pull: false, push: false, safe: null, deleteWiki: true },
};
