// Bilibili At Guard — side panel UI.
// Reads capture records from chrome.storage and renders the pending/history
// lists. Write calls (delete/block/unblock) are routed through a bilibili
// video page's content script — bilibili's gateway rejects extension-origin
// POSTs — and rate-limited client-side. Restore is page-session scoped.
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const state = {
    settings: { enabled: true, exemptSelf: true, theme: 'dark' },
    rules: [],
    whitelist: [],
    records: {},
    stats: { captured: 0, deleted: 0, blocked: 0 },
    videoInfos: {},
    myInfo: null,
    tab: 'pending',
    diag: '',
    testResult: '',
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let toastTimer = 0;
  function toast(msg, ms = 3000) {
    const el = $('#toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.display = 'none';
    }, ms);
  }

  async function persist(keys) {
    const patch = {};
    if (keys.includes('settings')) patch.settings = state.settings;
    if (keys.includes('rules')) patch.rules = state.rules;
    if (keys.includes('whitelist')) patch.whitelist = state.whitelist;
    if (keys.includes('records')) patch.records = state.records;
    if (keys.includes('stats')) patch.stats = state.stats;
    await chrome.storage.local.set(patch);
  }

  async function loadAll() {
    const stored = await chrome.storage.local.get(['settings', 'rules', 'whitelist', 'records', 'stats', 'videoInfos']);
    state.settings = { enabled: true, exemptSelf: true, theme: 'dark', ...(stored.settings || {}) };
    state.rules = stored.rules || [];
    state.whitelist = stored.whitelist || [];
    state.records = stored.records || {};
    state.stats = stored.stats || state.stats;
    state.videoInfos = stored.videoInfos || {};
  }

  function isMine(bvid) {
    const info = state.videoInfos[bvid];
    return !!(info && info.ownerMid && state.myInfo && info.ownerMid === state.myInfo.mid);
  }

  // ---------- rendering ----------

  function render() {
    const dark = state.settings.theme !== 'light';
    document.body.dataset.theme = dark ? 'dark' : 'light';
    $('#theme-toggle').textContent = dark ? '☀️' : '🌙';
    $('#toggle-enabled').checked = !!state.settings.enabled;
    const mi = state.myInfo;
    $('#identity').textContent = !mi
      ? '账号信息加载中…'
      : mi.isLogin
        ? `已登录：${mi.uname || '未知'}（mid ${mi.mid || '—'}）`
        : '未登录 — 拦截照常工作，删除/拉黑不可用';
    $('#statrow').innerHTML =
      `<span class="stat">累计拦截 ${state.stats.captured || 0}</span>` +
      `<span class="stat">已删除 ${state.stats.deleted || 0}</span>` +
      `<span class="stat">已拉黑 ${state.stats.blocked || 0}</span>`;
    $('#main').innerHTML =
      state.tab === 'pending' ? renderPending() : state.tab === 'history' ? renderHistory() : renderSettings();
  }

  // Typing in settings should not be clobbered by background storage writes.
  function scheduleRender() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) return;
    render();
  }

  function cardHtml(rec, mine) {
    return `<div class="card" data-id="${esc(rec.id)}">
      <div class="card-top">
        <span class="uname" title="${esc(rec.uname)}">@${esc(rec.uname)}</span>
        <span class="time">${fmtTime(rec.ts)}</span>
      </div>
      <div class="card-text" data-action="expand">${rec.text ? esc(rec.text) : '<em>(无文本)</em>'}</div>
      ${rec.mentions && rec.mentions.length ? `<div class="mentions">提及: ${rec.mentions.map(esc).join('、')}</div>` : ''}
      <div class="btnrow">
        <button class="btn" data-action="restore">恢复</button>
        <button class="btn" data-action="wl" ${rec.mid ? '' : 'disabled'} title="该用户评论永不隐藏">白名单</button>
        ${mine ? `<button class="btn primary" data-action="del" ${rec.rpid ? '' : 'disabled'} title="${rec.rpid ? '删除该评论（UP主权限）' : '未提取到 rpid，无法删除'}">删除</button>` : ''}
        <button class="btn danger" data-action="blk" ${rec.mid ? '' : 'disabled'} title="${rec.mid ? '拉黑该用户' : '未提取到用户 mid，无法拉黑'}">拉黑</button>
      </div>
    </div>`;
  }

  function renderPending() {
    const recs = Object.values(state.records)
      .filter((r) => r.status === 'hidden' && !(r.mid && state.whitelist.includes(r.mid)))
      .sort((a, b) => b.ts - a.ts);
    if (!recs.length) return '<div class="empty">暂无被隐藏的评论。<br/>评论区出现含@评论时会自动出现在这里。</div>';
    const groups = new Map();
    for (const rec of recs) {
      if (!groups.has(rec.bvid)) groups.set(rec.bvid, []);
      groups.get(rec.bvid).push(rec);
    }
    let html = '';
    for (const [bvid, list] of groups) {
      const mine = isMine(bvid);
      if (!state.videoInfos[bvid] && bvid) {
        chrome.runtime.sendMessage({ type: 'BAG_VIEW', bvid }).catch(() => {});
      }
      const known = !!(state.videoInfos[bvid] && state.videoInfos[bvid].ownerMid);
      html += `<div class="group">
        <div class="group-head">
          <span class="group-title" title="${esc(bvid)}">${esc(list[0].videoTitle || bvid)}</span>
          <span class="badge ${mine ? 'mine' : 'other'}">${known ? (mine ? '我的视频' : '他人视频') : '识别中…'}</span>
          <span class="badge other">${list.length} 条</span>
        </div>
        ${list.map((rec) => cardHtml(rec, mine)).join('')}
      </div>`;
    }
    return html;
  }

  function renderHistory() {
    const recs = Object.values(state.records)
      .filter((r) => r.status === 'deleted' || r.status === 'blocked')
      .sort((a, b) => b.ts - a.ts);
    if (!recs.length) return '<div class="empty">暂无已处理记录。<br/>删除/拉黑成功后会出现在这里。</div>';
    return recs
      .map(
        (rec) => `<div class="card" data-id="${esc(rec.id)}">
        <div class="card-top">
          <span class="uname">@${esc(rec.uname)}</span>
          <span class="badge ${rec.status === 'deleted' ? 'deleted' : 'blocked'}">${rec.status === 'deleted' ? '已删除' : '已拉黑'}</span>
          <span class="time">${fmtTime(rec.ts)}</span>
        </div>
        <div class="card-text">${rec.text ? esc(rec.text) : '<em>(无文本)</em>'}</div>
        <div class="hint" style="margin-top:4px">${esc(rec.videoTitle || '')}</div>
        ${rec.status === 'blocked' ? `<div class="btnrow"><button class="btn" data-action="unblk" ${rec.mid ? '' : 'disabled'} title="将对方移出黑名单（act=6）">取消拉黑</button></div>` : ''}
      </div>`,
      )
      .join('');
  }

  function ruleRow(rule, idx) {
    return `<div class="rule-row" data-idx="${idx}">
      <select data-field="type">
        <option value="kw" ${rule.type !== 're' ? 'selected' : ''}>关键词</option>
        <option value="re" ${rule.type === 're' ? 'selected' : ''}>正则</option>
      </select>
      <input data-field="value" value="${esc(rule.value)}" placeholder="${rule.type === 're' ? 'JS 正则，如 /代购|刷单/' : '子串，如 加微信'}"/>
      <input type="checkbox" data-field="on" ${rule.on !== false ? 'checked' : ''} title="启用"/>
      <button class="iconbtn" data-action="rulex" data-idx="${idx}" title="删除规则">✕</button>
    </div>`;
  }

  function renderSettings() {
    return `
    <div class="section">
      <div class="section-title">拦截规则</div>
      <div class="hint">默认拦截所有含 @提及 的评论（针对 dsh-bili-scroll 这类插件生成内容的主要特征，其文案为 LLM 生成、无固定模板）。此处规则仅作补充。</div>
      <div style="margin-top:8px">${state.rules.map(ruleRow).join('') || '<div class="hint">暂无规则</div>'}</div>
      <div class="btnrow"><button class="btn" data-action="ruleadd">＋ 添加规则</button></div>
      <div class="testbox">
        <input id="ruletest" placeholder="粘贴评论文本，测试会命中哪些规则…"/>
        <button class="btn" data-action="ruletest">测试</button>
      </div>
      <div class="test-result" id="test-result">${esc(state.testResult)}</div>
    </div>
    <div class="section">
      <div class="section-title">白名单</div>
      <div class="hint">以下用户（mid）的评论永不隐藏。</div>
      <div style="margin-top:6px">${state.whitelist.map((mid, i) => `<div class="wl-row"><span style="flex:1">mid ${esc(mid)}</span><button class="iconbtn" data-action="wlx" data-idx="${i}">✕</button></div>`).join('') || '<div class="hint">暂无白名单</div>'}</div>
    </div>
    <div class="section">
      <div class="section-title">行为</div>
      <label class="checkline"><input type="checkbox" id="exempt-self" ${state.settings.exemptSelf ? 'checked' : ''}/> 豁免我自己发出的含@评论</label>
    </div>
    <div class="section">
      <div class="section-title">诊断</div>
      <div class="btnrow"><button class="btn" data-action="diag">诊断当前标签页</button></div>
      <div class="diag" id="diag-out">${esc(state.diag)}</div>
    </div>
    <div class="section">
      <div class="section-title">数据</div>
      <div class="btnrow">
        <button class="btn" data-action="cleanhist">清理已处理记录</button>
        <button class="btn" data-action="wipeall">清空全部记录</button>
      </div>
    </div>
    <div class="section hint">
      删除走 UP主 权限（x/v2/reply/del），拉黑走关系接口（x/relation/modify，act=5）。均为 bilibili 网页端非官方接口，需登录态；每次操作间隔 1.6s 并需二次确认。若失败请把提示原样反馈。
    </div>`;
  }

  // ---------- actions ----------

  function armConfirm(btn, word, fn) {
    if (btn.dataset.armed) {
      clearTimeout(Number(btn.dataset.timer));
      delete btn.dataset.armed;
      btn.textContent = word;
      fn();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = '确认？';
    btn.dataset.timer = String(
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = word;
      }, 4000),
    );
  }

  // Write calls are served by any open bilibili video page (the request goes
  // out from that page's context); the focused tab is tried first so
  // 诊断当前标签页 stays scoped to what the user is looking at.
  async function sendToContent(msgType, payload) {
    const match = 'https://www.bilibili.com/video/*';
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: match });
    const all = await chrome.tabs.query({ url: match });
    const seen = new Set();
    const tabs = [...active, ...all].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    for (const tab of tabs) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: msgType, ...payload });
        if (res && res.ok !== false) return res;
      } catch {
        // tab without our content script
      }
    }
    return null;
  }

  async function ensureOid(rec) {
    if (rec.oid) return rec.oid;
    if (!rec.bvid) return '';
    try {
      const info = await chrome.runtime.sendMessage({ type: 'BAG_VIEW', bvid: rec.bvid });
      if (info && info.aid) {
        rec.oid = info.aid;
        await persist(['records']);
        return info.aid;
      }
    } catch {
      // service worker unreachable
    }
    return '';
  }

  // Write calls are rate-limited client-side: one bilibili write per 1.6 s.
  let lastWriteAt = 0;
  async function writeThrottle() {
    const gap = 1600 - (Date.now() - lastWriteAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastWriteAt = Date.now();
  }

  async function deleteComment(rec) {
    const oid = await ensureOid(rec);
    if (!oid || !rec.rpid) {
      toast('缺少 oid/rpid，无法删除（设置→诊断 可查看提取情况）');
      return;
    }
    await writeThrottle();
    const res = await sendToContent('BAG_API', { call: 'del', params: { oid, rpid: rec.rpid } });
    if (!res) {
      toast('未找到打开的B站视频页，无法发起请求（请打开任意B站视频页后重试）', 5000);
      return;
    }
    if (res.code === 0) {
      rec.status = 'deleted';
      state.stats.deleted = (state.stats.deleted || 0) + 1;
      await persist(['records', 'stats']);
      toast('已删除该评论');
    } else {
      toast(`删除失败: ${res.message || '未知错误'}`, 5000);
    }
  }

  async function blockUser(rec) {
    if (!rec.mid) {
      toast('未提取到用户 mid，无法拉黑');
      return;
    }
    await writeThrottle();
    const res = await sendToContent('BAG_API', { call: 'block', params: { mid: rec.mid } });
    if (!res) {
      toast('未找到打开的B站视频页，无法发起请求（请打开任意B站视频页后重试）', 5000);
      return;
    }
    if (res.code === 0) {
      rec.status = 'blocked';
      state.stats.blocked = (state.stats.blocked || 0) + 1;
      await persist(['records', 'stats']);
      toast(`已拉黑 @${rec.uname}`);
    } else {
      toast(`拉黑失败: ${res.message || '未知错误'}`, 5000);
    }
  }

  async function unblockUser(rec) {
    if (!rec.mid) {
      toast('该记录缺少用户 mid，无法操作');
      return;
    }
    await writeThrottle();
    const res = await sendToContent('BAG_API', { call: 'unblock', params: { mid: rec.mid } });
    if (!res) {
      toast('未找到打开的B站视频页，无法发起请求（请打开任意B站视频页后重试）', 5000);
      return;
    }
    if (res.code === 0) {
      rec.status = 'hidden';
      state.stats.blocked = Math.max(0, (state.stats.blocked || 0) - 1);
      await persist(['records', 'stats']);
      toast(`已取消拉黑 @${rec.uname}（该评论回到待处理）`);
    } else {
      toast(`取消拉黑失败: ${res.message || '未知错误'}`, 5000);
    }
  }

  async function restoreSession(rec) {
    const res = await sendToContent('BAG_RESTORE', { id: rec.id, bvid: rec.bvid });
    toast(
      res && res.ok
        ? '已在本页恢复显示（仅当前页面会话有效，刷新后恢复拦截）'
        : '该评论所在页面未打开，恢复仅在对应视频页生效',
    );
  }

  async function addWhitelist(rec) {
    if (!rec.mid) return;
    if (!state.whitelist.includes(rec.mid)) {
      state.whitelist.push(rec.mid);
      await persist(['whitelist']);
    }
    toast(`已将 mid ${rec.mid} 加入白名单`);
  }

  async function runDiag() {
    try {
      const res = await sendToContent('BAG_PAGE_STATS', {});
      if (!res) throw new Error('no response');
      state.diag =
        `URL: ${res.url}\nBVID: ${res.bvid || '—'}\nAID: ${res.aid || '—'}\n` +
        `探针: ${res.probe ? '正常' : '失效（使用 DOM 兜底解析）'}\n` +
        `识别评论单元: ${res.units}\n当前隐藏: ${res.hidden}\n` +
        `缺 rpid: ${res.missingRpid} · 缺 mid: ${res.missingMid}`;
    } catch {
      state.diag = '当前标签页不是 bilibili 视频页，或插件未注入。';
    }
    render();
  }

  function testRules() {
    const text = $('#ruletest').value;
    const hits = [];
    if (/@\u200b?[\w\u4e00-\u9fa5]/.test(text)) hits.push('含@（默认规则）');
    for (let i = 0; i < state.rules.length; i++) {
      const rule = state.rules[i];
      if (rule.on === false || !rule.value) continue;
      if (rule.type === 're') {
        try {
          if (new RegExp(rule.value).test(text)) hits.push(`规则${i + 1}（正则）`);
        } catch {
          hits.push(`规则${i + 1}（正则无效）`);
        }
      } else if (text.includes(rule.value)) {
        hits.push(`规则${i + 1}（关键词）`);
      }
    }
    state.testResult = text ? (hits.length ? `命中: ${hits.join('、')}` : '未命中任何规则') : '';
    const out = $('#test-result');
    if (out) out.textContent = state.testResult;
  }

  // ---------- events ----------

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        state.tab = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        render();
      });
    });

    $('#theme-toggle').addEventListener('click', () => {
      state.settings.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
      document.body.dataset.theme = state.settings.theme;
      $('#theme-toggle').textContent = state.settings.theme === 'dark' ? '☀️' : '🌙';
      persist(['settings']);
    });

    $('#toggle-enabled').addEventListener('change', (e) => {
      state.settings.enabled = e.target.checked;
      persist(['settings']);
    });

    $('#main').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (btn) {
        handleAction(btn);
        return;
      }
      const text = e.target.closest('.card-text[data-action="expand"]');
      if (text) text.classList.toggle('open');
    });

    $('#main').addEventListener('change', (e) => {
      const el = e.target;
      if (el.id === 'exempt-self') {
        state.settings.exemptSelf = el.checked;
        persist(['settings']);
        return;
      }
      const row = el.closest('.rule-row');
      if (!row) return;
      const rule = state.rules[Number(row.dataset.idx)];
      if (!rule) return;
      if (el.dataset.field === 'type') {
        rule.type = el.value;
        render();
      } else if (el.dataset.field === 'value') {
        rule.value = el.value;
      } else if (el.dataset.field === 'on') {
        rule.on = el.checked;
      }
      persist(['rules']);
    });
  }

  function handleAction(btn) {
    const action = btn.dataset.action;
    if (action === 'ruleadd') {
      state.rules.push({ id: 'r' + Date.now(), type: 'kw', value: '', on: true });
      persist(['rules']);
      render();
      return;
    }
    if (action === 'rulex') {
      state.rules.splice(Number(btn.dataset.idx), 1);
      persist(['rules']);
      render();
      return;
    }
    if (action === 'wlx') {
      state.whitelist.splice(Number(btn.dataset.idx), 1);
      persist(['whitelist']);
      render();
      return;
    }
    if (action === 'ruletest') {
      testRules();
      return;
    }
    if (action === 'diag') {
      runDiag();
      return;
    }
    if (action === 'cleanhist') {
      armConfirm(btn, '清理已处理记录', async () => {
        for (const rec of Object.values(state.records)) {
          if (rec.status !== 'hidden') delete state.records[rec.id];
        }
        await persist(['records']);
        toast('已清理已处理记录');
      });
      return;
    }
    if (action === 'wipeall') {
      armConfirm(btn, '清空全部记录', async () => {
        state.records = {};
        await persist(['records']);
        toast('已清空全部记录');
      });
      return;
    }
    const card = btn.closest('.card');
    if (!card) return;
    const rec = state.records[card.dataset.id];
    if (!rec) return;
    if (action === 'restore') restoreSession(rec);
    else if (action === 'wl') addWhitelist(rec);
    else if (action === 'del') armConfirm(btn, '删除', () => deleteComment(rec));
    else if (action === 'blk') armConfirm(btn, '拉黑', () => blockUser(rec));
    else if (action === 'unblk') armConfirm(btn, '取消拉黑', () => unblockUser(rec));
  }

  async function init() {
    await loadAll();
    bindEvents();
    render();
    try {
      state.myInfo = await chrome.runtime.sendMessage({ type: 'BAG_NAV' });
    } catch {
      state.myInfo = { isLogin: false, mid: '', uname: '' };
    }
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) state.settings = changes.settings.newValue || state.settings;
    if (changes.rules) state.rules = changes.rules.newValue || [];
    if (changes.whitelist) state.whitelist = changes.whitelist.newValue || [];
    if (changes.records) state.records = changes.records.newValue || {};
    if (changes.stats) state.stats = changes.stats.newValue || state.stats;
    if (changes.videoInfos) state.videoInfos = changes.videoInfos.newValue || {};
    scheduleRender();
  });

  // The panel persists across tab switches: reload storage when it becomes
  // visible again so it always mirrors the page the user is looking at.
  window.addEventListener('focus', () => {
    loadAll().then(render);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadAll().then(render);
  });

  init();
})();
