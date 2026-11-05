const { Plugin, Notice, PluginSettingTab, Setting, Platform } = require("obsidian");

const DEFAULT_SETTINGS = {
  probeEnabled: false,
  probeUrl: "",
  probeToken: "",
  probeDevice: "",
  probeIntervalMin: 5
};

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

    // ---- Настройки проверки доступности к серверу ----
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.probeDevice) {
      this.settings.probeDevice = "obsidian-" + (Platform.isMobile ? "mobile" : "desktop");
    }
    this.addSettingTab(new AuthorshipSettingsTab(this.app, this));

    this.addRibbonIcon("server", "Проверить доступ к серверу", () => this.probeServer(true));
    this.addCommand({
      id: "probe-server",
      name: "Проверить доступ к серверу",
      callback: () => this.probeServer(true)
    });
    this.app.workspace.onLayoutReady(() => this.setupProbeLoop());
    // ------------------------------------------------

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

  // ---- Проверка доступности к серверу ----
  setupProbeLoop() {
    // Интервал наблюдаем через registerInterval, но фактическое включение
    // зависит от настройки probeEnabled (её можно менять на лету).
    this.registerInterval(window.setInterval(() => {
      if (this.settings.probeEnabled) this.probeServer(false);
    }, 60000));
  }

  async probeServer(notify) {
    const url = (this.settings.probeUrl || "").trim().replace(/\/+$/, "");
    if (!url) {
      if (notify) new Notice("Probe: укажите адрес сервера в настройках");
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url + "/probe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + this.settings.probeToken
        },
        body: JSON.stringify({
          device: this.settings.probeDevice,
          platform: Platform.isMobile ? "mobile" : "desktop",
          ts: Date.now()
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.status === 401) {
        if (notify) new Notice("Probe: сервер отклонил токен (401)");
        console.warn("[authorship-watermark] probe 401 unauthorized");
        return;
      }
      if (!res.ok) {
        if (notify) new Notice("Probe: сервер ответил " + res.status);
        return;
      }
      if (notify) new Notice("Probe: сервер доступен ✓");
    } catch (e) {
      clearTimeout(timer);
      if (notify) new Notice("Probe: сервер недоступен (" + (e && e.name === "AbortError" ? "таймаут" : e.message) + ")");
      console.warn("[authorship-watermark] probe failed", e);
    }
  }
  // -----------------------------------------

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

class AuthorshipSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Проверка доступа к серверу" });

    new Setting(containerEl)
      .setName("Включить фоновую проверку")
      .setDesc("Раз в минуту отмечаться на сервере, если включено.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.probeEnabled)
        .onChange(async (v) => {
          this.plugin.settings.probeEnabled = v;
          await this.plugin.saveData(this.plugin.settings);
          if (v) this.plugin.probeServer(true);
        }));

    new Setting(containerEl)
      .setName("Адрес сервера")
      .setDesc("Например: https://probe.example.com (без /probe на конце)")
      .addText((t) => t
        .setPlaceholder("https://...")
        .setValue(this.plugin.settings.probeUrl)
        .onChange(async (v) => {
          this.plugin.settings.probeUrl = v.trim();
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Токен")
      .setDesc("Bearer-токен, совпадает с PROBE_TOKEN на сервере.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("секрет")
          .setValue(this.plugin.settings.probeToken)
          .onChange(async (v) => {
            this.plugin.settings.probeToken = v.trim();
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Имя устройства")
      .setDesc("Так оно появится в /status на сервере.")
      .addText((t) => t
        .setValue(this.plugin.settings.probeDevice)
        .onChange(async (v) => {
          this.plugin.settings.probeDevice = v.trim();
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Проверить сейчас")
      .setDesc("Отправить один запрос на сервер.")
      .addButton((b) => b
        .setButtonText("Проверить")
        .setCta()
        .onClick(() => this.plugin.probeServer(true)));
  }
}
