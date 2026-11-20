// تحويشة push worker
// - GET  /vapid          → public key the app subscribes with
// - POST /sync           → {id, sub, reminders:[{at,tag,title,body}]} or {id, remove:true}
// - POST /test           → {id} sends a test notification now
// - cron (every 15 min)  → sends reminders whose time has come
import { sendPush } from './webpush.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vapid(env) {
  let v = await env.TW.get('vapid', 'json');
  if (v) return v;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJWK = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicKey = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  v = { privateJWK, publicKey };
  await env.TW.put('vapid', JSON.stringify(v));
  return v;
}

async function send(env, sub, payload) {
  const v = await vapid(env);
  try {
    return await sendPush(sub, payload, v, { subject: env.SUBJECT || 'mailto:tahwisha@example.com' });
  } catch (e) {
    console.log('push failed', String(e));
    return 0;
  }
}

const validId = id => typeof id === 'string' && /^[a-z0-9]{8,40}$/.test(id);

function cleanReminders(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 80).filter(r => r && Number.isFinite(r.at)).map(r => ({
    at: Math.round(r.at),
    tag: String(r.tag || '').slice(0, 80),
    title: String(r.title || '').slice(0, 120),
    body: String(r.body || '').slice(0, 300),
  }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/vapid' && req.method === 'GET') {
      const v = await vapid(env);
      return json({ publicKey: v.publicKey });
    }

    if (url.pathname === '/sync' && req.method === 'POST') {
      const d = await req.json().catch(() => null);
      if (!d || !validId(d.id)) return json({ error: 'bad id' }, 400);
      const key = 'u:' + d.id;
      if (d.remove) { await env.TW.delete(key); return json({ ok: true }); }
      if (!d.sub || !d.sub.endpoint || !d.sub.keys) return json({ error: 'bad sub' }, 400);
      const next = { sub: d.sub, reminders: cleanReminders(d.reminders) };
      const prev = await env.TW.get(key);
      const str = JSON.stringify(next);
      if (prev !== str) await env.TW.put(key, str);   // اكتب بس لو حاجة اتغيرت
      return json({ ok: true, count: next.reminders.length });
    }

    if (url.pathname === '/test' && req.method === 'POST') {
      const d = await req.json().catch(() => null);
      if (!d || !validId(d.id)) return json({ error: 'bad id' }, 400);
      const u = await env.TW.get('u:' + d.id, 'json');
      if (!u) return json({ error: 'not subscribed' }, 404);
      const status = await send(env, u.sub, { title: 'تحويشة شغالة ✓', body: 'التنبيهات هتوصلك هنا في مواعيدها.', tag: 'test' });
      return json({ ok: status >= 200 && status < 300, status });
    }

    if (url.pathname === '/') return json({ ok: true, name: 'tahwisha-push' });
    return json({ error: 'not found' }, 404);
  },

  async scheduled(_event, env) {
    const now = Date.now();
    let cursor;
    do {
      const page = await env.TW.list({ prefix: 'u:', cursor });
      for (const k of page.keys) {
        const u = await env.TW.get(k.name, 'json');
        if (!u || !u.sub) continue;
        const due = u.reminders.filter(r => r.at <= now);
        if (!due.length) continue;
        let gone = false;
        for (const r of due) {
          if (now - r.at > 6 * 3600 * 1000) continue;   // قديم أوي، فوّته
          const status = await send(env, u.sub, { title: r.title, body: r.body, tag: r.tag }).catch(() => 0);
          if (status === 404 || status === 410) { gone = true; break; }
        }
        if (gone) { await env.TW.delete(k.name); continue; }
        u.reminders = u.reminders.filter(r => r.at > now);
        await env.TW.put(k.name, JSON.stringify(u));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  },
};
