// Bilibili At Guard — service worker.
// Owns bilibili GET APIs (nav/view), the bili_jct cookie read, and
// side-panel opening. Write APIs (delete/block) are sent from the content
// script instead: bilibili's gateway rejects extension-origin POSTs with
// HTTP 412 because they lack the page Referer/Origin.
(() => {
  'use strict';

  const NAV_TTL_MS = 6 * 60 * 60 * 1000;

  async function getCsrf() {
    const cookie = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'bili_jct' });
    return cookie ? cookie.value : '';
  }

  async function getMyInfo() {
    const { myInfo } = await chrome.storage.local.get('myInfo');
    if (myInfo && Date.now() - myInfo.ts < NAV_TTL_MS) return myInfo;
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
      });
      const json = await res.json();
      const info = {
        isLogin: !!(json.data && json.data.isLogin),
        mid: json.data && json.data.mid != null ? String(json.data.mid) : '',
        uname: (json.data && json.data.uname) || '',
        ts: Date.now(),
      };
      await chrome.storage.local.set({ myInfo: info });
      return info;
    } catch (e) {
      return { isLogin: false, mid: '', uname: '', error: String(e), ts: Date.now() };
    }
  }

  async function getVideoInfo(bvid) {
    const { videoInfos } = await chrome.storage.local.get('videoInfos');
    const infos = videoInfos || {};
    if (infos[bvid]) return infos[bvid];
    try {
      const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
      const json = await res.json();
      if (json.code !== 0 || !json.data) {
        return { error: json.message || `code ${json.code}` };
      }
      const info = {
        aid: json.data.aid != null ? String(json.data.aid) : '',
        ownerMid: json.data.owner && json.data.owner.mid != null ? String(json.data.owner.mid) : '',
        ownerName: (json.data.owner && json.data.owner.name) || '',
        title: json.data.title || '',
        ts: Date.now(),
      };
      infos[bvid] = info;
      await chrome.storage.local.set({ videoInfos: infos });
      return info;
    } catch (e) {
      return { error: String(e) };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('BAG_')) return;
    switch (msg.type) {
      case 'BAG_OPEN_PANEL': {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: 'no tab' });
          return;
        }
        chrome.sidePanel
          .open({ tabId })
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      case 'BAG_NAV': {
        getMyInfo().then(sendResponse);
        return true;
      }
      case 'BAG_VIEW': {
        getVideoInfo(String(msg.bvid || '')).then(sendResponse);
        return true;
      }
      case 'BAG_CSRF': {
        getCsrf().then((csrf) => sendResponse({ csrf }));
        return true;
      }
      default:
        return;
    }
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // older Chromium without openPanelOnActionClick
  });

  // Pending records only matter while the browsing run that captured them is
  // alive: a video from a previous run is unlikely to be managed again, so on
  // every browser start drop status='hidden' records and keep deleted/blocked
  // history.
  async function clearStalePending() {
    const { records } = await chrome.storage.local.get('records');
    if (!records) return;
    const kept = {};
    let dirty = false;
    for (const [id, rec] of Object.entries(records)) {
      if (rec && rec.status === 'hidden') dirty = true;
      else kept[id] = rec;
    }
    if (dirty) await chrome.storage.local.set({ records: kept });
  }

  chrome.runtime.onStartup.addListener(() => {
    clearStalePending().catch(() => {});
  });
})();
