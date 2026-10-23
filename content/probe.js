// Bilibili At Guard — main-world probe.
// Isolated-world content scripts cannot read page JS globals or the JS
// properties bilibili's renderer web components carry (rpid/mid/message live
// there, not in attributes). This probe answers postMessage requests with the
// extracted data; attribute/anchor parsing is only the fallback path.
(() => {
  'use strict';

  const DATA_PROPS = ['data', 'commentData', 'item', 'comment', 'info', 'renderData'];
  const SPACE_RE = /space\.bilibili\.com\/(\d+)/;
  const extracted = new WeakMap();
  let uidSeq = 0;

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

  const UNIT_TAG_DENY = /(-REPLIES-|-BOX-|-USER-INFO|-ACTION-|-RICH-TEXT|-SORT|-HEADER|-COUNT|-PAGER)/;

  function isUnitEl(el) {
    const tag = el.tagName || '';
    if (tag === 'BILI-COMMENT-RENDERER' || tag === 'BILI-COMMENT-THREAD-RENDERER') return true;
    if (tag.indexOf('BILI-COMMENT') === 0 && !UNIT_TAG_DENY.test(tag)) return true;
    return !!(el.classList && el.classList.contains('reply-item'));
  }

  function readData(el) {
    for (const prop of DATA_PROPS) {
      try {
        const d = el[prop];
        if (d && typeof d === 'object') return d;
      } catch {
        // a getter may throw before the component is wired up
      }
    }
    return null;
  }

  function spaceAnchors(el) {
    const out = [];
    for (const a of deepCollect(el, 'a', new Set(), 0)) {
      const m = String(a.getAttribute('href') || a.href || '').match(SPACE_RE);
      if (!m) continue;
      const name = (a.textContent || '').trim().replace(/^@+/, '');
      out.push({ mid: m[1], isMention: (a.textContent || '').trim().startsWith('@'), name: name.slice(0, 40) });
    }
    return out;
  }

  // Incomplete items are not cached: component data may arrive after first paint.
  function extract(unit) {
    const cached = extracted.get(unit);
    if (cached) return cached;
    let uid = unit.getAttribute('data-bag-uid');
    if (!uid) {
      uid = 'u' + ++uidSeq + Math.random().toString(36).slice(2, 7);
      unit.setAttribute('data-bag-uid', uid);
    }
    const d = readData(unit);
    const anchors = spaceAnchors(unit);
    let rpid = '';
    let mid = '';
    let uname = '';
    try {
      if (d && d.rpid != null) rpid = String(d.rpid);
      if (d && d.member && d.member.mid != null) {
        mid = String(d.member.mid);
        uname = String(d.member.uname || '');
      }
    } catch {
      // property reads stay best-effort
    }
    if (!rpid) rpid = unit.getAttribute('data-id') || '';
    if (!mid) {
      const author = anchors.find((a) => !a.isMention);
      if (author) {
        mid = author.mid;
        uname = uname || author.name;
      }
    }
    let message = '';
    try {
      if (d && d.content && typeof d.content.message === 'string') message = d.content.message;
    } catch {
      // ignore
    }
    if (!message) message = (unit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const item = {
      uid,
      rpid,
      mid,
      uname,
      message,
      mentions: anchors.filter((a) => a.isMention).map((a) => ({ mid: a.mid, name: a.name })),
    };
    if (item.rpid && item.mid) extracted.set(unit, item);
    return item;
  }

  function pageInfo() {
    const s = window.__INITIAL_STATE__ || {};
    const vd = s.videoData || {};
    const cookieMid = (document.cookie.match(/DedeUserID=(\d+)/) || [])[1] || '';
    return {
      bvid: vd.bvid || (location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] || '',
      aid: vd.aid != null ? String(vd.aid) : s.aid != null ? String(s.aid) : '',
      ownerMid: vd.owner && vd.owner.mid != null ? String(vd.owner.mid) : '',
      title: vd.title || document.title.replace(/_哔哩哔哩_bilibili.*$/, '').replace(/_bilibili.*$/, ''),
      myMid: cookieMid,
    };
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window) return;
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('BAG_')) return;
    if (msg.type === 'BAG_PAGE_INFO') {
      window.postMessage({ type: 'BAG_PAGE_INFO_RESULT', page: pageInfo(), from: 'bag-probe' }, location.origin);
      return;
    }
    if (msg.type === 'BAG_COLLECT') {
      const host = document.querySelector('bili-comments');
      const root = (host && host.shadowRoot) || host || document;
      const all = deepCollect(root, '*', new Set(), 0);
      for (const el of document.querySelectorAll('.reply-item')) all.add(el);
      const items = [...all].filter(isUnitEl).map(extract);
      window.postMessage(
        { type: 'BAG_COLLECT_RESULT', page: pageInfo(), items, from: 'bag-probe' },
        location.origin,
      );
    }
  });
})();
