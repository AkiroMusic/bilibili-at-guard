// Bilibili At Guard — content script (isolated world).
// Scans the comment area through open shadow roots, hides comments that
// @-mention someone (or match user rules), keeps the capture chip in sync and
// mirrors records into chrome.storage for the side panel.
(() => {
  'use strict';

  const HOST_SEL = 'bili-comments';
  const THREAD_SEL = 'bili-comment-thread-renderer';
  const CLASSIC_SEL = '.reply-item';
  const SPACE_RE = /space\.bilibili\.com\/(\d+)/;
  const BV_RE = /\/video\/(BV[0-9A-Za-z]+)/;
  const AT_TEXT_RE = /@\u200b?[\w\u4e00-\u9fa5]/;
  // Aux renderer tags that must never be treated as comment units, so unknown
  // future renderer names can be matched generically by prefix.
  const UNIT_TAG_DENY = /(-REPLIES-|-BOX-|-USER-INFO|-ACTION-|-RICH-TEXT|-SORT|-HEADER|-COUNT|-PAGER)/;
  const SCAN_INTERVAL_MS = 2000;
  const SAVE_DEBOUNCE_MS = 400;
  const PROBE_TIMEOUT_MS = 500;
  const MAX_RECORDS = 3000;

  const DEFAULT_SETTINGS = { enabled: true, exemptSelf: true };
  const DEFAULT_STATS = { captured: 0, deleted: 0, blocked: 0 };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    rules: [],
    whitelist: [],
    records: {},
    stats: { ...DEFAULT_STATS },
    itemsByUid: new Map(),
    units: new Map(),
    processed: new WeakSet(),
    sessionRestored: new Set(),
    hiddenIds: new Set(),
    page: null,
    probeAlive: false,
    missingRpid: 0,
    missingMid: 0,
    unitCount: 0,
    url: location.href,
    chip: null,
    saveTimer: 0,
    scanBusy: false,
  };

  // ---------- shared DOM walking (open shadow roots included) ----------

  function deepCollect(root, selector, out, depth) {
    if (!root || depth > 10) return out;
    try {
      root.querySelectorAll(selector).forEach((el) => out.add(el));
    } catch {
      return out;
    }
    let children;
    try {
      children = root.querySelectorAll('*');
    } catch {
      return out;
    }
    for (const el of children) {
      if (el.shadowRoot) deepCollect(el.shadowRoot, selector, out, depth + 1);
    }
    return out;
  }

  // ---------- probe bridge ----------

  function probeRequest(type, resultType, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const onMsg = (e) => {
        if (e.source !== window || e.origin !== location.origin) return;
        const msg = e.data;
        if (!msg || msg.type !== resultType || msg.from !== 'bag-probe') return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(msg);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type }, location.origin);
      setTimeout(() => {
        if (!done) {
          window.removeEventListener('message', onMsg);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  // ---------- page info ----------

  function urlBvid() {
    return (location.pathname.match(BV_RE) || [])[1] || '';
  }

  function mergePage(page) {
    if (!page) return;
    const prev = state.page || {};
    state.page = {
      bvid: page.bvid || prev.bvid || urlBvid(),
      aid: page.aid || prev.aid || '',
      ownerMid: page.ownerMid || prev.ownerMid || '',
      title: page.title || prev.title || document.title,
      myMid: page.myMid || prev.myMid || '',
    };
  }

  async function fetchVideoInfo(bvid) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'BAG_VIEW', bvid });
      if (res && res.aid) {
        mergePage({ bvid, aid: res.aid, ownerMid: res.ownerMid, title: res.title });
        return res;
      }
    } catch {
      // service worker unavailable
    }
    return null;
  }

  async function ensurePageInfo() {
    const info = await probeRequest('BAG_PAGE_INFO', 'BAG_PAGE_INFO_RESULT', PROBE_TIMEOUT_MS);
    if (info) {
      state.probeAlive = true;
      mergePage(info.page);
    }
    if (!state.page) {
      state.page = { bvid: urlBvid(), aid: '', ownerMid: '', title: document.title, myMid: '' };
    }
    if (!state.page.aid && state.page.bvid) await fetchVideoInfo(state.page.bvid);
  }

  // ---------- records ----------

  function recordIdFor(item) {
    const bvid = (state.page && state.page.bvid) || urlBvid() || 'unknown';
    return item.rpid ? `${bvid}_${item.rpid}` : `${bvid}_u${item.uid}`;
  }

  function makeRecord(item, id) {
    return {
      id,
      rpid: item.rpid || null,
      oid: (state.page && state.page.aid) || null,
      bvid: (state.page && state.page.bvid) || urlBvid() || 'unknown',
      videoTitle: (state.page && state.page.title) || document.title,
      mid: item.mid || null,
      uname: item.uname || '未知用户',
      text: (item.message || '').slice(0, 240),
      mentions: (item.mentions || []).map((m) => m.name).filter(Boolean).slice(0, 5),
      status: 'hidden',
      ts: Date.now(),
    };
  }

  function pruneRecords(records) {
    const entries = Object.values(records);
    if (entries.length <= MAX_RECORDS) return;
    const droppable = entries
      .filter((r) => r.status !== 'hidden')
      .sort((a, b) => a.ts - b.ts);
    let toDrop = entries.length - MAX_RECORDS;
    for (const r of droppable) {
      if (toDrop-- <= 0) break;
      delete records[r.id];
    }
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      pruneRecords(state.records);
      chrome.storage.local.set({ records: state.records, stats: state.stats });
    }, SAVE_DEBOUNCE_MS);
  }

  // ---------- detection ----------

  function matchRules(text) {
    if (!text) return false;
    for (const rule of state.rules) {
      if (!rule || rule.on === false || !rule.value) continue;
      if (rule.type === 're') {
        try {
          if (new RegExp(rule.value).test(text)) return true;
        } catch {
          // invalid user regex is skipped, never thrown
        }
      } else if (text.includes(rule.value)) {
        return true;
      }
    }
    return false;
  }

  let uidSeq = 0;

  function ensureUid(el) {
    let uid = el.getAttribute('data-bag-uid');
    if (!uid) {
      uid = 'c' + ++uidSeq + Math.random().toString(36).slice(2, 7);
      el.setAttribute('data-bag-uid', uid);
    }
    return uid;
  }

  function localExtract(unit) {
    const anchors = [...deepCollect(unit, 'a', new Set(), 0)];
    const mentions = [];
    let mid = '';
    let uname = '';
    for (const a of anchors) {
      const m = String(a.getAttribute('href') || a.href || '').match(SPACE_RE);
      if (!m) continue;
      const text = (a.textContent || '').trim();
      if (text.startsWith('@')) {
        mentions.push({ mid: m[1], name: text.replace(/^@+/, '').slice(0, 40) });
      } else if (!mid) {
        mid = m[1];
        uname = text.slice(0, 40);
      }
    }
    return {
      uid: unit.getAttribute('data-bag-uid'),
      rpid: unit.getAttribute('data-id') || '',
      mid,
      uname,
      message: (unit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      mentions,
    };
  }

  function shouldHide(item) {
    const id = recordIdFor(item);
    if (state.sessionRestored.has(id)) return false;
    if (item.mid && state.whitelist.includes(item.mid)) return false;
    if (state.settings.exemptSelf && item.mid && item.mid === ((state.page && state.page.myMid) || '')) return false;
    if ((item.mentions && item.mentions.length > 0) || AT_TEXT_RE.test(item.message || '')) return true;
    return matchRules(item.message || '');
  }

  // ---------- hide / unhide ----------

  function hideEl(el) {
    el.style.display = 'none';
    el.dataset.bagHidden = '1';
  }

  function unhideEl(el) {
    el.style.display = '';
    delete el.dataset.bagHidden;
  }

  // The thread card wraps the root comment: hide the card for roots, the
  // renderer itself for sub-replies.
  function findHideTarget(unit) {
    if (unit.classList.contains('reply-item')) return unit;
    let node = unit;
    for (let i = 0; i < 8; i++) {
      const root = node.getRootNode();
      if (!(root instanceof ShadowRoot)) return unit;
      const host = root.host;
      if (!host) return unit;
      if (/^BILI-COMMENT-THREAD/.test(host.tagName)) {
        const primary = root.querySelector('bili-comment-renderer');
        return primary === unit ? host : unit;
      }
      node = host;
    }
    return unit;
  }

  // ---------- scan ----------

  function isUnitEl(el) {
    const tag = el.tagName || '';
    if (tag === 'BILI-COMMENT-RENDERER' || tag === 'BILI-COMMENT-THREAD-RENDERER') return true;
    if (tag.indexOf('BILI-COMMENT') === 0 && !UNIT_TAG_DENY.test(tag)) return true;
    return !!(el.classList && el.classList.contains('reply-item'));
  }

  function collectUnitEls() {
    const all = new Set();
    const host = document.querySelector(HOST_SEL);
    deepCollect(host ? host.shadowRoot || host : document, '*', all, 0);
    for (const el of document.querySelectorAll(CLASSIC_SEL)) all.add(el);
    return [...all].filter(isUnitEl);
  }

  async function scan() {
    if (state.scanBusy) return;
    state.scanBusy = true;
    try {
      if (location.href !== state.url) resetForNavigation();
      if (!state.settings.enabled) {
        applyDisabled();
        return;
      }
      const collected = await probeRequest('BAG_COLLECT', 'BAG_COLLECT_RESULT', PROBE_TIMEOUT_MS);
      if (collected) {
        state.probeAlive = true;
        mergePage(collected.page);
        for (const item of collected.items) state.itemsByUid.set(item.uid, item);
      }
      for (const el of collectUnitEls()) {
        if (state.processed.has(el)) continue;
        state.processed.add(el);
        state.units.set(ensureUid(el), { unit: el, hideTarget: findHideTarget(el) });
      }
      reevaluate();
    } finally {
      state.scanBusy = false;
    }
  }

  function reevaluate() {
    const nowHidden = new Set();
    let missingRpid = 0;
    let missingMid = 0;
    const freshRecords = [];
    for (const [uid, entry] of [...state.units]) {
      if (!entry.hideTarget.isConnected) {
        state.units.delete(uid);
        continue;
      }
      let item = state.itemsByUid.get(uid);
      if (!item || !item.rpid || !item.mid) {
        const probed = item;
        item = localExtract(entry.unit);
        if (probed) {
          item.rpid = item.rpid || probed.rpid || '';
          item.mid = item.mid || probed.mid || '';
          item.message = probed.message || item.message;
          item.uname = probed.uname || item.uname;
          if (!item.mentions.length) item.mentions = probed.mentions || [];
        }
        state.itemsByUid.set(uid, item);
      }
      if (!item.rpid) missingRpid++;
      if (!item.mid) missingMid++;
      const id = recordIdFor(item);
      entry.recordId = id;
      const rec = state.records[id];
      const finished = rec && (rec.status === 'deleted' || rec.status === 'blocked');
      const exempt = state.sessionRestored.has(id);
      let hide;
      if (finished) hide = true;
      else if (exempt) hide = false;
      else hide = shouldHide(item);
      if (hide) {
        hideEl(entry.hideTarget);
        nowHidden.add(id);
        if (!rec) {
          const record = makeRecord(item, id);
          state.records[id] = record;
          state.stats.captured++;
          freshRecords.push(record);
        }
      } else {
        unhideEl(entry.hideTarget);
      }
    }
    state.hiddenIds = nowHidden;
    state.missingRpid = missingRpid;
    state.missingMid = missingMid;
    state.unitCount = state.units.size;
    if (freshRecords.length) {
      scheduleSave();
      ensurePageInfo().then(() => {
        let dirty = false;
        for (const record of freshRecords) {
          const live = state.records[record.id];
          if (live && !live.oid && state.page && state.page.aid) {
            live.oid = state.page.aid;
            dirty = true;
          }
        }
        if (dirty) scheduleSave();
      });
    }
    updateChip();
  }

  function applyDisabled() {
    for (const [, entry] of state.units) unhideEl(entry.hideTarget);
    state.hiddenIds.clear();
    updateChip();
  }

  function resetForNavigation() {
    state.url = location.href;
    for (const [, entry] of state.units) unhideEl(entry.hideTarget);
    state.units.clear();
    state.processed = new WeakSet();
    state.itemsByUid.clear();
    state.sessionRestored.clear();
    state.hiddenIds.clear();
    state.page = null;
    updateChip();
    ensurePageInfo();
  }

  // ---------- chip ----------

  function updateChip() {
    const count = state.hiddenIds.size;
    if (!count) {
      if (state.chip) state.chip.classList.remove('bag-chip-on');
      return;
    }
    const chip = ensureChip();
    if (!chip) return;
    chip.textContent = `🛡 At Guard · 已隐藏 ${count} 条评论（含@） · 点击管理`;
    chip.classList.add('bag-chip-on');
  }

  function ensureChip() {
    if (state.chip && state.chip.isConnected) return state.chip;
    const host = document.querySelector(HOST_SEL) || document.querySelector('#commentapp');
    if (!host || !host.parentElement) return null;
    const chip = document.createElement('div');
    chip.className = 'bag-chip';
    chip.title = 'Bilibili At Guard';
    chip.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'BAG_OPEN_PANEL' }, () => void chrome.runtime.lastError);
      } catch {
        // extension context invalidated mid-session
      }
    });
    host.parentElement.insertBefore(chip, host);
    state.chip = chip;
    return chip;
  }

  // ---------- storage sync ----------

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.settings) {
      state.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (!state.settings.enabled) applyDisabled();
      else scan();
    }
    if (changes.rules) state.rules = changes.rules.newValue || [];
    if (changes.whitelist) {
      state.whitelist = changes.whitelist.newValue || [];
      reevaluate();
    }
    if (changes.records) {
      state.records = changes.records.newValue || {};
      reevaluate();
    }
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('BAG_')) return false;
    if (msg.type === 'BAG_RESTORE') {
      if (msg.bvid && state.page && state.page.bvid && msg.bvid !== state.page.bvid) {
        sendResponse({ ok: false, mismatch: true });
        return false;
      }
      state.sessionRestored.add(msg.id);
      reevaluate();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'BAG_API') {
      handleApiCall(msg.call, msg.params || {})
        .then(sendResponse)
        .catch((e) => sendResponse({ code: -1, message: String(e) }));
      return true;
    }
    if (msg.type === 'BAG_PAGE_STATS') {
      sendResponse({
        url: location.href,
        probe: state.probeAlive,
        units: state.unitCount,
        hidden: state.hiddenIds.size,
        missingRpid: state.missingRpid,
        missingMid: state.missingMid,
        bvid: (state.page && state.page.bvid) || urlBvid(),
        aid: (state.page && state.page.aid) || '',
      });
      return false;
    }
    if (msg.type === 'BAG_RESCAN') {
      scan();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }

  async function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    if (m) return m[1];
    try {
      const res = await chrome.runtime.sendMessage({ type: 'BAG_CSRF' });
      return (res && res.csrf) || '';
    } catch {
      return '';
    }
  }

  // Write APIs must be sent from the page context: bilibili's gateway rejects
  // extension-origin POSTs (no page Referer/Origin) with HTTP 412.
  async function handleApiCall(call, params) {
    const csrf = await getCsrf();
    if (!csrf) return { code: -101, message: '未登录（未读取到 bili_jct），请先登录 bilibili' };
    const isDel = call === 'del';
    const body = isDel
      ? { oid: String(params.oid), type: '1', rpid: String(params.rpid), csrf }
      : { fid: String(params.mid), act: call === 'unblock' ? '6' : '5', csrf };
    const res = await fetch(
      isDel ? 'https://api.bilibili.com/x/v2/reply/del' : 'https://api.bilibili.com/x/relation/modify',
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      },
    );
    const data = await res.json().catch(() => null);
    return data || { code: -1, message: `HTTP ${res.status}` };
  }

  // ---------- watchers ----------

  function startWatchers() {
    let debounce = 0;
    const observer = new MutationObserver(() => {
      if (!state.settings.enabled) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => scan(), 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (state.settings.enabled && document.visibilityState === 'visible') scan();
    }, SCAN_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scan();
    });
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => onRuntimeMessage(msg, sender, sendResponse));
  }

  async function init() {
    const stored = await chrome.storage.local.get(['settings', 'rules', 'whitelist', 'records', 'stats']);
    state.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    state.rules = stored.rules || [];
    state.whitelist = stored.whitelist || [];
    state.records = stored.records || {};
    state.stats = { ...DEFAULT_STATS, ...(stored.stats || {}) };
    if (!stored.settings) {
      await chrome.storage.local.set({ settings: state.settings, stats: state.stats });
    }
    await ensurePageInfo();
    await scan();
    startWatchers();
  }

  init();
})();
