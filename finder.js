'use strict';
// gl.cold.fyi's finder (DECISIONS #45, #111): one address shape for every public link, gl.cold.fyi/<unit>/...
// Pure: no DOM, no network. 404.html and watch/index.html load it; src/test/js/finder.test.js runs it under Node.
//
//   /<unit>                  the dashboard          /<unit>/<role>     the dashboard as that role (?role=)
//   /<unit>/watch            that unit's WATCH FROM HOME, never another unit's
//   /<unit>/s/<token>        a share link (DECISIONS #97); the token's box id must match the entry's
//   /<unit>/night[/<date>]   the END OF NIGHT card (the box itself says "not shared" for a night that isn't)
//
// here.json / watch.json: {boxes: {<unit name>: {...}}}, written by each box. Same Wi-Fi as the box (its hashed
// public address matches ours, seen in the last 8 h): its address on that Wi-Fi. Otherwise its WATCH FROM HOME link
// (a trycloudflare.com link under 24 h old). Otherwise: not reachable right now. Entries from before #111 have no
// box / number / label and still work.
const Finder = (() => {
  const ROLES = ['dj', 'photo', 'vj', 'lights', 'tech', 'manager'];
  const LIVE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/;
  const NAME = /^[a-z0-9][a-z0-9-]{1,23}$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TOKEN = /^[A-Za-z0-9_-]{10,1500}\.[A-Za-z0-9_-]{40,200}$/;
  const HERE_FOR = 8 * 3600 * 1000, LIVE_FOR = 24 * 3600 * 1000;

  /** The JSON inside a share token (not checked: the box checks the signature), or null. */
  function tokenBody(token) {
    if (!TOKEN.test(token || '')) return null;
    try {
      const b = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const bin = typeof atob === 'function' ? atob(b + '='.repeat((4 - b.length % 4) % 4)) : Buffer.from(b, 'base64').toString('binary');
      const text = decodeURIComponent(bin.split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
      const o = JSON.parse(text);
      return o && typeof o.box === 'string' && /^gl[0-9a-z]{12}$/.test(o.box) ? o : null;
    } catch (e) { return null; }
  }

  /** What the path asks for: {name, what: home|watch|share|night, role, token, night} or {bad: true}. */
  function parse(pathname, search) {
    const raw = String(pathname || '').split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return ''; } });
    const name = (raw[0] || '').toLowerCase(), second = (raw[1] || '').toLowerCase();
    if (!NAME.test(name)) return { bad: true };
    const to = new URLSearchParams(search || '').get('to');
    if (second === 's') return { name, what: 'share', token: raw[2] || '', to: to === 'decks' || to === 'now' ? to : '' };
    if (second === 'watch') return { name, what: 'watch' };
    if (second === 'night') {
      const d = raw[2] || '';
      return DATE.test(d) || !d ? { name, what: 'night', night: d } : { name, what: 'night', night: '', badDate: true };
    }
    return { name, what: 'home', role: ROLES.includes(second) ? second : '' };
  }

  /** The path on the box for what was asked. */
  function rest(p) {
    if (p.what === 'share') return '/s/' + p.token + (p.to ? '?to=' + p.to : '');
    if (p.what === 'night') return '/endnight.html' + (p.night ? '?night=' + p.night : '');
    if (p.what === 'home' && p.role) return '/?role=' + p.role;
    return '/';
  }

  /** This unit's entry in one file. For a share link: the entry whose box id is the token's (any name, so a renamed
   *  unit's links still work); an entry under the name with another box id is ignored; one with no box id is used. */
  function entry(file, name, box) {
    const boxes = (file && file.boxes) || {};
    const e = boxes[name];
    if (!box) return e || null;
    if (e && e.box === box) return e;
    for (const k of Object.keys(boxes)) if (boxes[k] && boxes[k].box === box) return boxes[k];
    return e && !e.box ? e : null;
  }

  /** "UNIT 01 · GHOSTLINK" (or just the name for an entry from before #111). */
  function title(name, ...entries) {
    const label = entries.map(e => e && e.label).find(l => typeof l === 'string' && /^UNIT \d{2}$/.test(l));
    return (label ? label + ' · ' : '') + name.toUpperCase();
  }

  /**
   * Where to send this phone. In: {path, search, here, watch, net (our hashed public address, or null), now}.
   * Out: {kind, title, url?, name?}. kind: lan | live (go to url) · off (not reachable right now) · unknown (no unit
   * by that name) · wrongbox (the link is for another box) · ended (the share link expired) · bad (not a unit path).
   */
  function route(o) {
    const p = parse(o.path, o.search), now = o.now || Date.now();
    if (p.bad) return { kind: 'bad', title: 'GHOST LINK' };
    let box = null;
    if (p.what === 'share') {
      const t = tokenBody(p.token);
      if (!t) return { kind: 'ended', name: p.name, title: p.name.toUpperCase(), why: 'bad' };
      if (typeof t.exp === 'number' && t.exp < now) return { kind: 'ended', name: p.name, title: p.name.toUpperCase(), why: 'expired' };
      box = t.box;
    }
    const h = entry(o.here, p.name, box), w = entry(o.watch, p.name, box);
    const t = title(p.name, h, w);
    if (!h && !w) {
      const named = (o.here && o.here.boxes && o.here.boxes[p.name]) || (o.watch && o.watch.boxes && o.watch.boxes[p.name]);
      return { kind: box && named ? 'wrongbox' : 'unknown', name: p.name, title: t, what: p.what };
    }
    if (h && o.net && h.net === o.net && /^[0-9.]{7,15}$/.test(h.lan || '') && now - (h.seen || 0) < HERE_FOR)
      return { kind: 'lan', name: p.name, title: t, what: p.what, url: 'http://' + h.lan + rest(p) };
    if (w && w.url && LIVE.test(w.url) && now - (w.since || 0) < LIVE_FOR)
      return { kind: 'live', name: p.name, title: t, what: p.what, url: w.url.replace(/\/$/, '') + rest(p) };
    return { kind: 'off', name: p.name, title: t, what: p.what };
  }

  /** gl.cold.fyi/watch: every live room, labelled "UNIT 01 · MAIN ROOM". ?room= / ?unit= pick one. */
  function rooms(watch, now, want, unit) {
    now = now || Date.now();
    const boxes = (watch && watch.boxes) || {};
    return Object.keys(boxes).map(k => Object.assign({ name: k }, boxes[k]))
      .filter(b => b.url && LIVE.test(b.url) && now - (b.since || 0) < LIVE_FOR)
      .filter(b => !want || (b.room || '').toLowerCase() === String(want).toLowerCase())
      .filter(b => !unit || b.name === String(unit).toLowerCase())
      .map(b => ({ url: b.url, name: b.name,
        text: (typeof b.label === 'string' && /^UNIT \d{2}$/.test(b.label) ? b.label + ' · ' : '') + String(b.room || b.name || 'LIVE').toUpperCase() }));
  }

  return { route, rooms, parse, tokenBody, entry, title, ROLES };
})();
if (typeof module !== 'undefined') module.exports = Finder;
