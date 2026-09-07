import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { BridgeApp } from "./app.mjs";
import { entryLink } from "./links.mjs";
import { initAuto } from "./auto.mjs";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.proxyUrl, {
    name: "Bridge proxy URL",
    hint: "Base URL of the wiki-bridge proxy, e.g. https://bridge.example.com. World setting: visible to everyone, holds no secret.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, SETTINGS.secret, {
    name: "Bridge secret",
    hint: "Shared secret the proxy expects. Client setting: stored only in this browser, never sent to other players.",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, SETTINGS.publicUrl, {
    name: "Public Foundry URL for images",
    hint: "Images in pushed pages link back to this address, e.g. https://foundry.example.com. Leave empty to use the address this browser is on.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, SETTINGS.itemCards, {
    name: "Mirror linked items as wiki cards",
    hint: "Items linked from a page get a card document under 📦 Items in the wiki; hovering the link there previews it. Actors are never mirrored.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, SETTINGS.autoPush, {
    name: "Auto-push journal edits",
    hint: "Send edits to synced pages to the wiki a few seconds after they settle. Deleting a synced page trashes its wiki copy.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(MODULE_ID, SETTINGS.autoPull, {
    name: "Auto-pull wiki changes",
    hint: "The active GM's browser checks the wiki once a minute and pulls pages changed there, when the Foundry copy is unchanged.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  // Chosen from the Wiki Bridge window, not the settings sheet.
  game.settings.register(MODULE_ID, SETTINGS.collectionId, { scope: "world", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, SETTINGS.rootFolderId, { scope: "world", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, SETTINGS.rootFolderIds, { scope: "world", config: false, type: String, default: "[]" });
  game.settings.register(MODULE_ID, SETTINGS.looseEntries, { scope: "world", config: false, type: Boolean, default: false });
  game.settings.register(MODULE_ID, SETTINGS.itemMap, { scope: "world", config: false, type: String, default: "{}" });
  game.settings.register(MODULE_ID, SETTINGS.itemsRootDocId, { scope: "world", config: false, type: String, default: "" });
});

Hooks.once("ready", async () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = { open: () => BridgeApp.open() };

  // Migrate the single-root setting from 0.3–0.4 into the multi-root list, once.
  if (game.user.isGM) {
    const legacy = game.settings.get(MODULE_ID, SETTINGS.rootFolderId);
    if (legacy) {
      const current = game.settings.get(MODULE_ID, SETTINGS.rootFolderIds);
      if (!current || current === "[]") await game.settings.set(MODULE_ID, SETTINGS.rootFolderIds, JSON.stringify([legacy]));
      await game.settings.set(MODULE_ID, SETTINGS.rootFolderId, "");
    }
    initAuto();
  }
});

/** Add a "Wiki Bridge" button to the journal sidebar header for GMs. */
Hooks.on("renderJournalDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".fwb-open")) return;
  const header =
    root.querySelector(".directory-header .action-buttons") ??
    root.querySelector(".directory-header .header-actions") ??
    root.querySelector(".directory-header");
  if (!header) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fwb-open";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-book-atlas";
  btn.append(icon, " Wiki Bridge");
  btn.addEventListener("click", () => BridgeApp.open());
  header.appendChild(btn);
});

/** "Open in wiki" in the header of any synced journal entry, for everyone who can see it. */
Hooks.on("getHeaderControlsJournalEntrySheet", (sheet, controls) => {
  if (!entryLink(sheet.document)?.url) return;
  controls.push({ icon: "fa-solid fa-book-atlas", label: "Open in wiki", action: "fwbOpenWiki" });
});
Hooks.on("renderJournalEntrySheet", (sheet) => {
  const url = entryLink(sheet.document)?.url;
  if (!url) return;
  for (const el of sheet.element?.querySelectorAll('[data-action="fwbOpenWiki"]') ?? []) {
    if (el.dataset.fwbBound) continue;
    el.dataset.fwbBound = "1";
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.open(url, "_blank", "noopener");
    });
  }
});
