import { MODULE_ID, STATUS, SETTINGS } from "./constants.mjs";
import { ProxyClient, BridgeError } from "./proxy-client.mjs";
import { computeRows, deleteInFoundry, pullEntry, pullFolder, pullPage, pushEntry, pushFolder, pushPage, reconcileLinks, selectedRoots, setRoots, settings, syncRows, trashInWiki } from "./sync.mjs";
import { autoState } from "./auto.mjs";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class BridgeApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "foundry-wiki-bridge",
    classes: ["fwb"],
    tag: "div",
    window: { title: "Wiki Bridge", icon: "fa-solid fa-book-atlas", resizable: true },
    position: { width: 820, height: 660 },
    actions: {
      refresh: BridgeApp.#onRefresh,
      syncAll: BridgeApp.#onSyncAll,
      pull: BridgeApp.#onPull,
      push: BridgeApp.#onPush,
      deleteWiki: BridgeApp.#onDeleteWiki,
      deleteFoundry: BridgeApp.#onDeleteFoundry,
      clearLog: BridgeApp.#onClearLog,
    },
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/bridge.hbs`,
      scrollable: [".fwb-rows", ".fwb-log"],
    },
  };

  static #instance = null;

  static open() {
    this.#instance ??= new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  constructor(...args) {
    super(...args);
    // auto-sync reports through this hook; show it here without echoing it to the console again
    Hooks.on("fwbLog", (level, message) => this.#log(level, message, { quiet: true }));
  }

  state = { collections: [], docs: [], rows: [], log: [], busy: false, loaded: false, progress: null };

  get client() {
    const client = ProxyClient.fromSettings();
    client.onWait = (seconds, attempt) => {
      const p = this.state.progress;
      const where = p ? ` Progress: item ${p.i} of ${p.n}, ${p.pushed} pushed, ${p.pulled} pulled so far.` : "";
      const retry = attempt > 1 ? ` (retry ${attempt} of ${ProxyClient.MAX_RETRIES})` : "";
      this.#log("warn", `Outline rate limit: pausing ${seconds}s, then continuing${retry}. Normal for big syncs.${where}`);
    };
    return client;
  }

  /** Progress callback for batch runs: keeps the header line fresh without spamming the log. */
  #progress = (i, n, out) => {
    this.state.progress = { i, n, pushed: out.pushed, pulled: out.pulled };
    if (i === 1 || i === n || i % 10 === 0) this.render();
  };

  // ---------------------------------------------------------------- rendering

  async _prepareContext() {
    const s = this.state;
    const client = this.client;
    const { collectionId, rootFolderIds, looseEntries } = settings();
    const roots = game.folders
      .filter((f) => f.type === "JournalEntry" && !f.folder)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ id: f.id, name: f.name, checked: rootFolderIds.includes(f.id) }));
    const collection = s.collections.find((c) => c.id === collectionId);
    const names = selectedRoots().map((f) => f.name);
    if (looseEntries) names.push("entries outside any folder");
    const auto = autoState();
    const autoParts = [];
    if (auto.push) autoParts.push("edits push automatically");
    if (auto.pull) autoParts.push(auto.puller ? "this browser pulls wiki changes every minute" : "another GM's browser pulls wiki changes");
    return {
      auto: autoParts.length ? `Auto-sync: ${autoParts.join("; ")}.` : "Auto-sync is off (Configure Settings → Foundry Wiki Bridge).",
      configured: client.configured,
      collections: s.collections.map((c) => ({ ...c, selected: c.id === collectionId })),
      roots,
      looseEntries,
      ready: Boolean(collection),
      rootName: names.length ? names.join(", ") : "(nothing selected)",
      nothingSelected: names.length === 0,
      rows: s.rows,
      log: s.log,
      busy: s.busy,
      progress: s.busy && s.progress ? `Running: item ${s.progress.i} of ${s.progress.n}, ${s.progress.pushed} pushed, ${s.progress.pulled} pulled.` : null,
      counts: this.#counts(),
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    if (!this.client.configured) {
      this.#log("warn", "Set the proxy URL (world setting) and the bridge secret (client setting) in Configure Settings, then reopen.");
      return;
    }
    await this.#loadCollections();
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelector("select[name=collection]")?.addEventListener("change", async (ev) => {
      await game.settings.set(MODULE_ID, SETTINGS.collectionId, ev.target.value || "");
      const name = this.state.collections.find((c) => c.id === ev.target.value)?.name ?? "(none)";
      this.#log("info", `This world now syncs with collection "${name}".`);
      await this.#refresh();
    });
    for (const box of this.element.querySelectorAll("input[name=root]")) {
      box.addEventListener("change", async () => {
        const ids = [...this.element.querySelectorAll("input[name=root]:checked")].map((b) => b.value);
        await setRoots(ids);
        const names = selectedRoots().map((f) => f.name);
        this.#log("info", names.length ? `Syncing top-level folders: ${names.join(", ")}.` : "No folders selected; nothing will sync.");
        await this.#refresh();
      });
    }
    this.element.querySelector("input[name=looseEntries]")?.addEventListener("change", async (ev) => {
      await game.settings.set(MODULE_ID, SETTINGS.looseEntries, ev.target.checked);
      this.#log("info", ev.target.checked ? "Entries outside any folder are included." : "Entries outside any folder are ignored.");
      await this.#refresh();
    });
  }

  #counts() {
    const out = {};
    for (const r of this.state.rows) {
      if (r.kind !== "page" || r.status === "skipped" || r.status === "too-deep") continue;
      out[r.status] = (out[r.status] ?? 0) + 1;
    }
    return Object.entries(out).map(([k, n]) => `${STATUS[k].label}: ${n}`).join(" · ");
  }

  // ------------------------------------------------------------------ helpers

  #log(level, message, { quiet = false } = {}) {
    const time = new Date().toLocaleTimeString();
    this.state.log.unshift({ level, message, time });
    if (this.state.log.length > 200) this.state.log.length = 200;
    if (!quiet) console[level === "error" ? "error" : "log"](`${MODULE_ID} | ${message}`);
    if (this.rendered) this.render();
  }

  async #run(label, fn) {
    if (this.state.busy) return;
    this.state.busy = true;
    this.render();
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof BridgeError ? `${label}: ${err.message} (${err.code})` : `${label}: ${err.message}`;
      this.#log("error", msg);
      ui.notifications.error(msg);
      // a failed action may have changed either side part-way; never leave stale rows on screen
      try { await this.#refreshRows(); } catch { /* the error above is the one that matters */ }
    } finally {
      this.state.busy = false;
      this.state.progress = null;
      this.render();
    }
  }

  async #loadCollections() {
    await this.#run("Load collections", async () => {
      const client = this.client;
      await client.health();
      this.state.collections = await client.collections();
      this.state.loaded = true;
      this.#log("info", `Proxy reachable. ${this.state.collections.length} collection(s) in the wiki.`);
      await this.#refreshRows();
    });
  }

  async #refreshRows() {
    const { collectionId } = settings();
    if (!collectionId) {
      this.state.docs = [];
      this.state.rows = [];
      return;
    }
    this.state.docs = await this.client.documents(collectionId);
    const fixed = await reconcileLinks(this.state.docs);
    if (fixed) this.#log("info", `Updated ${fixed} link record(s) from an earlier version.`);
    this.state.rows = computeRows(this.state.docs);
  }

  async #refresh() {
    await this.#run("Refresh", () => this.#refreshRows());
  }

  #row(target) {
    const key = target.closest("[data-key]")?.dataset.key;
    return this.state.rows.find((r) => r.key === key);
  }

  #subtree(row) {
    return this.state.rows.filter((r) => r.ancestors.includes(row.key));
  }

  async #confirmOverwrite(row, direction) {
    const risky = ["conflict", "in-sync", "mixed", "title-differs"];
    const subtreeRisky = row.kind !== "page" && this.#subtree(row).some((r) => risky.includes(r.status));
    if (!risky.includes(row.status) && !subtreeRisky) return true;
    const side = direction === "pull" ? "Foundry" : "the wiki";
    const what = row.kind === "page" ? `page "${row.title}"` : `"${row.title}" and everything under it`;
    return foundry.applications.api.DialogV2.confirm({
      window: { title: "Overwrite?" },
      content: `<p>${foundry.utils.escapeHTML(what)} includes content that is in sync or changed on both sides. Overwrite the copy in ${side}?</p>`,
      rejectClose: false,
      modal: true,
    });
  }

  #report(label, res) {
    const trashed = res.trashed ? `, trashed ${res.trashed} in the wiki` : "";
    this.#log("info", `${label}: pulled ${res.pulled}, pushed ${res.pushed}${trashed}, skipped ${res.skipped}.`);
  }

  async #confirmDelete(row, side) {
    const scope = row.kind === "page" ? `page "${row.title}"` : `"${row.title}" and everything under it`;
    const note = side === "wiki" ? "It goes to Outline's trash, recoverable for 30 days." : "Foundry has no trash; this cannot be undone.";
    return foundry.applications.api.DialogV2.confirm({
      window: { title: side === "wiki" ? "Delete in wiki?" : "Delete in Foundry?" },
      content: `<p>Delete ${foundry.utils.escapeHTML(scope)} in ${side === "wiki" ? "the wiki" : "Foundry"}? ${note}</p>`,
      rejectClose: false,
      modal: true,
    });
  }

  // ------------------------------------------------------------------ actions

  static async #onRefresh() {
    if (!this.state.loaded) return this.#loadCollections();
    await this.#refresh();
  }

  static async #onPull(event, target) {
    const row = this.#row(target);
    if (!row) return;
    if (!(await this.#confirmOverwrite(row, "pull"))) return;
    await this.#run(`Pull "${row.title}"`, async () => {
      const { rows, docs } = this.state;
      const log = (l, m) => this.#log(l, m);
      if (row.kind === "folder") {
        await pullFolder(this.client, rows, row, docs);
        this.#report(`Pulled folder "${row.title}"`, await syncRows(this.client, rows, this.#subtree(row), docs, { direction: "pull", log, onProgress: this.#progress }));
      } else if (row.kind === "entry") {
        const res = await pullEntry(this.client, rows, row, docs, { log });
        const deep = res.ignored ? ` ${res.ignored} document(s) nested too deep were ignored.` : "";
        this.#log("info", `Pulled "${res.entry.name}": ${res.pulled} page(s).${deep}`);
      } else {
        const doc = await pullPage(this.client, rows, row, docs, { log });
        this.#log("info", `Pulled page "${doc.title}".`);
      }
      await this.#refreshRows();
    });
  }

  static async #onPush(event, target) {
    const row = this.#row(target);
    if (!row) return;
    if (!(await this.#confirmOverwrite(row, "push"))) return;
    await this.#run(`Push "${row.title}"`, async () => {
      const { rows, docs } = this.state;
      const log = (l, m) => this.#log(l, m);
      if (row.kind === "folder") {
        await pushFolder(this.client, rows, row, docs);
        this.#report(`Pushed folder "${row.title}"`, await syncRows(this.client, rows, this.#subtree(row), docs, { direction: "push", force: true, log, onProgress: this.#progress }));
      } else if (row.kind === "entry") {
        const res = await pushEntry(this.client, rows, row, docs, { force: true, log });
        this.#log("info", `Pushed "${res.entry.name}": ${res.pushed} page(s) as child documents, ${res.skipped} non-text skipped.`);
      } else {
        const doc = await pushPage(this.client, rows, row, docs, { force: true, log });
        this.#log("info", `Pushed page "${row.title}" to the wiki as "${doc.title}".`);
      }
      await this.#refreshRows();
    });
  }

  static async #onSyncAll() {
    await this.#run("Sync all", async () => {
      await this.#refreshRows();
      const { rows, docs } = this.state;
      this.#report("Sync all done", await syncRows(this.client, rows, rows, docs, { direction: "safe", log: (l, m) => this.#log(l, m), onProgress: this.#progress }));
      await this.#refreshRows();
    });
  }

  static async #onDeleteWiki(event, target) {
    const row = this.#row(target);
    if (!row || !(await this.#confirmDelete(row, "wiki"))) return;
    await this.#run(`Delete "${row.title}" in wiki`, async () => {
      const mode = await trashInWiki(this.client, this.state.rows, row);
      this.#log("info", mode === "cleared"
        ? `Cleared the body text of "${row.title}" in the wiki. The entry document itself stays.`
        : `Moved "${row.title}" to the wiki's trash.`);
      await this.#refreshRows();
    });
  }

  static async #onDeleteFoundry(event, target) {
    const row = this.#row(target);
    if (!row || !(await this.#confirmDelete(row, "foundry"))) return;
    await this.#run(`Delete "${row.title}" in Foundry`, async () => {
      await deleteInFoundry(this.state.rows, row);
      this.#log("info", `Deleted "${row.title}" in Foundry.`);
      await this.#refreshRows();
    });
  }

  static #onClearLog() {
    this.state.log = [];
    this.render();
  }
}
