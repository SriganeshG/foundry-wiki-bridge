/**
 * HTML <-> markdown conversion between Foundry's editor and Outline's dialect.
 *
 * Push (HTML -> markdown): the module sends Foundry HTML that has already been run through
 * Foundry's enricher, so content links, inline rolls and system enrichers arrive as anchors.
 * A DOM pre-pass normalises what Outline cannot express (GM secrets, merged table cells,
 * PF2e action glyphs, deep headings), then turndown does the rest.
 *
 * Pull (markdown -> HTML): marked with Outline's extras: `__underline__`, `==highlight==`,
 * `:::info` notices, and image sizes carried in the title (`"layout =WxH"`).
 */
import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { marked, type TokenizerAndRendererExtension, type Tokens } from "marked";

// ---------------------------------------------------------------------------
// HTML -> markdown
// ---------------------------------------------------------------------------

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
});
turndown.use(gfm);
turndown.addRule("strikethrough", {
  // the gfm plugin emits a single tilde; Outline only parses the double form
  filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
  replacement: (content) => (content.trim() ? `~~${content}~~` : content),
});
turndown.addRule("underline", {
  filter: (node) =>
    node.nodeName === "U" ||
    (node.nodeName === "SPAN" && /underline/i.test(node.getAttribute("style") ?? "")),
  replacement: (content) => (content.trim() ? `__${content}__` : content),
});
turndown.addRule("highlight", {
  filter: "mark",
  replacement: (content) => (content.trim() ? `==${content}==` : content),
});
turndown.addRule("lineBreakInCell", {
  // table cells are single-line in markdown
  filter: (node) => node.nodeName === "BR" && Boolean(node.closest?.("td, th")),
  replacement: () => " ",
});
turndown.addRule("plainAnchor", {
  // anchors without an href (unresolved content links, rolls the pre-pass did not handle)
  filter: (node) => node.nodeName === "A" && !node.getAttribute("href"),
  replacement: (content) => content,
});

/** PF2e action cost glyphs (the "Pathfinder2eActions" font) as plain Unicode. */
const GLYPHS: Record<string, string> = {
  "1": "◆", "a": "◆", "A": "◆",
  "2": "◆◆", "d": "◆◆", "D": "◆◆",
  "3": "◆◆◆", "t": "◆◆◆", "T": "◆◆◆",
  "f": "◇", "F": "◇",
  "r": "↺", "R": "↺",
};

function glyph(text: string): string {
  const t = text.trim();
  if (t in GLYPHS) return GLYPHS[t];
  // ranges such as "1 - 3" or "1-2"
  const m = /^([123])\s*(?:-|–|to)\s*([123])$/.exec(t);
  if (m) return `${GLYPHS[m[1]]} to ${GLYPHS[m[2]]}`;
  return t;
}

/**
 * Normalise Foundry HTML in place before turndown sees it.
 * Exported for tests; `htmlToMarkdown` calls it.
 */
export function prepareFoundryHtml(root: Element): void {
  const doc = root.ownerDocument;

  // GM-only secret blocks. The module already strips these through Foundry's enricher; this is the
  // safety net for callers that send raw page HTML.
  for (const el of Array.from(root.querySelectorAll("section.secret"))) {
    if (!el.classList.contains("revealed")) el.remove();
  }

  // Icon-only elements (Font Awesome) and PF2e repost buttons carry no text.
  for (const el of Array.from(root.querySelectorAll("i[class*='fa-'], span.repost, button"))) {
    if (!el.textContent?.trim()) el.remove();
  }

  // Action glyphs: PF2e journals write the glyph letter inside a span styled with the action font.
  for (const el of Array.from(root.querySelectorAll("span.action-glyph, span.pf2-icon"))) {
    el.replaceWith(doc.createTextNode(glyph(el.textContent ?? "")));
  }

  // Inline rolls: `[[/r 1d20+5]]` -> code; a flavour label keeps the formula beside it.
  for (const el of Array.from(root.querySelectorAll("a.inline-roll"))) {
    const formula = (el.getAttribute("data-formula") ?? "").trim();
    const label = (el.textContent ?? "").trim();
    const code = doc.createElement("code");
    code.textContent = formula || label;
    if (formula && label && label !== formula) {
      const span = doc.createElement("span");
      for (const part of [doc.createTextNode(label + " ("), code, doc.createTextNode(")")]) span.appendChild(part);
      el.replaceWith(span);
    } else {
      el.replaceWith(code);
    }
  }
  // Evaluated inline rolls show their result.
  for (const el of Array.from(root.querySelectorAll("a.inline-result, span.inline-result"))) {
    el.replaceWith(doc.createTextNode((el.textContent ?? "").trim()));
  }
  // PF2e checks, damage, templates and similar enrichers: keep the visible label only.
  for (const el of Array.from(root.querySelectorAll("a.inline-check, span.inline-check, a[data-pf2-check], a[data-pf2-damage], span[data-pf2-damage], a[data-pf2-template], a.inline-template, a[data-damage-roll]"))) {
    const label = el.querySelector(".label");
    el.replaceWith(doc.createTextNode(((label ?? el).textContent ?? "").trim()));
  }

  // Outline's editor stops at four heading levels.
  for (const el of Array.from(root.querySelectorAll("h5, h6"))) {
    const h4 = doc.createElement("h4");
    while (el.firstChild) h4.appendChild(el.firstChild);
    el.replaceWith(h4);
  }

  // Tables: GFM needs a header row and cannot merge cells or hold block content.
  for (const table of Array.from(root.querySelectorAll("table"))) {
    prepareTable(table, doc);
  }
}

