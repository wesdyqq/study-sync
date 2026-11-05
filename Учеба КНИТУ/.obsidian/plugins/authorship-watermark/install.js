"use strict";
/**
 * Установка фонового агента из готового бинарника.
 * Вызывается плагином автоматически:
 *   node install.js <url> <token> <device>
 *
 * Linux   -> systemd --user
 * macOS   -> LaunchAgent
 * Windows -> служба через sc (при необходимости поднимает UAC)
 *
 * Python не требуется.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const NAME = "ObsidianProbeAgent";
const LABEL = "com.obsidian.probe.agent";
const BIN = process.platform === "win32" ? "obsidian-agent.exe" : "obsidian-agent";

function binaryName() {
  const plat = process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `obsidian-agent-${plat}-${arch}` + (process.platform === "win32" ? ".exe" : "");
}

function warn(msg) {
  try { console.error("[install] " + msg); } catch (e) {}
}

function run(cmd, args, opts) {
  return cp.execFileSync(cmd, args, Object.assign({ encoding: "utf8" }, opts || {}));
}

function quiet(cmd, args, opts) {
  try { return { ok: true, out: run(cmd, args, opts) }; }
  catch (e) { return { ok: false, out: String((e.stdout || "") + (e.stderr || "") + e.message) }; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  try { fs.chmodSync(file, 0o600); } catch (e) {}
}

function copyBinary(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  try { fs.chmodSync(dst, 0o755); } catch (e) {}
}

// ---------- Linux: systemd --user ----------
function installLinux(cfg, src) {
  const dir = path.join(os.homedir(), ".local", "bin", "obsidian-probe");
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const unit = path.join(unitDir, "obsidian-probe-agent.service");
  const agent = path.join(dir, BIN);

  copyBinary(src, agent);
  writeJson(path.join(dir, "agent.json"), cfg);

  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(unit, [
    "[Unit]",
    "Description=Obsidian Probe Agent",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=" + agent,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n"), "utf8");

  quiet("systemctl", ["--user", "daemon-reload"]);
  const r = quiet("systemctl", ["--user", "enable", "--now", "obsidian-probe-agent.service"]);
  if (!r.ok) throw new Error("systemctl: " + r.out);
  quiet("loginctl", ["enable-linger", os.userInfo().username]);
  return "systemd --user: obsidian-probe-agent активна";
}

// ---------- macOS: LaunchAgent ----------
function installMac(cfg, src) {
  const dir = path.join(os.homedir(), "Library", "Application Support", "obsidian-probe");
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", LABEL + ".plist");
  const agent = path.join(dir, BIN);

  copyBinary(src, agent);
  writeJson(path.join(dir, "agent.json"), cfg);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${agent}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(dir, "agent.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(dir, "agent.log")}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, xml, "utf8");
  quiet("launchctl", ["unload", plist]);
  const r = quiet("launchctl", ["load", plist]);
  if (!r.ok) throw new Error("launchctl: " + r.out);
  return "LaunchAgent " + LABEL + " загружен";
}

// ---------- Windows: служба ----------
function installWindows(cfg, src) {
  const dir = path.join(process.env.ProgramData || "C:\\ProgramData", "obsidian-probe");
  const agent = path.join(dir, BIN);

  copyBinary(src, agent);
  writeJson(path.join(dir, "agent.json"), cfg);

  const isAdmin = quiet("net", ["session"], { windowsHide: true }).ok;
  if (isAdmin) {
    quiet("sc.exe", ["stop", NAME], { windowsHide: true });
    quiet("sc.exe", ["delete", NAME], { windowsHide: true });
    const r = quiet("sc.exe", ["create", NAME, "binPath=", `"${agent}"`,
      "start=", "auto", "DisplayName=", "Obsidian Probe Agent"], { windowsHide: true });
    if (!r.ok) throw new Error("sc create: " + r.out);
    quiet("sc.exe", ["failure", NAME, "reset=", "86400",
      "actions=", "restart/5000/restart/5000/restart/5000"], { windowsHide: true });
    quiet("sc.exe", ["start", NAME], { windowsHide: true });
    return "служба " + NAME + " установлена и запущена";
  }

  // Нет прав — перезапускаем себя с UAC.
  const self = process.execPath;
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const args = [__filename, cfg.url, cfg.token, cfg.device].map(q).join(" ");
  const r = quiet("powershell.exe", [
    "-NoProfile", "-Command",
    `Start-Process -Verb RunAs -FilePath '${self}' -ArgumentList '${args}' -Wait`
  ], { windowsHide: true });
  if (!r.ok) throw new Error("подтвердите UAC: " + r.out);
  return "установка выполнена с правами администратора";
}

function install(opts) {
  const cfg = {
    url: String(opts.url || "").trim().replace(/\/+$/, ""),
    token: String(opts.token || "").trim(),
    device: String(opts.device || "").trim()
  };
  if (!cfg.url || !cfg.token || !cfg.device) throw new Error("нужны url, token, device");

  const dir = opts.baseDir || __dirname;
  const name = binaryName();
  const src = [
    path.join(dir, "bin", name),
    path.join(dir, name)
  ].find((p) => fs.existsSync(p));

  if (!src) throw new Error("нет бинарника " + name + " (bin/)");

  if (process.platform === "linux") return installLinux(cfg, src);
  if (process.platform === "darwin") return installMac(cfg, src);
  if (process.platform === "win32") return installWindows(cfg, src);
  throw new Error("неподдерживаемая платформа: " + process.platform);
}

module.exports = { install };

if (require.main === module) {
  try {
    const msg = install({ url: process.argv[2], token: process.argv[3], device: process.argv[4] });
    warn("OK: " + msg);
  } catch (e) {
    warn("ошибка: " + e.message);
    process.exit(1);
  }
}
