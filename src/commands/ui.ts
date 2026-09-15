import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AccountStore } from "../account-store/index.js";
import { ensureAccountName } from "../account-store/storage.js";
import type { AuthSnapshot } from "../auth-snapshot.js";
import { findAuthReloginError, runAuthRefreshSweep } from "../auth-refresh.js";
import type { CodexLoginProvider } from "../codex-login.js";
import type { CodexDesktopLauncher } from "../desktop/launcher.js";
import {
  restartManagedDesktopSession,
  type ManagedDesktopRestartOutcome,
} from "../desktop/managed-state.js";
import { describeDesktopNotFound } from "../desktop/shared.js";
import { getPlatform, type CodexmPlatform } from "../platform.js";
import { ensureNotReservedProxyAccountName } from "../proxy/constants.js";
import { resolveManagedDesktopApiBaseUrl } from "../proxy/runtime.js";
import {
  deleteRemoteAccount,
  listRemoteAccounts,
  readRemotesFile,
  resolveRemote,
} from "../registry/client.js";
import {
  describeBusySwitchLock,
  refreshManagedDesktopAfterSwitch,
  stripManagedDesktopWarning,
  switchAccountPreservingProxyRuntime,
  tryAcquireSwitchLock,
} from "../switching.js";
import { isTraySupported, startTray, type TrayAction, type TrayHost } from "../tray/index.js";
import { syncAccountsToRemote } from "./remote.js";
import {
  resolveRegistryClientId,
  runAutoSyncLoop,
  runAutoSyncOnce,
  type AutoSyncRunResult,
} from "./autosync.js";

type DebugLogger = (message: string) => void;

/**
 * The console is its own presentation surface: it renders raw quota values
 * (percent used, reset times) instead of the terminal color/truncation rules
 * in `src/cli/quota-display.ts`. All state transitions still go through the
 * shared store/paths used by the CLI.
 */

function renderPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codexm 控制台</title>
<style>
  :root {
    --bg: #0b0f17;
    --panel: #131a26;
    --panel-2: #182131;
    --line: #24303f;
    --text: #e6edf6;
    --muted: #8b9bb0;
    --accent: #5b8cff;
    --ok: #3fb950;
    --warn: #d9a03a;
    --hot: #f0603a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: radial-gradient(1200px 600px at 20% -10%, #17233a 0%, var(--bg) 60%);
    color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 20px 28px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: rgba(11,15,23,.85); backdrop-filter: blur(8px);
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: .2px; }
  h1 span { color: var(--muted); font-weight: 400; }
  .meta { color: var(--muted); font-size: 12.5px; }
  .spacer { flex: 1; }
  button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer;
    transition: border-color .15s, background .15s, transform .05s;
  }
  button:hover { border-color: var(--accent); }
  button:active { transform: translateY(1px); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #08101f; font-weight: 600; }
  button:disabled { opacity: .5; cursor: default; }
  button.danger {
    background: transparent; border-color: rgba(255,86,86,.45); color: #ff9a9a;
  }
  button.danger:hover { border-color: var(--hot); background: rgba(255,86,86,.12); }
  button.danger.armed { background: var(--hot); border-color: var(--hot); color: #20090a; font-weight: 600; }
  main { padding: 24px 28px 48px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  .card {
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
    border: 1px solid var(--line); border-radius: 14px; padding: 18px;
  }
  .card.current { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(91,140,255,.25); }
  .card-top { display: flex; align-items: baseline; gap: 10px; position: relative; }
  .name { font-size: 16px; font-weight: 650; }
  .icon-btn {
    background: transparent; border-color: transparent; color: var(--muted);
    padding: 0 6px; font-size: 18px; line-height: 1.1; align-self: center;
  }
  .icon-btn:hover { color: var(--text); border-color: var(--line); }
  .menu {
    position: absolute; top: 24px; right: 0; z-index: 5; min-width: 148px; padding: 6px;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 12px 30px rgba(0,0,0,.5); display: grid; gap: 2px;
  }
  .menu.hidden { display: none; }
  .menu-item {
    width: 100%; text-align: left; background: transparent; border: none;
    padding: 8px 10px; border-radius: 7px; font-size: 13px;
  }
  .menu-item:hover { background: rgba(91,140,255,.16); }
  .menu-item.danger { color: #ff9a9a; }
  .menu-item.danger:hover { background: rgba(255,86,86,.16); }
  .menu-item.danger.armed { background: var(--hot); color: #20090a; font-weight: 600; }
  .badge {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted); text-transform: uppercase; letter-spacing: .4px;
  }
  .badge.live { color: var(--ok); border-color: rgba(63,185,80,.4); }
  .badge.hot { color: var(--hot); border-color: rgba(255,86,86,.45); }
  .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .meters { margin: 16px 0 14px; display: grid; gap: 12px; }
  .meter-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  .track { height: 7px; background: #0c121c; border-radius: 999px; overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; transition: width .4s ease; }
  .fill.ok { background: var(--ok); }
  .fill.warn { background: var(--warn); }
  .fill.hot { background: var(--hot); }
  .card-actions { display: flex; gap: 8px; }
  .empty { color: var(--muted); padding: 40px 28px; }
  #toast {
    position: fixed; right: 20px; bottom: 20px; display: grid; gap: 8px; z-index: 10;
  }
  .toast {
    background: var(--panel-2); border: 1px solid var(--line); border-left: 3px solid var(--accent);
    border-radius: 10px; padding: 10px 14px; font-size: 13px; max-width: 420px;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
  }
  .toast.error { border-left-color: var(--hot); }
  .toast.good { border-left-color: var(--ok); }
  .toast.warn { border-left-color: var(--warn); }
  .modal { position: fixed; inset: 0; background: rgba(3,6,12,.72); display: grid; place-items: center; z-index: 20; padding: 20px; }
  .modal.hidden { display: none; }
  .modal-card {
    width: min(440px, 100%); background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; padding: 20px; display: grid; gap: 14px;
  }
  .modal-card h2 { margin: 0; font-size: 15px; }
  .field { display: grid; gap: 6px; }
  .field label { color: var(--muted); font-size: 12px; }
  input, select {
    background: #0c121c; color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 9px 11px; font-size: 13px; width: 100%;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  input.invalid { border-color: var(--hot); }
  input.invalid:focus { border-color: var(--hot); box-shadow: 0 0 0 2px rgba(255,86,86,.2); }
  .field-error {
    display: none; color: #ff9a9a; font-size: 12px; padding: 8px 11px;
    background: rgba(255,86,86,.1); border: 1px solid rgba(255,86,86,.35);
    border-left: 3px solid var(--hot); border-radius: 8px;
  }
  .field-error.show { display: block; }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-5px); }
    75% { transform: translateX(5px); }
  }
  .shake { animation: shake .16s ease-in-out 0s 2; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .code {
    font-size: 24px; letter-spacing: 3px; font-weight: 650; text-align: center;
    padding: 10px; background: #0c121c; border: 1px solid var(--line); border-radius: 10px;
  }
</style>
</head>
<body>
<header>
  <h1>codexm <span>控制台</span></h1>
  <div class="meta" id="meta">加载中…</div>
  <div class="spacer"></div>
  <button id="addBtn" class="primary">添加账号</button>
  <button id="relaunchBtn">重启桌面端</button>
  <button id="refreshBtn">刷新配额</button>
  <button id="syncBtn">同步到 registry</button>
  <button id="quitBtn">退出</button>
</header>
<main id="grid"></main>
<div id="toast"></div>
<div id="addModal" class="modal hidden">
  <div class="modal-card">
    <h2>添加账号</h2>
    <div class="field">
      <label for="addName">账号名称</label>
      <input id="addName" autocomplete="off" placeholder="例如 work-plus">
    </div>
    <div class="field-error" id="addError"></div>
    <!-- Login is always the browser callback now; device / apikey stay wired up
         behind addMethod and the server for when they are needed again. -->
    <div class="field" style="display:none">
      <label for="addMethod">登录方式</label>
      <select id="addMethod">
        <option value="device">设备码登录（推荐）</option>
        <option value="browser">浏览器回调登录（控制台在本机时）</option>
        <option value="apikey">API key</option>
      </select>
    </div>
    <div class="field" id="addKeyField" style="display:none">
      <label for="addKey">OpenAI API key</label>
      <input id="addKey" type="password" autocomplete="off" placeholder="sk-...">
    </div>
    <div class="field" id="addCodeField" style="display:none">
      <label>在浏览器打开 <a id="addVerifyLink" href="#" target="_blank" rel="noreferrer">授权页面</a> 并输入下面的设备码</label>
      <div class="code" id="addCode">…</div>
      <div class="sub" id="addStatus">等待确认…</div>
    </div>
    <div class="field" id="addLinkField" style="display:none">
      <label>在浏览器里完成 ChatGPT 登录，授权后会自动回到控制台</label>
      <div><a id="addAuthorizeLink" href="#" target="_blank" rel="noreferrer">重新打开授权页面</a></div>
      <div class="sub" id="addLinkStatus">等待浏览器回调…</div>
    </div>
    <div class="modal-actions">
      <button id="addCancelBtn">取消</button>
      <button id="addSubmitBtn" class="primary">开始</button>
    </div>
  </div>
</div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  const grid = document.getElementById("grid");
  const meta = document.getElementById("meta");
  const toastBox = document.getElementById("toast");
  let busy = false;

  function toast(message, kind) {
    const node = document.createElement("div");
    node.className = "toast" + (kind ? " " + kind : "");
    node.textContent = message;
    toastBox.appendChild(node);
    setTimeout(() => node.remove(), 5000);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function api(path, method, body) {
    // Paths may already carry a query (status polling passes flowId).
    return fetch(path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token), {
      method: method || "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(async function (response) {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || ("请求失败（" + response.status + "）"));
      }
      return payload;
    });
  }

  function level(used) {
    if (used == null) return "ok";
    return used >= 80 ? "hot" : used >= 50 ? "warn" : "ok";
  }

  function meter(label, window) {
    if (!window) return "";
    const used = window.used_percent == null ? null : Math.max(0, Math.min(100, Math.round(window.used_percent)));
    const remaining = used == null ? null : 100 - used;
    return '<div>' +
      '<div class="meter-label"><span>' + esc(label) + '</span><span>' +
        (used == null ? "—" : "剩余 " + remaining + "%") +
      '</span></div>' +
      '<div class="track"><div class="fill ' + level(used) + '" style="width:' + (used == null ? 0 : used) + '%"></div></div>' +
      '</div>';
  }

  function resetHint(value) {
    if (!value) return "";
    const date = new Date(value);
    if (isNaN(date.getTime())) return "";
    const minutes = Math.round((date.getTime() - Date.now()) / 60000);
    if (minutes <= 0) return "即将重置";
    if (minutes < 60) return minutes + " 分钟后重置";
    const hours = Math.round(minutes / 60);
    return hours < 24 ? hours + " 小时后重置" : Math.round(hours / 24) + " 天后重置";
  }

  function render(state) {
    const accounts = state.accounts || [];
    meta.textContent = accounts.length + " 个账号 · " +
      (state.remote ? "registry " + state.remote.name + "（" + (state.remote.accounts || []).length + " 个）" : "未配置 registry") +
      (state.warnings && state.warnings.length ? " · " + state.warnings.length + " 条警告" : "");

    if (!accounts.length) {
      grid.innerHTML = '<div class="empty">还没有托管账号。点右上角「添加账号」，或用 <code>codexm save</code> / <code>codexm import</code>。</div>';
      return;
    }

    grid.innerHTML = accounts.map(function (account) {
      const quota = account.quota || {};
      const five = quota.five_hour || null;
      const week = quota.one_week || null;
      const plan = quota.plan_type || account.auth_mode || "—";
      const status = quota.status || "unknown";
      const statusLabel = status === "ok" ? "可用" : status === "stale" ? "数据陈旧" :
        status === "error" ? "不可用" : status === "unsupported" ? "不支持配额" : "未知";
      const blocked = status === "error" || status === "unsupported";
      const relogin = !!account.relogin_error;
      const errorText = relogin ? "登录态已失效，请重新登录" : quota.error_message;
      return '<div class="card' + (account.current ? " current" : "") + '">' +
        '<div class="card-top">' +
          '<div class="name">' + esc(account.name) + '</div>' +
          '<div class="badge' + (relogin ? " hot" : account.current ? " live" : "") + '">' +
            esc(relogin ? "需要重新登录" : account.current ? "使用中" : statusLabel) + '</div>' +
          '<div class="spacer"></div>' +
          '<button class="icon-btn" data-menu="' + esc(account.name) + '" title="更多操作" aria-label="更多操作">⋯</button>' +
          '<div class="menu hidden">' +
            '<button class="menu-item danger" data-remove="' + esc(account.name) + '">删除账号</button>' +
          '</div>' +
        '</div>' +
        '<div class="sub">' + esc(plan) + ' · ' + esc(account.account_id || "无账号 ID") +
          (blocked && errorText ? " · " + esc(errorText) : "") + '</div>' +
        '<div class="meters">' +
          meter("5 小时" + (five ? " · " + resetHint(five.reset_at) : ""), five) +
          meter("每周" + (week ? " · " + resetHint(week.reset_at) : ""), week) +
        '</div>' +
        '<div class="card-actions">' +
          (relogin
            ? '<button class="primary" data-relogin="' + esc(account.name) + '">重新登录</button>'
            : '<button class="primary" data-switch="' + esc(account.name) + '"' + (account.current ? " disabled" : "") + '>' +
              (account.current ? "使用中" : "切换到此账号") +
            '</button>') +
        '</div>' +
      '</div>';
    }).join("");
  }

  async function reload() {
    try {
      render(await api("/api/state"));
    } catch (error) {
      meta.textContent = "不可用";
      toast(error.message, "error");
    }
  }

  async function act(path, body, message) {
    if (busy) return;
    busy = true;
    try {
      const payload = await api(path, "POST", body || {});
      toast(payload.message || message || "完成", "good");
      (payload.warnings || []).forEach(function (warning) {
        toast(warning, "warn");
      });
      await reload();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      busy = false;
    }
  }

  // Deleting a managed account drops its auth snapshot for good, so the first
  // click only arms the menu item; a second click (or nothing) is what removes it.
  let armedRemove = null;
  let armTimer = null;
  let openMenu = null;

  function disarmRemove() {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    if (!armedRemove) return;
    armedRemove.classList.remove("armed");
    armedRemove.textContent = "删除账号";
    armedRemove = null;
  }

  function armRemove(button, name) {
    disarmRemove();
    armedRemove = button;
    button.classList.add("armed");
    button.textContent = "确认删除 " + name;
    armTimer = setTimeout(disarmRemove, 6000);
  }

  function closeMenu() {
    disarmRemove();
    if (!openMenu) return;
    openMenu.classList.add("hidden");
    openMenu = null;
  }

  function toggleMenu(button) {
    const panel = button.parentElement.querySelector(".menu");
    if (!panel) return;
    if (openMenu === panel) {
      closeMenu();
      return;
    }
    closeMenu();
    panel.classList.remove("hidden");
    openMenu = panel;
  }

  grid.addEventListener("click", function (event) {
    const relogin = event.target.closest("button[data-relogin]");
    if (relogin) {
      closeMenu();
      openAddModal(relogin.getAttribute("data-relogin"));
      showAddError("该账号的登录态已失效。重新登录会用新的登录态覆盖同名账号。");
      return;
    }
    const menuButton = event.target.closest("button[data-menu]");
    if (menuButton) {
      toggleMenu(menuButton);
      return;
    }
    const remove = event.target.closest("button[data-remove]");
    if (remove) {
      const name = remove.getAttribute("data-remove");
      if (armedRemove !== remove) {
        armRemove(remove, name);
        return;
      }
      disarmRemove();
      closeMenu();
      act("/api/accounts/remove", { name: name }, "已删除账号");
      return;
    }
    closeMenu();
    const target = event.target.closest("button[data-switch]");
    if (!target) return;
    act("/api/switch", { name: target.getAttribute("data-switch") }, "已切换");
  });

  document.addEventListener("click", function (event) {
    if (!openMenu) return;
    if (event.target.closest("button[data-menu]") || event.target.closest(".menu")) return;
    closeMenu();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenu();
  });

  async function relaunchDesktop(allowNonManaged) {
    if (busy) return;
    busy = true;
    const button = document.getElementById("relaunchBtn");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "重启中…";
    try {
      const payload = await api("/api/desktop/relaunch", "POST", { allowNonManaged: !!allowNonManaged });
      if (payload.requires_confirmation) {
        if (window.confirm(payload.message)) {
          busy = false;
          await relaunchDesktop(true);
        }
        return;
      }
      toast(payload.message || "已重启 Codex Desktop", "good");
      (payload.warnings || []).forEach(function (warning) {
        toast(warning, "warn");
      });
      await reload();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = label;
    }
  }

  document.getElementById("relaunchBtn").addEventListener("click", function () {
    relaunchDesktop(false);
  });
  document.getElementById("refreshBtn").addEventListener("click", function () {
    act("/api/refresh", {}, "配额已刷新");
  });
  document.getElementById("syncBtn").addEventListener("click", function () {
    act("/api/sync", {}, "同步完成");
  });
  const addModal = document.getElementById("addModal");
  const addName = document.getElementById("addName");
  const addMethod = document.getElementById("addMethod");
  const addKeyField = document.getElementById("addKeyField");
  const addKey = document.getElementById("addKey");
  const addCodeField = document.getElementById("addCodeField");
  const addCode = document.getElementById("addCode");
  const addStatus = document.getElementById("addStatus");
  const addVerifyLink = document.getElementById("addVerifyLink");
  const addLinkField = document.getElementById("addLinkField");
  const addAuthorizeLink = document.getElementById("addAuthorizeLink");
  const addLinkStatus = document.getElementById("addLinkStatus");
  const addError = document.getElementById("addError");
  const addSubmitBtn = document.getElementById("addSubmitBtn");
  let addPoller = null;
  let addFlowId = "";
  let addForceOverwrite = false;

  function clearAddError() {
    addError.classList.remove("show");
    addError.textContent = "";
    addName.classList.remove("invalid");
    addKey.classList.remove("invalid");
  }

  /**
   * Browser callback flows need a user-gesture window, so the tab is opened while the
   * click is still fresh and navigated once the authorize URL comes back.
   */
  let authorizeWindow = null;
  let authorizeWindowBlank = false;

  function prepareAuthorizeWindow() {
    if (addMethod.value !== "browser") {
      return;
    }
    const win = window.open("", "_blank");
    if (!win) {
      return;
    }
    authorizeWindow = win;
    authorizeWindowBlank = true;
    try {
      win.document.write("<title>正在打开授权页面…</title>正在打开 OpenAI 授权页面…");
      win.document.close();
    } catch (error) {
      /* ignore cross-origin write failures */
    }
  }

  function navigateAuthorizeWindow(url) {
    if (authorizeWindow && !authorizeWindow.closed) {
      authorizeWindow.location.href = url;
      authorizeWindowBlank = false;
      return true;
    }
    const win = window.open(url, "_blank");
    if (!win) {
      return false;
    }
    authorizeWindow = win;
    authorizeWindowBlank = false;
    return true;
  }

  /** Closes the placeholder tab only; a tab already on the authorize page stays open. */
  function dropAuthorizeWindow() {
    if (authorizeWindow && authorizeWindowBlank && !authorizeWindow.closed) {
      authorizeWindow.close();
    }
    authorizeWindow = null;
    authorizeWindowBlank = false;
  }

  /**
   * A failed start used to blink the placeholder tab away with no explanation.
   * The tab is already open, so write the reason into it and leave it alone.
   */
  function failAuthorizeWindow(message) {
    if (!authorizeWindow || authorizeWindow.closed) {
      authorizeWindow = null;
      authorizeWindowBlank = false;
      return false;
    }

    try {
      const doc = authorizeWindow.document;
      doc.title = "登录未能开始";
      doc.body.textContent = "";
      const heading = doc.createElement("p");
      heading.textContent = "登录未能开始，请回到 codexm 控制台查看并重试：";
      const detail = doc.createElement("pre");
      detail.style.whiteSpace = "pre-wrap";
      detail.textContent = message;
      doc.body.append(heading, detail);
    } catch {
      /* cross-origin writes are not fatal */
    }

    // Keep the tab: it is now the only place showing why nothing happened.
    authorizeWindow = null;
    authorizeWindowBlank = false;
    return true;
  }

  function showAddError(message, target) {
    addError.textContent = message;
    addError.classList.add("show");
    if (!target) {
      return;
    }
    target.classList.add("invalid");
    target.classList.remove("shake");
    void target.offsetWidth;
    target.classList.add("shake");
    setTimeout(function () {
      target.classList.remove("shake");
    }, 420);
    target.focus();
  }

  /** Keeps the complaint inside the open dialog; the toast is easy to miss. */
  function notifyAddError(message, target) {
    if (addModal.classList.contains("hidden")) {
      toast(message, "error");
      return;
    }
    showAddError(message, target);
  }

  /**
   * Once a flow dies, the authorize link still points at the consumed URL and
   * its callback would hit a missing flowId — drop the block until a retry
   * produces a fresh link.
   */
  function hideStaleAddAuthorizeLink() {
    addLinkField.style.display = "none";
  }

  function cancelAddFlow(flowId) {
    if (!flowId) {
      return;
    }
    api("/api/accounts/add/cancel", "POST", { flowId: flowId }).catch(function () {});
  }

  /** True once the tab that was supposed to finish the login is gone. */
  function authorizeTabClosed() {
    return !!authorizeWindow && authorizeWindow.closed;
  }

  /**
   * Closing the authorize tab strands the flow: nobody calls back, so it stays
   * pending forever and keeps the loopback callback port bound — which makes
   * the next attempt fail to bind it. End it instead of waiting.
   */
  function abandonAddFlow(message) {
    const flowId = addFlowId;
    stopAddPoller();
    addFlowId = "";
    authorizeWindow = null;
    authorizeWindowBlank = false;
    cancelAddFlow(flowId);
    addSubmitBtn.disabled = false;
    addSubmitBtn.textContent = "重试";
    hideStaleAddAuthorizeLink();
    notifyAddError(message);
  }

  function stopAddPoller() {
    if (addPoller) {
      clearInterval(addPoller);
      addPoller = null;
    }
  }

  function closeAddModal() {
    stopAddPoller();
    dropAuthorizeWindow();
    addModal.classList.add("hidden");
  }

  function openAddModal(prefillName) {
    // Re-login is replacing a known account by definition, so the "overwrite
    // the same name?" prompt is noise — and its native dialog interrupts the
    // click that opened the authorize tab.
    addForceOverwrite = typeof prefillName === "string" && prefillName !== "";
    addName.value = typeof prefillName === "string" ? prefillName : "";
    addKey.value = "";
    addMethod.value = "browser";
    addKeyField.style.display = "none";
    addCodeField.style.display = "none";
    addLinkField.style.display = "none";
    addSubmitBtn.disabled = false;
    addSubmitBtn.textContent = "开始";
    clearAddError();
    addModal.classList.remove("hidden");
    addName.focus();
  }

  addMethod.addEventListener("change", function () {
    addKeyField.style.display = addMethod.value === "apikey" ? "" : "none";
    clearAddError();
  });

  addName.addEventListener("input", clearAddError);
  addKey.addEventListener("input", clearAddError);

  document.getElementById("addBtn").addEventListener("click", function () {
    openAddModal();
  });

  document.getElementById("addCancelBtn").addEventListener("click", function () {
    cancelAddFlow(addFlowId);
    addFlowId = "";
    closeAddModal();
  });

  /**
   * A fresh login only replaces the auth snapshot; the quota numbers on the card
   * still belong to the previous session (or to the failure), so refresh just
   * this account instead of waiting for the next sweep.
   */
  async function finishAdd(name, warnings) {
    await reload();
    (warnings || []).forEach(function (warning) {
      toast(warning, "warn");
    });
    if (!name) return;
    try {
      await api("/api/refresh", "POST", { name: name });
    } catch {
      /* the account is saved either way; the next refresh will show it */
    }
    await reload();
  }

  async function submitAdd(force) {
    const name = addName.value.trim();
    if (!name) {
      showAddError("请填写账号名称，例如 work-plus", addName);
      return;
    }

    if (addMethod.value === "apikey" && !addKey.value.trim()) {
      showAddError("请填写 OpenAI API key", addKey);
      return;
    }

    clearAddError();
    addSubmitBtn.disabled = true;
    try {
      const payload = await api("/api/accounts/add", "POST", {
        name: name,
        method: addMethod.value || "browser",
        apiKey: addMethod.value === "apikey" ? addKey.value.trim() : undefined,
        force: !!force || addForceOverwrite,
      });

      if (payload.requires_confirmation) {
        if (!window.confirm(payload.message)) {
          addSubmitBtn.disabled = false;
          dropAuthorizeWindow();
          return;
        }
        await submitAdd(true);
        return;
      }

      if (payload.status === "added") {
        toast(payload.message, "good");
        addFlowId = "";
        closeAddModal();
        await finishAdd(payload.account ? payload.account.name : "", payload.warnings);
        return;
      }

      addFlowId = payload.flowId;

      if (payload.mode === "browser") {
        addAuthorizeLink.href = payload.authorizeUrl;
        addLinkField.style.display = "";
        const opened = navigateAuthorizeWindow(payload.authorizeUrl);
        addLinkStatus.textContent = opened
          ? "已在新标签页打开授权页面，登录完成后会自动继续。"
          : "浏览器拦截了自动打开，请点击上面的链接完成登录。";
      } else {
        addCode.textContent = payload.userCode;
        addVerifyLink.href = payload.verificationUrl;
        addCodeField.style.display = "";
        addStatus.textContent = "等待浏览器确认…";
      }
      addSubmitBtn.textContent = "等待确认…";
      stopAddPoller();
      addPoller = setInterval(pollAdd, 2000);
    } catch (error) {
      const message = error.message;
      const written = failAuthorizeWindow(message);
      hideStaleAddAuthorizeLink();
      notifyAddError(written ? message + "（原因也写在刚打开的标签页里）" : message);
      addSubmitBtn.disabled = false;
    }
  }

  async function pollAdd() {
    if (!addFlowId) return;

    try {
      const payload = await api("/api/accounts/add/status?flowId=" + encodeURIComponent(addFlowId));
      addStatus.textContent = payload.message;
      addLinkStatus.textContent = authorizeWindow && !authorizeWindow.closed
        ? "已在新标签页打开授权页面，登录完成后会自动继续。"
        : payload.message;

      if (payload.status === "done") {
        stopAddPoller();
        addFlowId = "";
        toast(payload.message, "good");
        closeAddModal();
        await finishAdd(payload.account ? payload.account.name : "", payload.warnings);
        return;
      }

      if (payload.status === "error") {
        stopAddPoller();
        addFlowId = "";
        addSubmitBtn.disabled = false;
        addSubmitBtn.textContent = "重试";
        // The flow is dead on the server; the link still points at the old
        // authorize URL, whose callback would land on a missing flowId.
        hideStaleAddAuthorizeLink();
        const written = failAuthorizeWindow(payload.message);
        notifyAddError(written
          ? payload.message + "（原因也写在打开的标签页里）"
          : payload.message);
        return;
      }

      if (payload.status === "pending" && authorizeTabClosed()) {
        abandonAddFlow("授权页面已关闭，登录流程已取消。点「重试」重新打开授权页面。");
      }
    } catch (error) {
      stopAddPoller();
      addFlowId = "";
      addSubmitBtn.disabled = false;
      hideStaleAddAuthorizeLink();
      failAuthorizeWindow(error.message);
      notifyAddError(error.message);
    }
  }

  addSubmitBtn.addEventListener("click", function () {
    if (!addName.value.trim()) {
      showAddError("请填写账号名称，例如 work-plus", addName);
      return;
    }
    if (addMethod.value === "apikey" && !addKey.value.trim()) {
      showAddError("请填写 OpenAI API key", addKey);
      return;
    }
    prepareAuthorizeWindow();
    submitAdd(false);
  });

  document.getElementById("quitBtn").addEventListener("click", async function () {
    try { await api("/api/quit", "POST", {}); } catch (error) { /* server is gone */ }
    document.body.innerHTML = '<div class="empty">控制台已停止，可以关闭此标签页。</div>';
  });

  reload();
  setInterval(reload, 5000);
</script>
</body>
</html>`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function buildState(store: AccountStore): Promise<Record<string, unknown>> {
  const { accounts, warnings } = await store.listAccounts();
  const current = await store.getCurrentStatus();
  const currentNames = new Set(current.matched_accounts ?? []);

  let remote: { name: string; accounts: unknown[] } | null = null;
  try {
    const resolved = await resolveRemote(store, null);
    remote = { name: resolved.name, accounts: await listRemoteAccounts(resolved.config) };
  } catch {
    remote = null;
  }

  return {
    accounts: accounts.map((account) => ({
      name: account.name,
      auth_mode: account.auth_mode,
      account_id: account.account_id,
      current: currentNames.has(account.name),
      updated_at: account.updated_at,
      quota: account.quota,
      relogin_error: findAuthReloginError(account),
    })),
    current: {
      exists: current.exists,
      managed: current.managed,
      identity: current.identity,
      matched_accounts: current.matched_accounts ?? [],
    },
    remote,
    warnings,
  };
}

function formatRefreshMessage(sweep: { refreshed: unknown[]; failed: unknown[]; skipped: unknown[] }): string {
  return `刷新成功 ${sweep.refreshed.length} 个，失败 ${sweep.failed.length} 个，跳过 ${sweep.skipped.length} 个。`;
}

function formatSyncMessage(summary: { pushed: number; skipped: number; failed: number }): string {
  return `同步完成：推送 ${summary.pushed} 个，跳过 ${summary.skipped} 个，失败 ${summary.failed} 个。`;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Never fail the console just because a browser could not be launched.
  }
}

async function handleTrayAction(options: {
  action: TrayAction;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  desktopLauncher?: CodexDesktopLauncher;
  url: string;
  shutdown: () => void;
  debugLog?: DebugLogger;
}): Promise<void> {
  const { action, store, stdout, url, shutdown } = options;

  if (action === "open") {
    openBrowser(url);
    return;
  }
  if (action === "quit") {
    shutdown();
    return;
  }

  try {
    if (action === "relaunch-desktop") {
      // The tray cannot ask a follow-up question: clicking "Restart Desktop"
      // *is* the confirmation, including for a Desktop codexm did not start.
      const result = await performDesktopRelaunch({
        store,
        desktopLauncher: options.desktopLauncher,
        debugLog: options.debugLog,
        allowNonManaged: true,
      });
      stdout.write(`${result.message}\n`);
      for (const warning of result.warnings) {
        stdout.write(`${warning}\n`);
      }
      return;
    }
    if (action === "refresh") {
      stdout.write(`${formatRefreshMessage(await runAuthRefreshSweep({ store }))}\n`);
      return;
    }
    stdout.write(`${formatSyncMessage(await syncAccountsToRemote({ store }))}\n`);
  } catch (error) {
    const message = (error as Error).message;
    options.debugLog?.(`ui tray ${action}: ${message}`);
    stdout.write(`托盘操作失败：${message}\n`);
  }
}

async function waitForTrayReady(host: TrayHost, timeoutMs = 8000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      host.ready.then(
        () => resolve(true),
        () => resolve(false),
      );
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export type UiSwitchDesktopOutcome =
  | "applied"
  | "restarted"
  | "killed"
  | "none"
  | "other-running"
  | "failed"
  | "skipped-proxy"
  | "skipped-no-launcher";

export interface UiSwitchResult {
  message: string;
  warnings: string[];
  proxy_retained: boolean;
  desktop_refresh: UiSwitchDesktopOutcome;
}

/**
 * Console switches follow the same Desktop contract as `codexm switch`: local
 * auth moves first, then a codexm-managed Desktop picks the auth up — in place
 * where DevTools allow it, by restarting the managed session on Windows. A
 * Desktop started outside codexm is never touched, so the caller surfaces a
 * warning instead of implying the running session updated.
 */
export async function performUiSwitch(options: {
  store: AccountStore;
  name: string;
  desktopLauncher?: CodexDesktopLauncher;
  debugLog?: DebugLogger;
  /** Override platform detection for tests. */
  platform?: CodexmPlatform;
}): Promise<UiSwitchResult> {
  const lock = await tryAcquireSwitchLock(options.store, `ui switch ${options.name}`);
  if (!lock.acquired) {
    throw new Error(describeBusySwitchLock(lock.lockPath, lock.owner));
  }

  try {
    const switched = await switchAccountPreservingProxyRuntime({
      store: options.store,
      name: options.name,
    });
    const warnings = stripManagedDesktopWarning([...switched.result.warnings]);

    if (switched.proxyRetained) {
      options.debugLog?.("ui switch: proxy runtime active, leaving Desktop untouched");
      return {
        message: `已切换到「${options.name}」（代理上游已更新，请求立即走新账号）。`,
        warnings,
        proxy_retained: true,
        desktop_refresh: "skipped-proxy",
      };
    }

    if (!options.desktopLauncher) {
      return {
        message: `已切换到「${options.name}」。`,
        warnings,
        proxy_retained: false,
        desktop_refresh: "skipped-no-launcher",
      };
    }

    const outcome = await refreshManagedDesktopAfterSwitch(warnings, options.desktopLauncher, {
      onStatusMessage: (message) => options.debugLog?.(`ui switch desktop: ${message}`),
      platform: options.platform,
    });
    options.debugLog?.(`ui switch: desktop refresh outcome=${outcome}`);

    const message =
      outcome === "applied"
        ? `已切换到「${options.name}」，已应用到受管的 Codex Desktop 会话。`
        : outcome === "restarted"
          ? `已切换到「${options.name}」，已重启受管的 Codex Desktop 会话以应用新账号。`
          : outcome === "other-running"
          ? `已切换到「${options.name}」，但运行中的 Codex Desktop 不是 codexm 启动的，仍在使用旧登录态。`
          : outcome === "none"
            ? `已切换到「${options.name}」，当前没有运行中的 Codex Desktop。`
            : outcome === "killed"
              ? `已切换到「${options.name}」，受管的 Codex Desktop 会话已强制结束，请重新用 codexm launch 启动。`
              : `已切换到「${options.name}」，但刷新 Codex Desktop 失败，详见警告。`;

    return { message, warnings, proxy_retained: false, desktop_refresh: outcome };
  } finally {
    await lock.release();
  }
}

export type DesktopRelaunchOutcome = ManagedDesktopRestartOutcome | "failed" | "no-launcher";

export interface DesktopRelaunchResult {
  message: string;
  warnings: string[];
  outcome: DesktopRelaunchOutcome;
  /** The running Desktop was not started by codexm; the surface must confirm before quitting it. */
  requiresConfirmation: boolean;
}

/**
 * "Restart the app" for surfaces with no terminal: quit a codexm-managed
 * Desktop and start it again so it re-reads the current auth snapshot. A
 * Desktop codexm did not start is left alone — killing it could discard work
 * the operator never saved.
 */
export async function performDesktopRelaunch(options: {
  store: AccountStore;
  desktopLauncher?: CodexDesktopLauncher;
  debugLog?: DebugLogger;
  /** Set by surfaces that already asked the operator (e.g. a confirmed button click). */
  allowNonManaged?: boolean;
}): Promise<DesktopRelaunchResult> {
  if (!options.desktopLauncher) {
    return {
      outcome: "no-launcher",
      message: "当前控制台没有可用的 Codex Desktop 控制能力。",
      warnings: [],
      requiresConfirmation: false,
    };
  }

  const platform = await getPlatform();

  try {
    const desktopApiBaseUrl = await resolveManagedDesktopApiBaseUrl(options.store);
    const restart = await restartManagedDesktopSession({
      desktopLauncher: options.desktopLauncher,
      platform,
      desktopApiBaseUrl,
      allowNonManaged: options.allowNonManaged,
    });
    options.debugLog?.(`ui relaunch: outcome=${restart.outcome} platform=${platform}`);

    const message =
      restart.outcome === "relaunched"
        ? "已用当前账号重启 Codex Desktop。"
        : restart.outcome === "started"
          ? "已启动 Codex Desktop（使用当前账号）。"
          : restart.outcome === "other-running"
            ? "运行中的 Codex Desktop 不是 codexm 启动的。继续将关闭它，未保存的会话可能丢失。要继续吗？"
            : restart.outcome === "not-installed"
              ? describeDesktopNotFound(platform)
              : restart.outcome === "unsupported-platform"
                ? "当前平台不支持由 codexm 启动 Codex Desktop，请用 codexm run 启动 codex。"
                : "控制台运行在 Codex Desktop 内部，重启它会中断本控制台。请在外部终端执行 codexm launch。";

    return {
      outcome: restart.outcome,
      message,
      warnings: restart.warnings,
      requiresConfirmation: restart.requiresConfirmation,
    };
  } catch (error) {
    const message = (error as Error).message;
    options.debugLog?.(`ui relaunch failed: ${message}`);
    return {
      outcome: "failed",
      message: `重启 Codex Desktop 失败：${message}`,
      warnings: [],
      requiresConfirmation: false,
    };
  }
}

export type UiAddAccountMethod = "device" | "browser" | "apikey";

export interface UiAddedAccount {
  name: string;
  auth_mode: string;
  account_id?: string | null;
}

interface AccountAddFlow {
  id: string;
  name: string;
  status: "pending" | "done" | "error";
  message: string;
  account?: UiAddedAccount;
  warnings?: string[];
  cancel: () => void;
  settled: Promise<void>;
}

/**
 * Tracks logins started from the console. A HTTP handler has to hand the code
 * or authorize URL back immediately, while approval happens minutes later in
 * the operator's browser, so the login lives here instead of in one request.
 */
export function createAccountAddFlows() {
  const flows = new Map<string, AccountAddFlow>();

  return {
    async start(options: {
      name: string;
      cancel: () => void;
      wait: Promise<AuthSnapshot>;
      complete: (
        snapshot: AuthSnapshot,
      ) => Promise<{ account: UiAddedAccount; warnings?: string[] }>;
      debugLog?: DebugLogger;
    }): Promise<AccountAddFlow> {
      const id = randomBytes(8).toString("hex");
      const flow: AccountAddFlow = {
        id,
        name: options.name,
        status: "pending",
        message: "等待浏览器确认…",
        cancel: options.cancel,
        settled: Promise.resolve(),
      };
      flows.set(id, flow);

      flow.settled = options.wait.then(
        async (snapshot) => {
          try {
            const completed = await options.complete(snapshot);
            flow.account = completed.account;
            flow.warnings = completed.warnings ?? [];
            flow.status = "done";
            flow.message = `已添加账号「${options.name}」。`;
            options.debugLog?.(`ui add: flow ${id} completed for ${options.name}`);
          } catch (error) {
            flow.status = "error";
            flow.message = (error as Error).message;
          }
        },
        (error: unknown) => {
          flow.status = "error";
          flow.message = (error as Error).message;
          options.debugLog?.(`ui add: flow ${id} failed: ${flow.message}`);
        },
      );

      return flow;
    },

    get(id: string): AccountAddFlow | undefined {
      return flows.get(id);
    },

    /** Cancels and forgets a flow; callers only await it on shutdown. */
    remove(id: string): void {
      const flow = flows.get(id);
      if (!flow) {
        return;
      }
      flows.delete(id);
    },

    cancelAll(): void {
      for (const flow of flows.values()) {
        flow.cancel();
      }
      flows.clear();
    },

    /** Test hook: resolve once every started flow has settled. */
    async settled(): Promise<void> {
      await Promise.all([...flows.values()].map((flow) => flow.settled));
    },
  };
}

export type AccountAddFlows = ReturnType<typeof createAccountAddFlows>;

export type UiAddAccountResult =
  | { status: "added"; message: string; account: UiAddedAccount; warnings?: string[] }
  | { status: "confirm-overwrite"; message: string }
  | {
      status: "pending";
      mode: "device";
      message: string;
      flowId: string;
      userCode: string;
      verificationUrl: string;
    }
  | {
      status: "pending";
      mode: "browser";
      message: string;
      flowId: string;
      authorizeUrl: string;
    };

/**
 * Drops an account from the registry before its local copy disappears, so the
 * credentials stop being offered to other machines first.
 *
 * Best effort: no registry configured, an unreachable server or a rejected
 * delete must never block the local removal, so problems come back as warnings.
 */
async function deleteAccountFromRegistry(options: {
  store: AccountStore;
  name: string;
  debugLog?: DebugLogger;
}): Promise<{ deleted: boolean; warnings: string[] }> {
  let remote;
  try {
    remote = await resolveRemote(options.store, null);
  } catch (error) {
    options.debugLog?.(`ui remove: no registry configured: ${(error as Error).message}`);
    return { deleted: false, warnings: [] };
  }

  try {
    const remoteAccounts = await listRemoteAccounts(remote.config);
    if (!remoteAccounts.some((entry) => entry.name === options.name)) {
      return { deleted: false, warnings: [] };
    }
    await deleteRemoteAccount(remote.config, options.name);
    options.debugLog?.(`ui remove: deleted ${options.name} from registry ${remote.name}`);
    return { deleted: true, warnings: [] };
  } catch (error) {
    const reason = (error as Error).message;
    options.debugLog?.(`ui remove: registry delete failed for ${options.name}: ${reason}`);
    return {
      deleted: false,
      warnings: [`registry「${remote.name}」上的「${options.name}」未能删除：${reason}`],
    };
  }
}

/**
 * Converges with the registry right after an add or a remove: adopt newer
 * tokens, push local-only changes. Skipped silently when no registry is
 * configured, so a single-machine setup is unaffected.
 */
async function syncWithRegistryAfterChange(options: {
  store: AccountStore;
  debugLog?: DebugLogger;
}): Promise<{ synced: boolean; warnings: string[] }> {
  try {
    const clientId = await resolveRegistryClientId(options.store.paths.codexTeamDir);
    const result = await runAutoSyncOnce({
      store: options.store,
      clientId,
      debugLog: options.debugLog,
    });
    return {
      synced: true,
      warnings: result.accounts
        .filter((entry) => entry.action === "failed")
        .map((entry) => `registry 同步：「${entry.name}」失败（${entry.error ?? "未知原因"}）`),
    };
  } catch (error) {
    options.debugLog?.(`ui: registry sync skipped: ${(error as Error).message}`);
    return { synced: false, warnings: [] };
  }
}

/**
 * Adds a managed account from the console: an API key is saved straight away,
 * while device login returns a code the operator approves in a browser. Like
 * `codexm add`, this only writes the snapshot — it never changes current auth.
 */
export async function performUiAddAccount(options: {
  store: AccountStore;
  authLogin?: CodexLoginProvider;
  flows: AccountAddFlows;
  name: string;
  method: UiAddAccountMethod;
  apiKey?: string;
  force?: boolean;
  debugLog?: DebugLogger;
}): Promise<UiAddAccountResult> {
  const name = options.name.trim();
  if (name === "") {
    throw new Error("缺少账号名称");
  }
  ensureAccountName(name);
  ensureNotReservedProxyAccountName(name, "name a managed account");

  const { accounts } = await options.store.listAccounts();
  if (accounts.some((account) => account.name === name) && options.force !== true) {
    return {
      status: "confirm-overwrite",
      message: `已存在同名账号「${name}」。继续将覆盖它的登录态，要继续吗？`,
    };
  }

  if (options.method === "apikey") {
    const apiKey = (options.apiKey ?? "").trim();
    if (apiKey === "") {
      throw new Error("缺少 API key");
    }
    const account = await options.store.addAccountSnapshot(
      name,
      { auth_mode: "apikey", OPENAI_API_KEY: apiKey },
      { force: options.force === true },
    );
    options.debugLog?.(`ui add: saved apikey account ${name}`);
    const registry = await syncWithRegistryAfterChange({
      store: options.store,
      debugLog: options.debugLog,
    });

    return {
      status: "added",
      message: `已添加账号「${name}」（API key）。`,
      account: {
        name: account.name,
        auth_mode: account.auth_mode,
        account_id: account.account_id,
      },
      warnings: registry.warnings,
    };
  }

  const saveSnapshot = async (
    snapshot: AuthSnapshot,
  ): Promise<{ account: UiAddedAccount; warnings?: string[] }> => {
    const account = await options.store.addAccountSnapshot(name, snapshot, {
      force: options.force === true,
    });
    const registry = await syncWithRegistryAfterChange({
      store: options.store,
      debugLog: options.debugLog,
    });

    return {
      account: {
        name: account.name,
        auth_mode: account.auth_mode,
        account_id: account.account_id,
      },
      warnings: registry.warnings,
    };
  };

  if (options.method === "browser") {
    if (!options.authLogin?.startBrowserLogin) {
      throw new Error("当前控制台没有可用的浏览器回调登录能力，请在终端执行 codexm add。");
    }

    let session: Awaited<ReturnType<NonNullable<CodexLoginProvider["startBrowserLogin"]>>>;
    try {
      session = await options.authLogin.startBrowserLogin();
    } catch (error) {
      const reason = (error as Error).message;
      options.debugLog?.(`ui add: browser login start failed: ${reason}`);
      throw new Error(
        `无法启动浏览器回调登录（回调端口 1455 可能已被占用）：${reason}。可以改用设备码登录。`,
      );
    }

    const flow = await options.flows.start({
      name,
      wait: session.wait(),
      cancel: () => session.cancel("已取消添加账号。"),
      complete: saveSnapshot,
      debugLog: options.debugLog,
    });

    return {
      status: "pending",
      mode: "browser",
      message: `请在浏览器中打开授权链接完成 ChatGPT 登录（回调地址 ${session.redirectUri}），等待确认。`,
      flowId: flow.id,
      authorizeUrl: session.authorizeUrl,
    };
  }

  if (!options.authLogin?.startDeviceLogin) {
    throw new Error("当前控制台没有可用的设备码登录能力，请在终端执行 codexm add。");
  }

  const session = await options.authLogin.startDeviceLogin();
  const flow = await options.flows.start({
    name,
    wait: session.wait(),
    cancel: () => session.cancel("已取消添加账号。"),
    complete: saveSnapshot,
    debugLog: options.debugLog,
  });

  return {
    status: "pending",
    mode: "device",
    message: `请在浏览器中打开 ${session.verificationUrl} 并输入设备码 ${session.userCode}，等待确认。`,
    flowId: flow.id,
    userCode: session.userCode,
    verificationUrl: session.verificationUrl,
  };
}

export interface UiRemoveAccountResult {
  message: string;
  warnings: string[];
}

/**
 * Removes a managed account from the console. The current auth file is a copy,
 * so deleting the account that is currently in use does not break codex right
 * away — it just leaves that copy unmanaged, which is worth saying out loud.
 */
export async function performUiRemoveAccount(options: {
  store: AccountStore;
  name: string;
  debugLog?: DebugLogger;
}): Promise<UiRemoveAccountResult> {
  const name = options.name.trim();
  if (name === "") {
    throw new Error("缺少账号名称");
  }
  ensureAccountName(name);

  const current = await options.store.getCurrentStatus();
  const wasCurrent = current.matched_accounts.includes(name);

  // Registry first: stop offering these credentials to other machines before
  // the local copy goes away.
  const registryRemoval = await deleteAccountFromRegistry({
    store: options.store,
    name,
    debugLog: options.debugLog,
  });

  try {
    await options.store.removeAccount(name);
  } catch (error) {
    const reason = (error as Error).message;
    options.debugLog?.(`ui remove failed: name=${name} error=${reason}`);
    throw new Error(`删除账号「${name}」失败：${reason}`);
  }

  // Sync only after the local delete: converging while the account is still
  // local would push it straight back and recreate the orphan record.
  const registrySync = await syncWithRegistryAfterChange({
    store: options.store,
    debugLog: options.debugLog,
  });

  options.debugLog?.(`ui remove: name=${name} wasCurrent=${wasCurrent}`);

  const warnings = [
    ...registryRemoval.warnings,
    ...registrySync.warnings,
  ];
  if (wasCurrent) {
    warnings.push(
      `「${name}」是当前 codex 使用的登录态来源。删除后 ~/.codex/auth.json 仍保留这份登录态副本，但不再属于任何托管账号；建议切换到其他账号。`,
    );
  }

  return {
    message: `已删除账号「${name}」。` +
      (registryRemoval.deleted ? "已同时从 registry 删除，并立即同步。" : ""),
    warnings,
  };
}

export async function handleUiCommand(options: {
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  desktopLauncher?: CodexDesktopLauncher;
  authLogin?: CodexLoginProvider;
  /** Device-code logins outlive a single request; injected so tests can drive them. */
  accountAddFlows?: AccountAddFlows;
  portOption?: string | null;
  noOpen?: boolean;
  tray?: boolean;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { store, stdout } = options;
  const accountAddFlows = options.accountAddFlows ?? createAccountAddFlows();

  let requestedPort = 0;
  if (options.portOption) {
    requestedPort = Number.parseInt(options.portOption, 10);
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      throw new Error(`Invalid --port value "${options.portOption}". Expected a port between 1 and 65535.`);
    }
  }

  const token = randomBytes(24).toString("base64url");
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const supplied =
        url.searchParams.get("token") ??
        (Array.isArray(req.headers["x-codexm-token"])
          ? req.headers["x-codexm-token"][0]
          : req.headers["x-codexm-token"]);

      // Loopback-only, but any page you visit could still probe localhost, so
      // every request has to carry the one-shot token.
      if (supplied !== token) {
        sendJson(res, 401, { error: "未授权" });
        return;
      }

      try {
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(renderPage());
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/state") {
          sendJson(res, 200, await buildState(store));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/switch") {
          const body = await readJsonBody(req);
          const name = typeof body.name === "string" ? body.name : "";
          if (name === "") {
            sendJson(res, 400, { error: "缺少账号名称" });
            return;
          }
          const result = await performUiSwitch({
            store,
            name,
            desktopLauncher: options.desktopLauncher,
            debugLog: options.debugLog,
          });
          sendJson(res, 200, {
            ok: true,
            message: result.message,
            proxy_retained: result.proxy_retained,
            desktop_refresh: result.desktop_refresh,
            warnings: result.warnings,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/accounts/add") {
          const body = await readJsonBody(req);
          const result = await performUiAddAccount({
            store,
            authLogin: options.authLogin,
            flows: accountAddFlows,
            name: typeof body.name === "string" ? body.name : "",
            method:
              body.method === "apikey" || body.method === "browser" ? body.method : "device",
            apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
            force: body.force === true,
            debugLog: options.debugLog,
          });
          sendJson(res, 200, {
            ok: result.status !== "confirm-overwrite",
            ...result,
            requires_confirmation: result.status === "confirm-overwrite",
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/accounts/remove") {
          const body = await readJsonBody(req);
          const name = typeof body.name === "string" ? body.name : "";
          if (name === "") {
            sendJson(res, 400, { error: "缺少账号名称" });
            return;
          }
          const result = await performUiRemoveAccount({
            store,
            name,
            debugLog: options.debugLog,
          });
          sendJson(res, 200, { ok: true, message: result.message, warnings: result.warnings });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/accounts/add/status") {
          const flow = accountAddFlows.get(url.searchParams.get("flowId") ?? "");
          if (!flow) {
            sendJson(res, 404, { error: "未找到该添加流程" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            status: flow.status,
            message: flow.message,
            account: flow.account ?? null,
            warnings: flow.warnings ?? [],
          });
          if (flow.status !== "pending") {
            accountAddFlows.remove(flow.id);
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/accounts/add/cancel") {
          const body = await readJsonBody(req);
          accountAddFlows.get(typeof body.flowId === "string" ? body.flowId : "")?.cancel();
          sendJson(res, 200, { ok: true, message: "已取消添加账号。" });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/desktop/relaunch") {
          const body = await readJsonBody(req);
          const result = await performDesktopRelaunch({
            store,
            desktopLauncher: options.desktopLauncher,
            debugLog: options.debugLog,
            allowNonManaged: body.allowNonManaged === true,
          });
          sendJson(res, 200, {
            ok: result.outcome !== "failed",
            message: result.message,
            outcome: result.outcome,
            requires_confirmation: result.requiresConfirmation,
            warnings: result.warnings,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/refresh") {
          const refreshBody = await readJsonBody(req);
          const onlyName = typeof refreshBody.name === "string" ? refreshBody.name.trim() : "";
          const result = await store.refreshAllQuotas(onlyName === "" ? undefined : onlyName);
          sendJson(res, 200, {
            ok: true,
            message: `配额刷新成功 ${result.successes.length} 个，失败 ${result.failures.length} 个。`,
            warnings: [
              ...result.warnings,
              ...result.failures.map((failure) => `${failure.name}: ${failure.error}`),
            ],
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/sync") {
          const summary = await syncAccountsToRemote({ store });
          sendJson(res, 200, {
            ok: summary.failed === 0,
            message: formatSyncMessage(summary),
            summary,
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/autosync") {
          sendJson(res, 200, {
            ok: true,
            enabled: stopAutoSync !== null,
            last_run: lastAutoSync,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/autosync") {
          const result = await runAutoSyncNow();
          sendJson(res, 200, { ok: true, result });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/quit") {
          sendJson(res, 200, { ok: true, message: "stopping" });
          res.on("finish", shutdown);
          return;
        }

        sendJson(res, 404, { error: "未找到" });
      } catch (error) {
        options.debugLog?.(`ui: ${(error as Error).message}`);
        sendJson(res, 500, { error: (error as Error).message });
      }
    })();
  });

  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let trayHost: TrayHost | null = null;
  let shuttingDown = false;
  let stopAutoSync: (() => void) | null = null;
  let lastAutoSync: AutoSyncRunResult | null = null;

  async function runAutoSyncNow(): Promise<AutoSyncRunResult> {
    const clientId = await resolveRegistryClientId(store.paths.codexTeamDir);
    const result = await runAutoSyncOnce({ store, clientId, debugLog: options.debugLog });
    lastAutoSync = result;
    return result;
  }

  function shutdown(): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopAutoSync?.();
    accountAddFlows.cancelAll();
    trayHost?.stop();
    server.close(() => resolveClosed?.());
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  const wantsTray = options.tray === true && isTraySupported();

  // Unattended convergence with the registry: adopt newer remote tokens,
  // refresh what is due under a server-issued lease, push local-only changes.
  // Stays off when no registry remote is configured.
  try {
    const remotes = await readRemotesFile(store);
    if (remotes.default_remote && remotes.remotes[remotes.default_remote]) {
      const clientId = await resolveRegistryClientId(store.paths.codexTeamDir);
      const autoSyncController = new AbortController();
      stopAutoSync = () => autoSyncController.abort();
      void runAutoSyncLoop({
        store,
        clientId,
        signal: autoSyncController.signal,
        debugLog: options.debugLog,
        onRun: (result) => {
          lastAutoSync = result;
        },
      });
    }
  } catch (error) {
    options.debugLog?.(`ui: auto-sync disabled: ${(error as Error).message}`);
  }

  process.once("SIGINT", shutdown);
  stdout.write(`codexm 控制台已启动：${url}\n`);

  if (options.tray === true && !wantsTray) {
    stdout.write("托盘图标仅在 Windows 上可用，已按普通模式运行。\n");
  }

  if (wantsTray) {
    const host = startTray({
      onAction: (action) => {
        void handleTrayAction({
          action,
          store,
          stdout,
          desktopLauncher: options.desktopLauncher,
          url,
          shutdown,
          debugLog: options.debugLog,
        });
      },
      onExit: () => {
        // In tray mode the icon is the only control surface, so a dead host
        // would leave the console running with no way to stop it.
        if (!shuttingDown) {
          stdout.write("托盘已退出，正在停止控制台。\n");
        }
        shutdown();
      },
      onDiagnostic: (message) => options.debugLog?.(`ui tray: ${message}`),
    });
    trayHost = host;
    // `wantsTray` already guarantees Windows, so `host` is only nullable to satisfy the type.
    const trayReady = host ? await waitForTrayReady(host) : false;
    stdout.write(
      trayReady
        ? "托盘图标已就绪：左键打开控制台，右键查看更多操作。\n"
        : "托盘图标启动失败，控制台仍在运行。\n",
    );
  } else {
    stdout.write("按 Ctrl+C 停止服务。\n");
    if (options.noOpen !== true) {
      openBrowser(url);
    }
  }

  await closed;
  stdout.write("codexm 控制台已停止。\n");
  return 0;
}