function prepareTable(table: Element, doc: Document): void {
  // flatten every cell to inline content
  for (const cell of Array.from(table.querySelectorAll("td, th"))) {
    const blocks = Array.from(cell.children).filter((c) => /^(P|DIV|UL|OL|H[1-6]|BLOCKQUOTE)$/.test(c.nodeName));
    if (blocks.length && blocks.length === Array.from(cell.children).length) {
      const parts: Node[] = [];
      for (const b of blocks) {
        if (parts.length) parts.push(doc.createTextNode(" "));
        if (/^(UL|OL)$/.test(b.nodeName)) {
          parts.push(doc.createTextNode(Array.from(b.querySelectorAll("li")).map((li) => li.textContent?.trim() ?? "").filter(Boolean).join("; ")));
        } else {
          while (b.firstChild) parts.push(b.removeChild(b.firstChild));
        }
      }
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      for (const part of parts) cell.appendChild(part);
    }
    // expand merged columns into empty siblings so every row has the same width
    const span = Number(cell.getAttribute("colspan") ?? 1);
    if (span > 1) {
      cell.removeAttribute("colspan");
      for (let i = 1; i < span; i++) cell.after(doc.createElement(cell.nodeName.toLowerCase()));
    }
    cell.removeAttribute("rowspan");
  }
  // caption -> a bold line above the table
  const caption = table.querySelector("caption");
  if (caption) {
    const p = doc.createElement("p");
    const strong = doc.createElement("strong");
    strong.textContent = caption.textContent?.trim() ?? "";
    p.appendChild(strong);
    table.before(p);
    caption.remove();
  }
  // header row: keep an existing thead; otherwise promote the first row
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return;
  const first = rows[0];
  const inThead = first.parentElement?.nodeName === "THEAD";
  const allTh = Array.from(first.children).every((c) => c.nodeName === "TH");
  if (!inThead || !allTh) {
    for (const c of Array.from(first.children)) {
      if (c.nodeName === "TH") continue;
      const th = doc.createElement("th");
      while (c.firstChild) th.appendChild(c.firstChild);
      c.replaceWith(th);
    }
    if (!inThead) {
      const thead = doc.createElement("thead");
      thead.appendChild(first);
      table.insertBefore(thead, table.firstChild);
    }
  }
  // the gfm plugin wants the header row to be the first child of the first section
  for (const empty of Array.from(table.querySelectorAll("thead, tbody, tfoot"))) {
    if (!empty.querySelector("tr")) empty.remove();
  }
}

export function htmlToMarkdown(html: string): string {
  const doc = domino.createDocument("<div id=\"fwb-root\"></div>");
  const root = doc.getElementById("fwb-root")!;
  root.innerHTML = html;
  prepareFoundryHtml(root);
  return turndown.turndown(root as unknown as HTMLElement);
}

// ---------------------------------------------------------------------------
// markdown -> HTML
// ---------------------------------------------------------------------------

/** Inline `open…open` wrapper as a marked extension, taking priority over the built-in tokenizers. */
function wrapped(name: string, open: string, tag: string): TokenizerAndRendererExtension {
  const esc = open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}(?!${esc[0]})(?=\\S)([\\s\\S]*?\\S)${esc}(?!${esc[0]})`);
  return {
    name,
    level: "inline",
    start: (src) => src.indexOf(open),
    tokenizer(src) {
      const m = re.exec(src);
      if (!m) return undefined;
      return { type: name, raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer(token) {
      return `<${tag}>${this.parser.parseInline(token.tokens ?? [])}</${tag}>`;
    },
  };
}

/** Outline notice blocks: `:::info` / `:::warning` / `:::tip` / `:::success` ... `:::`. */
const notice: TokenizerAndRendererExtension = {
  name: "notice",
  level: "block",
  start: (src) => src.indexOf(":::"),
  tokenizer(src) {
    const m = /^:::\s*(\w+)[ \t]*\n([\s\S]*?)\n:::[ \t]*(?:\n|$)/.exec(src);
    if (!m) return undefined;
    return { type: "notice", raw: m[0], kind: m[1].toLowerCase(), tokens: this.lexer.blockTokens(m[2]) };
  },
  renderer(token) {
    const t = token as Tokens.Generic & { kind: string };
    // Foundry's editor keeps blockquotes; the kind survives as a leading label
    const label = t.kind.charAt(0).toUpperCase() + t.kind.slice(1);
    return `<blockquote class="fwb-notice fwb-notice-${t.kind}"><p><strong>${label}:</strong></p>${this.parser.parse(t.tokens ?? [])}</blockquote>\n`;
  },
};

marked.setOptions({ gfm: true, breaks: false });
marked.use({
  extensions: [wrapped("underline", "__", "u"), wrapped("highlight", "==", "mark"), notice],
  renderer: {
    image({ href, title, text }) {
      // Outline stores layout and size in the title: "full-width =640x480", "=320x"
      let attrs = "";
      const m = /(?:^|\s)=(\d*)x(\d*)$/.exec(title ?? "");
      if (m) {
        if (m[1]) attrs += ` width="${m[1]}"`;
        if (m[2]) attrs += ` height="${m[2]}"`;
      }
      const rest = (title ?? "").replace(/(?:^|\s)=\d*x\d*$/, "").replace(/\b(full-width|left-50|right-50)\b/g, "").trim();
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      return `<img src="${esc(href)}" alt="${esc(text)}"${rest ? ` title="${esc(rest)}"` : ""}${attrs}>`;
    },
  },
});

export function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
