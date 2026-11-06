const { Plugin, Notice } = require("obsidian");

const AUTHOR = "Сафьянов Камиль Саматович";
const MAGIC = "SAFAUTH1";
const NL = String.fromCharCode(10);
const ZW0 = String.fromCharCode(0x200b);
const ZW1 = String.fromCharCode(0x200c);
const S = String.fromCharCode(0x2060);
const E = String.fromCharCode(0x2063);
const RE = new RegExp(S + "[" + ZW0 + ZW1 + "]+" + E, "g");

function getSubtle() {
  try {
    const c = globalThis.crypto;
    if (c && c.subtle) return c.subtle;
  } catch (e) {}
  try {
    const n = require("crypto");
    if (n && n.webcrypto && n.webcrypto.subtle) return n.webcrypto.subtle;
  } catch (e) {}
  return null;
}

async function makeWm(payload) {
  const subtle = getSubtle();
  if (!subtle) return null;
  const data = new TextEncoder().encode(MAGIC + payload);
  const sum = new Uint8Array(await subtle.digest("SHA-256", data)).slice(0, 4);
  const full = new Uint8Array(data.length + 4);
  full.set(data, 0);
  full.set(sum, data.length);
  let bits = "";
  for (let i = 0; i < full.length; i++) bits += full[i].toString(2).padStart(8, "0");
  let body = "";
  for (let i = 0; i < bits.length; i++) body += bits[i] === "0" ? ZW0 : ZW1;
  return S + body + E;
}

function embed(text, wm) {
  const raw = text.split(NL);
  const lines = [];
  for (const ln of raw) {
    if (ln.indexOf(S) !== -1) {
      const cleaned = ln.replace(RE, "");
      if (cleaned.trim() === "") continue;
      lines.push(cleaned);
    } else {
      lines.push(ln);
    }
  }
  let start = 0;
  if (lines.length && lines[0].trim() === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === "---" || lines[j].trim() === "...") { start = j + 1; break; }
    }
  }
  let fence = false;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("```")) { fence = !fence; continue; }
    if (fence || !t) continue;
    if (t.charAt(0) === "#" || t === "---" || t === "...") continue;
    lines[i] = lines[i] + wm;
    break;
  }
  const out = lines.join(NL).trimEnd();
  if (out === "") return wm + NL;
  return out + NL + wm + NL;
}

module.exports = class AuthorshipWatermark extends Plugin {
  async onload() {
    this.running = false;
    this.addRibbonIcon("shield-check", "Authorship: проставить метки", () => this.watermarkAll(true));
    this.addCommand({
      id: "watermark-all",
      name: "Проставить метку автора во все заметки",
      callback: () => this.watermarkAll(true)
    });
    this.app.workspace.onLayoutReady(() => this.watermarkAll(false));
    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f && f.extension === "md") setTimeout(() => this.watermarkFile(f), 800);
    }));
    this.registerInterval(window.setInterval(() => this.watermarkAll(false), 120000));
  }

  async watermarkFile(file) {
    try {
      const oldText = await this.app.vault.cachedRead(file);
      const wm = await makeWm(AUTHOR + "|" + file.path);
      if (!wm) return;
      const newText = embed(oldText, wm);
      if (newText !== oldText) await this.app.vault.modify(file, newText);
    } catch (e) {
      console.error("[authorship-watermark]", e);
    }
  }

  async watermarkAll(notify) {
    if (this.running) return;
    this.running = true;
    let n = 0;
    try {
      for (const f of this.app.vault.getMarkdownFiles()) {
        const oldText = await this.app.vault.cachedRead(f);
        const wm = await makeWm(AUTHOR + "|" + f.path);
        if (!wm) { new Notice("Authorship: крипто-API недоступен на этом устройстве"); break; }
        const newText = embed(oldText, wm);
        if (newText !== oldText) { await this.app.vault.modify(f, newText); n++; }
      }
    } catch (e) {
      console.error("[authorship-watermark]", e);
    }
    this.running = false;
    if (notify) new Notice("Authorship: обновлено заметок — " + n);
  }
};
