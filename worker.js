// Сервер мультиплеера и лидеров для Cloudflare Workers + Durable Objects.
// Секрет BOT_TOKEN (токен бота) нужен для проверки пользователей Telegram. Без него работает dev-режим.
class Room {
  constructor(code, pub) { this.code = code; this.pub = pub; this.pl = new Map(); this.state = 'lobby'; this.host = null; this.cd = 0; this.iv = null; this.tm = null; }
  bc(m) { const j = JSON.stringify(m); for (const p of this.pl.values()) try { p.ws.send(j); } catch (e) {} }
  lobby() { this.bc({ t: 'lobby', code: this.code, host: this.host, pub: this.pub, cd: this.cd, pl: [...this.pl].map(([id, p]) => ({ id, n: p.n })) }); }
  timer() { // публичная комната стартует через 6 с после появления второго игрока
    if (this.tm) return; this.cd = 6; this.lobby();
    this.tm = setInterval(() => {
      this.cd--;
      if (this.cd <= 0 || this.pl.size < 2 || this.state !== 'lobby') {
        clearInterval(this.tm); this.tm = null; this.cd = 0;
        if (this.pl.size >= 2 && this.state === 'lobby') this.start(); else this.lobby();
      } else this.lobby();
    }, 1000);
  }
  start() {
    this.state = 'run';
    for (const p of this.pl.values()) Object.assign(p, { d: 0, l: 0, j: 0, x: 0, c: 0 });
    this.bc({ t: 'start', seed: 1 + Math.floor(Math.random() * 2 ** 31), pl: [...this.pl].map(([id, p]) => ({ id, n: p.n })) });
    let endat = 0;
    this.iv = setInterval(() => {
      const alive = [...this.pl.values()].filter(p => !p.x), o = {};
      for (const [id, p] of this.pl) o[id] = { d: Math.round(p.d), l: Math.round(p.l * 100) / 100, j: p.j, x: p.x };
      this.bc({ t: 's', p: o });
      if (alive.length === 1 && this.pl.size > 1 && !endat) endat = Date.now() + 8000; // последнему выжившему ещё 8 с
      if (this.pl.size <= 1 || !alive.length || (endat && Date.now() > endat)) this.end();
    }, 100);
  }
  end() {
    clearInterval(this.iv); this.iv = null;
    const res = [...this.pl.values()].map(p => ({ n: p.n, d: Math.round(p.d), c: p.c })).sort((a, b) => b.d - a.d);
    this.state = 'lobby'; this.bc({ t: 'end', res }); this.lobby();
  }
  stop() { clearInterval(this.iv); clearInterval(this.tm); }
}

export class Hub {
  constructor(state, env) { this.st = state; this.env = env; this.rooms = new Map(); this.scores = null; }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('ok');
    if (!this.scores) this.scores = (await this.st.storage.get('scores')) || {};
    const [c, s] = Object.values(new WebSocketPair()); s.accept(); this.attach(s);
    return new Response(null, { status: 101, webSocket: c });
  }
  async verify(init, name) {
    if (!this.env.BOT_TOKEN) return ['dev' + Math.random().toString(36).slice(2, 10), name];
    try {
      const p = new URLSearchParams(init), h = p.get('hash'); p.delete('hash');
      const s = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => k + '=' + v).join('\n'), en = new TextEncoder();
      const hm = async (k, d) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), en.encode(d)));
      const key = await hm(en.encode('WebAppData'), this.env.BOT_TOKEN), hex = [...await hm(key, s)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hex !== h) return null;
      const u = JSON.parse(p.get('user')); return [String(u.id), String(u.first_name || 'Игрок').slice(0, 16)];
    } catch (e) { return null; }
  }
  attach(ws) {
    let pid = null, name = '', room = null, q = Promise.resolve();
    const out = o => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
    const leave = () => {
      if (room && room.pl.has(pid)) {
        room.pl.delete(pid);
        if (!room.pl.size) { this.rooms.delete(room.code); room.stop(); }
        else { if (room.host === pid) room.host = room.pl.keys().next().value; room.lobby(); }
      }
      room = null;
    };
    const num = (v, d = 0) => Number.isFinite(+v) ? +v : d;
    const handle = async e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      const t = m.t;
      if (t === 'hello') {
        const r = await this.verify(String(m.init || ''), String(m.name || 'Игрок').slice(0, 16));
        if (!r) return out({ t: 'err', m: 'Ошибка авторизации' });
        [pid, name] = r; return out({ t: 'me', id: pid });
      }
      if (!pid) return;
      if (t === 'top') out({ t: 'top', list: Object.values(this.scores).sort((a, b) => b.d - a.d).slice(0, 20) });
      else if (t === 'score') {
        const d = Math.max(0, Math.min(Math.floor(num(m.d)), 100000));
        if (d > ((this.scores[pid] || {}).d || 0)) { this.scores[pid] = { n: name, d }; this.st.storage.put('scores', this.scores); }
      } else if (t === 'find' || t === 'create' || t === 'join') {
        leave();
        if (t === 'join') {
          room = this.rooms.get(String(m.code || ''));
          if (!room || room.state !== 'lobby' || room.pl.size >= 4) { room = null; return out({ t: 'err', m: 'Комната не найдена или занята' }); }
        } else if (t === 'find') room = [...this.rooms.values()].find(r => r.pub && r.state === 'lobby' && r.pl.size < 4) || null;
        if (!room) {
          let c; do c = String(1000 + Math.floor(Math.random() * 9000)); while (this.rooms.has(c));
          room = new Room(c, t === 'find'); this.rooms.set(c, room); room.host = pid;
        }
        room.pl.set(pid, { ws, n: name, d: 0, l: 0, j: 0, x: 0, c: 0 });
        room.lobby(); if (room.pub && room.pl.size >= 2) room.timer();
      } else if (t === 'go') { if (room && room.host === pid && room.pl.size > 1 && room.state === 'lobby') room.start(); }
      else if (t === 'p' && room && room.state === 'run' && room.pl.has(pid)) Object.assign(room.pl.get(pid), { d: num(m.d), l: num(m.l), j: num(m.j), c: Math.floor(num(m.c)) });
      else if (t === 'dead' && room && room.pl.has(pid)) Object.assign(room.pl.get(pid), { d: num(m.d), c: Math.floor(num(m.c)), x: 1 });
      else if (t === 'leave') leave();
    };
    ws.addEventListener('message', e => { q = q.then(() => handle(e)).catch(() => {}); });
    ws.addEventListener('close', leave); ws.addEventListener('error', leave);
  }
}

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === '/ws') return env.HUB.get(env.HUB.idFromName('main')).fetch(req);
    return env.ASSETS.fetch(req);
  }
};
