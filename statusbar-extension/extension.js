// Agent Hub for Antigravity / VS Code
//  • status bar (active Claude account + agents needing you)
//  • dashboard (editor tab + Activity Bar view): Accounts │ Agents │ Agent Map │ Platforms & Models │ Logs
// Talks to the local hub (127.0.0.1, bearer token from ~/.claude-accounts/hub.json): REST + Server-Sent Events.
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = path.join(os.homedir(), '.claude-accounts');
const HUB_JSON = path.join(DATA, 'hub.json');
const STATUS_JSON = path.join(DATA, 'status.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ───────────── hub client ─────────────
function hubInfo() { return readJson(HUB_JSON); }
function api(method, p, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const info = hubInfo();
    if (!info?.port) return reject(new Error('Agent Hub is not running (cam doctor).'));
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: info.port, method, path: p, timeout: timeoutMs,
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        let j; try { j = s ? JSON.parse(s) : {}; } catch { j = { error: s }; }
        res.statusCode >= 400 ? reject(Object.assign(new Error(j.error || `HTTP ${res.statusCode}`), { code: j.code })) : resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Hub request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** SSE connection with automatic reconnect (hub restarts are normal). */
function connectStream(onEvent, onState) {
  let req = null, stopped = false, timer = null;
  const open = () => {
    if (stopped) return;
    const info = hubInfo();
    if (!info?.port) { onState(false); timer = setTimeout(open, 5000); return; }
    req = http.get({ host: '127.0.0.1', port: info.port, path: '/api/stream', headers: { Authorization: `Bearer ${info.token}` } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); onState(false); timer = setTimeout(open, 5000); return; }
      onState(true);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) { try { onEvent(type, JSON.parse(data)); } catch {} }
        }
      });
      res.on('end', () => { onState(false); timer = setTimeout(open, 3000); });
    });
    req.on('error', () => { onState(false); timer = setTimeout(open, 5000); });
  };
  open();
  return { dispose() { stopped = true; clearTimeout(timer); try { req?.destroy(); } catch {} } };
}

// ───────────── webview ─────────────
function html(nonce, compact) {
  return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
/* Agent Hub: one system. Neutral surfaces follow the editor theme; colour only carries meaning
   (Apple system colours, no violet). One button pair, one radius scale, one card style. */
:root{
  --bg:var(--vscode-editor-background);--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);
  --fill:color-mix(in srgb,var(--fg) 5%,var(--bg));--fill-2:color-mix(in srgb,var(--fg) 9%,var(--bg));--fill-3:color-mix(in srgb,var(--fg) 14%,var(--bg));
  --sep:color-mix(in srgb,var(--fg) 11%,transparent);--track:color-mix(in srgb,var(--fg) 12%,transparent);
  --line:var(--sep);--panel:var(--fill);--hover:var(--fill-2);
  --accent:#0a84ff;--ok:#30d158;--warn:#ff9f0a;--err:#ff453a;--info:#0a84ff;--idle:#98989d;
  --sel:color-mix(in srgb,var(--accent) 16%,var(--bg));--selfg:var(--fg);
  --input:var(--vscode-input-background);--inputfg:var(--vscode-input-foreground);--inputline:var(--sep);
  --mono:var(--vscode-editor-font-family,Consolas,monospace);
  --font:"Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  --r-lg:12px;--r:8px;--r-sm:6px}
body.vscode-light{--accent:#0066cc;--info:#0066cc;--ok:#248a3d;--warn:#b25000;--err:#d70015;--idle:#6e6e73;--fill:color-mix(in srgb,var(--fg) 4%,var(--bg))}
body.vscode-high-contrast{--sep:var(--vscode-contrastBorder,#6fc3df);--fill:var(--bg)}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 var(--font);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;overflow:hidden}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
b,strong{font-weight:600}

/* one button pair: filled accent + quiet fill; ghost for low-priority actions */
button{font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;border:0;border-radius:var(--r-sm);padding:5px 12px;background:var(--fill-2);color:var(--fg);transition:background .12s,transform .08s;white-space:nowrap;line-height:1.4}
button:hover{background:var(--fill-3)}
button:active{transform:scale(.97)}
button.primary{background:var(--accent);color:#fff}
button.primary:hover{background:color-mix(in srgb,var(--accent) 86%,#000)}
button.ghost{background:transparent;color:var(--muted)}
button.ghost:hover{background:var(--fill-2);color:var(--fg)}
button:disabled{opacity:.4;cursor:default;transform:none}
input,select,textarea{font:inherit;background:var(--input);color:var(--inputfg);border:1px solid var(--sep);border-radius:var(--r-sm);padding:6px 9px;width:100%}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
textarea{resize:vertical;font-family:inherit}

/* header: name + segmented control + live status */
header{display:flex;align-items:center;gap:16px;padding:10px 20px;flex:none;flex-wrap:wrap;border-bottom:1px solid var(--sep)}
header .title{font-weight:600;font-size:14px;letter-spacing:-.01em}
nav{display:inline-flex;gap:2px;background:var(--fill-2);border-radius:var(--r);padding:2px;flex-wrap:wrap}
nav button{background:transparent;color:var(--muted);padding:4px 12px;border-radius:6px}
nav button:hover{background:transparent;color:var(--fg)}
nav button:active{transform:none}
nav button.on{background:var(--bg);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.2),0 0 0 .5px var(--sep)}
nav button .n{font-size:11px;color:var(--muted);margin-left:6px;font-variant-numeric:tabular-nums}
.chips{display:flex;gap:14px;margin-left:auto;color:var(--muted);font-size:12px;align-items:center}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--idle);vertical-align:middle;margin-right:6px;flex:none}
.s-working .dot,.dot.s-working{background:var(--ok)}.dot.s-done,.s-done .dot{background:var(--idle)}.dot.s-needs,.s-needs .dot{background:var(--warn)}
.dot.s-error,.s-error .dot{background:var(--err)}.dot.s-waiting,.s-waiting .dot{background:var(--warn);opacity:.65}.dot.on{background:var(--ok)}.dot.off{background:var(--err)}

main{flex:1;min-height:0;overflow:auto}
.pad{padding:22px 24px 36px;max-width:1180px}
h3{font-size:13px;font-weight:600;color:var(--fg);margin:28px 0 8px 2px}
.muted{color:var(--muted)}.mono{font-family:var(--mono);font-size:12px}.small{font-size:12px}.right{text-align:right}
.empty{color:var(--muted);padding:48px 24px;text-align:center}
.howto{font-size:12.5px;color:var(--muted);margin:6px 0 16px;max-width:86ch}
.loading{color:var(--muted);font-size:12px;padding:10px 0}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--track);border-top-color:var(--accent);border-radius:50%;animation:camspin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes camspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation-duration:2s!important}}

/* grouped lists (one card style): rounded fill, inset separators */
.box{background:var(--fill);border-radius:var(--r-lg);overflow:hidden}
.checklist .ci{position:relative;display:flex;align-items:center;gap:12px;padding:11px 16px;min-height:50px}
.checklist .ci+.ci::before,.box>.item+.item::before,.nested::before{content:"";position:absolute;top:0;left:16px;right:0;height:1px;background:var(--sep)}
.ci .grow{flex:1;min-width:0}
.ci .t{font-weight:500;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ci .d{font-size:12px;color:var(--muted);margin-top:1px;max-width:80ch}
.nested{position:relative;background:color-mix(in srgb,var(--fg) 2.5%,transparent)}
.nested .ci{padding-left:46px}
.nested .ci+.ci::before{left:46px}
.disclose{cursor:pointer;user-select:none}
.disclose:hover{background:color-mix(in srgb,var(--fg) 3%,transparent)}
.chev{display:inline-grid;place-items:center;width:14px;color:var(--muted);transition:transform .15s;font-size:14px;vertical-align:-1px}
.disclose.open .chev{transform:rotate(90deg)}
.badge,.pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap;line-height:1.6;border:0}
.b-ok,.pill.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.b-warn,.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.b-err,.pill.err{background:color-mix(in srgb,var(--err) 16%,transparent);color:var(--err)}
.b-info,.pill.info{background:color-mix(in srgb,var(--info) 16%,transparent);color:var(--info)}
.b-idle,.pill{background:var(--track);color:var(--muted)}
.mono-badge{width:30px;height:30px;border-radius:7px;background:var(--fill-2);display:grid;place-items:center;font-size:11px;font-weight:600;color:var(--fg);flex:none}

/* home: the active account with its two rings, then a quiet strip of facts */
.hero{display:flex;align-items:center;gap:24px;padding:20px 22px;background:var(--fill);border-radius:var(--r-lg);flex-wrap:wrap}
.hero .rings{flex:none}
.hero .who{flex:1;min-width:240px}
.hero .k{font-size:12px;color:var(--muted)}
.hero .e{font-size:20px;font-weight:600;letter-spacing:-.015em;margin:2px 0 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hero .ln{display:flex;align-items:center;gap:8px;font-size:12.5px;margin:3px 0}
.hero .ln i{width:10px;height:10px;border-radius:50%;flex:none}
.hero .ln b{font-variant-numeric:tabular-nums}
.hero .hero-acts{display:flex;flex-direction:column;gap:8px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:12px}
.stats .st{padding:12px 16px;position:relative}
.stats .st+.st::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:1px;background:var(--sep)}
.stats .v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.stats .s{font-size:12px;color:var(--muted)}
.quick{display:flex;gap:8px;margin:12px 0 0;flex-wrap:wrap}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.tile{background:var(--fill);border-radius:var(--r-lg);padding:12px 16px}
.tile .k{font-size:12px;color:var(--muted)}.tile .v{font-size:18px;font-weight:600}.tile .s{font-size:12px;color:var(--muted)}

/* usage meters */
.metric{margin:10px 0 0}
.metric .row{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}
.bar{height:6px;background:var(--track);border-radius:3px;overflow:hidden;min-width:80px}.bar i{display:block;height:100%;border-radius:3px}

/* accounts: sidebar of platforms + account cards */
.acctwrap{display:flex;height:100%}
.pmenu{width:228px;flex:none;border-right:1px solid var(--sep);overflow:auto;padding:12px 8px}
.pitem{display:flex;align-items:center;gap:10px;padding:7px 10px;cursor:pointer;border-radius:var(--r);margin:1px 0}
.pitem:hover{background:var(--fill-2)}
.pitem.sel{background:var(--sel);color:var(--selfg)}
.pitem .cnt{margin-left:auto;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.acards{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.acard{background:var(--fill);border-radius:var(--r-lg);padding:14px 16px;display:flex;flex-direction:column;gap:6px}
.acard.live{box-shadow:inset 0 0 0 1.5px var(--accent)}
.acard .h{display:flex;align-items:center;gap:8px}
.acard .h b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.acard .id{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acard .warnline{font-size:12px;color:var(--warn)}
.acard .acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:10px;border-top:1px solid var(--sep)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{background:var(--fill);border-radius:var(--r-lg);padding:14px 16px}

/* tables live inside grouped boxes */
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:9px 16px;font-variant-numeric:tabular-nums;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:500;background:transparent}
tr+tr td,tr+tr th{border-top:1px solid var(--sep)}

/* agents: list + conversation */
.split{display:flex;height:100%}
.list{width:272px;flex:none;border-right:1px solid var(--sep);overflow:auto;padding:4px 8px 12px}
.list .grp{font-size:12px;font-weight:600;color:var(--muted);padding:14px 10px 4px}
.item{position:relative;padding:8px 10px;cursor:pointer;border-radius:var(--r)}
.list .item{margin:1px 0}
.item:hover{background:var(--fill-2)}
.item.sel{background:var(--sel);color:var(--selfg)}
.box>.item{border-radius:0;padding:10px 16px}
.item .l1{display:flex;align-items:center;gap:6px}.item .l1 b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .l2{font-size:12px;color:var(--muted);margin-left:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.plat{font-size:11px;color:var(--muted);background:var(--fill-2);border-radius:4px;padding:0 6px;margin-left:auto}
.thread{flex:1;min-width:0;display:flex;flex-direction:column}
.thead{padding:12px 18px;border-bottom:1px solid var(--sep);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.thead .meta{color:var(--muted);font-size:12px}.thead .acts{margin-left:auto;display:flex;gap:6px}
.status-line{padding:8px 18px;font-size:12px;border-bottom:1px solid var(--sep);white-space:pre-wrap}
.status-line.warn{color:var(--warn)}.status-line.err{color:var(--err)}
.events{flex:1;overflow:auto;padding:14px 18px}
.ev{margin:0 0 14px;max-width:88ch}.ev .who{font-size:11.5px;color:var(--muted);margin-bottom:3px}
.ev.user .body{background:var(--fill);border-radius:var(--r);padding:8px 12px}
.body p{margin:0 0 6px}.body pre{background:var(--fill);padding:10px 12px;border-radius:var(--r);overflow:auto;font-family:var(--mono);font-size:12px}
.body code{font-family:var(--mono);font-size:12px;background:var(--fill-2);padding:0 4px;border-radius:4px}
.tool{font-family:var(--mono);font-size:12px;color:var(--muted);padding:2px 0 2px 10px;border-left:2px solid var(--sep);margin:0 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool.fail{color:var(--err);border-left-color:var(--err);white-space:pre-wrap}.tool.file{color:var(--info);border-left-color:var(--info)}
.sys{font-size:12px;color:var(--muted);margin:4px 0 10px}.errrow{font-size:12px;color:var(--err);margin:4px 0 10px;white-space:pre-wrap}
.composer{border-top:1px solid var(--sep);padding:12px 18px;display:flex;gap:8px;align-items:flex-end}.composer textarea{min-height:40px;max-height:160px}
.form{max-width:660px}.form .row{display:grid;grid-template-columns:130px 1fr;gap:12px;align-items:center;margin:10px 0}
.form label{color:var(--muted);font-size:12px}

/* agent map */
.map svg{display:block}.map .node rect{fill:var(--fill);stroke:var(--sep)}.map .node:hover rect{stroke:var(--accent)}.map .node{cursor:pointer}
.map .node.master rect{stroke:var(--accent)}.map text{fill:var(--fg);font-size:12px;font-family:var(--font)}.map text.sub{fill:var(--muted);font-size:11px}
.map .edge{fill:none;stroke:var(--muted);stroke-width:1.2;opacity:.6}.map .edge.talk{stroke-dasharray:5 4;stroke:var(--info);opacity:.9}.map .elabel{fill:var(--info);font-size:10.5px;paint-order:stroke;stroke:var(--bg);stroke-width:4px;stroke-linejoin:round}
.legend{display:flex;gap:18px;font-size:12px;color:var(--muted);margin-bottom:12px;flex-wrap:wrap}.legend svg{vertical-align:middle;margin-right:4px}

/* switches (Apple style) */
.switch{position:relative;display:inline-block;width:38px;height:22px;flex:none;cursor:pointer}.switch input{opacity:0;width:0;height:0}
.switch span{position:absolute;inset:0;background:var(--fill-3);border-radius:22px;transition:background .18s}
.switch span:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .18s}
.switch input:checked+span{background:var(--ok)}.switch input:checked+span:before{transform:translateX(16px)}
.switch input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.switch input:disabled+span{opacity:.45;cursor:default}

.toast{position:fixed;right:16px;bottom:16px;background:var(--vscode-notifications-background,var(--fill-2));color:var(--fg);padding:9px 14px;border-radius:var(--r);display:none;max-width:440px;white-space:pre-wrap;font-size:12.5px;box-shadow:0 6px 20px rgba(0,0,0,.28)}
.toast.err{box-shadow:0 6px 20px rgba(0,0,0,.28),inset 3px 0 0 var(--err)}
${compact ? '.list{width:100%;border-right:none}.split.has-sel .list{display:none}.split:not(.has-sel) .thread{display:none}.chips{display:none}.pmenu{width:100%;border-right:none}.acctwrap{flex-direction:column}.stats{grid-template-columns:1fr}.stats .st+.st::before{display:none}' : ''}
</style></head><body>
<header><span class="title">Claude Agent Hub</span><nav id="tabs"></nav><div class="chips" id="chips"></div></header>
<main id="main"><div class="empty">Connecting to the Agent Hub…</div></main><div class="toast" id="toast"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const S = { tab: 'home', acctPlat: 'claude', testing: {}, refreshing: {}, refreshedAt: {}, state: null, sel: null, events: {}, newForm: false, models: {}, logs: [], modelTable: null, live: false, compact: ${compact ? 'true' : 'false'} };
const prev = vscode.getState(); if (prev?.tab) S.tab = prev.tab; if (prev?.sel) S.sel = prev.sel; if (prev?.acctPlat) S.acctPlat = prev.acctPlat; if (prev?.primingOpen) S.primingOpen = true;
const $ = (id) => document.getElementById(id);
const cap = (s) => { s = String(s ?? ''); return s.charAt(0).toUpperCase() + s.slice(1); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
function dur(ms) { if (ms == null || !isFinite(ms)) return '—'; if (ms <= 0) return 'now'; const m = Math.round(ms / 6e4), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60; return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + String(mm).padStart(2, '0') + 'm' : mm + 'm'; }
function clock(ts) { if (!ts) return '—'; const d = new Date(ts); const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + t; }
const heat = (u) => u >= 85 ? 'var(--err)' : u >= 60 ? 'var(--warn)' : 'var(--ok)';
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? 'just now' : dur(Date.now() - ts) + ' ago'; };
/** Plain-English version of common CLI errors (full text stays available on hover). */
function friendly(e) {
  const s = String(e || '');
  if (/subscription does not have access|upgrade your plan/i.test(s)) return 'This subscription doesn’t include this product (upgrade needed).';
  if (/invalid refresh token|reauthenticate|log ?in again|not logged in|unauthori[sz]ed|401|rejected the login/i.test(s)) return 'Login expired or invalid: click “Sign in again”.';
  if (/usage limit|limit reached|429|free usage limit|quota/i.test(s)) return 'Usage limit reached: it will work again after the reset.';
  if (/not installed/i.test(s)) return 'This CLI is not installed on this computer.';
  const clean = s.replace(/^(error:\\s*)?(failed to run prompt:\\s*)?([a-z_.]+error:\\s*)?([0-9]{3}\\s+)?/i, '').trim();
  return clean.length > 140 ? clean.slice(0, clean.lastIndexOf(' ', 140)) + '…' : clean || 'Unknown error';
}
const shortMail = (e) => (e ? String(e).split('@')[0] : '');
const claudeLabel = (nm) => ((S.state?.accounts?.accounts || []).find((x) => x.name === nm) || {}).email || nm || '?';
/** Strip markdown for one-line previews (no backticks here: this code lives inside a template string). */
const plain = (s) => String(s || '').replace(/\\x60{3}[\\s\\S]*?\\x60{3}/g, ' ').replace(/[|*#>_\\x60-]+/g, ' ').replace(/\\s+/g, ' ').trim();
const PLAT = { claude: ['CL', 'Claude Code'], codex: ['CX', 'Codex'], hermes: ['HE', 'Hermes Agent'], agy: ['AG', 'Antigravity CLI'], kimi: ['KI', 'Kimi Code'], opencode: ['OC', 'OpenCode'] };
const PLAT_ORDER = ['claude', 'codex', 'hermes', 'agy', 'kimi', 'opencode'];
const sClass = (s) => s === 'working' ? 's-working' : s === 'done' ? 's-done' : s === 'needs-login' ? 's-needs' : s === 'error' ? 's-error' : s === 'waiting' ? 's-waiting' : 's-idle';
const SLABEL = { working: 'Working', done: 'Done', 'needs-login': 'Needs login', error: 'Error', waiting: 'Waiting', idle: 'Idle', stopped: 'Stopped' };
const post = (m) => vscode.postMessage(m);
function save() { vscode.setState({ tab: S.tab, sel: S.sel, acctPlat: S.acctPlat, primingOpen: !!S.primingOpen }); }
function toast(text, err) { const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = 'none'), err ? 9000 : 3500); }

function md(s) {
  const parts = String(s || '').split(/\`\`\`[\\w-]*\\n?/);
  return parts.map((p, i) => i % 2 ? '<pre>' + esc(p.replace(/\\n$/, '')) + '</pre>' :
    esc(p).replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>').split(/\\n{2,}/).map((x) => '<p>' + x.replace(/\\n/g, '<br>') + '</p>').join('')).join('');
}

// ── header ──
function renderHeader() {
  const st = S.state; const agents = st?.agents || [];
  const needs = agents.filter((a) => ['needs-login', 'error'].includes(a.status)).length;
  const working = agents.filter((a) => a.status === 'working').length;
  const tabs = [['home', 'Home', ''], ['accounts', 'Accounts', ''], ['agents', 'Agents', agents.length ? (working ? working + ' working' : agents.length) : ''], ['map', 'Agent Map', ''], ['platforms', 'Platforms & Models', ''], ['logs', 'Logs', ''], ['help', 'Help', '']];
  $('tabs').innerHTML = tabs.map(([id, l, n]) => '<button data-tab="' + id + '" class="' + (S.tab === id ? 'on' : '') + '">' + l + (n ? '<span class="n">' + esc(n) + '</span>' : '') + '</button>').join('');
  const acc = st?.accounts; const act = acc?.accounts?.find((a) => a.active);
  $('chips').innerHTML =
    '<span><span class="dot ' + (S.live ? 'on' : 'off') + '"></span>' + (S.live ? 'Live' : 'Offline') + '</span>' +
    (act ? '<span title="' + esc(act.email || act.name) + '">Claude ' + esc(shortMail(act.email) || act.name) + ' · 5h ' + act.five.util + '% · wk ' + act.week.util + '%</span>' : '') +
    (needs ? '<span style="color:var(--warn)">' + needs + ' need you</span>' : '');
}

// ── home tab ──
function platAccounts(p) {
  if (p === 'claude') {
    const d = S.state?.accounts;
    return (d?.accounts || []).map((a) => ({ name: a.name, email: a.email, signedIn: a.status !== 'needs-login', live: a.active, paused: a.status === 'paused', usable: a.usable, five: a.five, week: a.week, status: a.status, statusLabel: a.statusLabel, verdict: a.verdict, claude: true }));
  }
  return S.state?.platformAccounts?.[p]?.accounts || [];
}
const lastTest = (p, n) => S.state?.tests?.[p + ':' + n] || null;
function platHealth(p) {
  const inst = (S.state?.platforms || []).find((x) => x.platform === p);
  const accts = platAccounts(p);
  const signedAccts = accts.filter((a) => a.signedIn);
  const signed = signedAccts.length;
  const warn = accts.some((a) => a.warning);
  const failed = signedAccts.filter((a) => lastTest(p, a.name)?.ok === false);
  if (inst && !inst.installed) return { level: 'idle', text: 'Not installed', signed, total: accts.length };
  if (!signed) return { level: 'warn', text: 'Not signed in', signed, total: accts.length };
  // a real failed test outranks "signed in": the login file exists but the account doesn't work
  if (failed.length === signed) return { level: 'err', text: 'Not working', signed, total: accts.length, why: friendly(lastTest(p, failed[0].name).error) };
  if (failed.length) return { level: 'warn', text: 'Needs attention', signed, total: accts.length, why: failed.length + ' account(s) failed the last test' };
  if (warn) return { level: 'warn', text: 'Needs attention', signed, total: accts.length };
  if (inst?.unsupported) return { level: 'info', text: 'Terminal only', signed, total: accts.length };
  return { level: 'ok', text: 'Ready', signed, total: accts.length };
}
function rings(five, week) {
  const ring = (r, util) => { const c = 2 * Math.PI * r; const v = Math.max(0, Math.min(100, util || 0)); return '<circle cx="50" cy="50" r="' + r + '" fill="none" style="stroke:var(--track)" stroke-width="9"/><circle cx="50" cy="50" r="' + r + '" fill="none" style="stroke:' + heat(v) + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (c * v / 100).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 50 50)"/>'; };
  return '<svg class="rings" viewBox="0 0 100 100" width="108" height="108" role="img" aria-label="Weekly limit ' + week.util + ' percent used, 5-hour session ' + five.util + ' percent used">' + ring(41, week.util) + ring(27, five.util) + '</svg>';
}
function renderHome() {
  const st = S.state; const acc = st.accounts; const agents = st.agents || [];
  const act = acc?.accounts?.find((a) => a.active);
  const working = agents.filter((a) => a.status === 'working').length;
  const needs = agents.filter((a) => ['needs-login', 'error'].includes(a.status)).length;
  const totalSigned = PLAT_ORDER.reduce((n, p) => n + platHealth(p).signed, 0);
  const now = Date.now();
  let h = '<div class="pad">';
  if (act) {
    const ln = (label, w) => '<div class="ln"><i style="background:' + heat(w.util) + '"></i>' + label + ' <b>' + w.util + '%</b><span class="muted">' + (w.resetsAt ? 'resets in ' + dur(w.resetsAt - now) : 'no window running') + '</span></div>';
    const next = acc.next ? claudeLabel(acc.next.name) : null;
    h += '<div class="hero">' + rings(act.five, act.week) +
      '<div class="who"><div class="k">' + (acc.forced === act.name ? 'Active Claude account, held until 100%' : 'Active Claude account') + '</div><div class="e" title="' + esc(act.email || act.name) + '">' + esc(act.email || act.name) + '</div>' +
      ln('Weekly limit', act.week) + ln('5-hour session', act.five) + (next ? '<div class="ln muted">When it runs out, Claude Code moves to ' + esc(next) + '</div>' : '') + '</div>' +
      '<div class="hero-acts"><button class="primary" data-act="new-from-home">Start an agent</button><button data-act="goto-plat" data-p="claude">Manage accounts</button></div></div>';
  } else {
    h += '<div class="hero"><div class="who"><div class="k">Claude account</div><div class="e">No account managed yet</div><div class="ln muted">Add your Claude accounts to see their limits here.</div></div><div class="hero-acts"><button class="primary" data-act="add-account" data-p="claude">Add a Claude account</button></div></div>';
  }
  h += '<div class="box stats">' +
    '<div class="st"><div class="v">' + (working ? working + (working === 1 ? ' agent running' : ' agents running') : 'No agents running') + '</div><div class="s">' + (needs ? '<span style="color:var(--warn)">' + needs + ' need you</span>' : agents.length + ' in total') + '</div></div>' +
    '<div class="st"><div class="v">' + totalSigned + ' accounts signed in</div><div class="s">on ' + PLAT_ORDER.length + ' platforms</div></div>' +
    '<div class="st"><div class="v" style="color:' + (S.live ? 'var(--ok)' : 'var(--err)') + '">' + (S.live ? 'Service running' : 'Service offline') + '</div><div class="s">Monitoring ' + (acc?.monitoring === false ? 'off' : 'on') + ', switching ' + (acc?.autoSwitch === false ? 'off' : 'on') + '</div></div></div>';
  h += '<div class="quick"><button data-act="add-account" data-p="' + esc(S.acctPlat) + '">Add an account</button><button data-act="open-chat">Open Claude chat</button></div>';

  const sw = (key, on, title, desc, o = {}) => '<div class="ci"><div class="grow"><div class="t">' + title + (o.disabled ? ' <span class="badge b-idle">' + (on ? 'Paused by the main switch' : 'Off') + '</span>' : '') + '</div><div class="d">' + desc + '</div></div>' +
    '<label class="switch" title="Turn ' + (on ? 'off' : 'on') + '"><input type="checkbox" data-setting="' + key + '"' + (on ? ' checked' : '') + (o.disabled ? ' disabled' : '') + '><span></span></label></div>';
  const locked = (title, why) => '<div class="ci"><div class="grow"><div class="t">' + title + ' <span class="badge b-idle">Not available</span></div><div class="d">' + why + '</div></div><label class="switch" title="Not available for this platform"><input type="checkbox" disabled><span></span></label></div>';
  const pAll = acc?.primeAll !== false;
  const codexHas5h = platAccounts('codex').some((a) => a.usage?.five);
  const summary = !pAll ? 'Off on every platform.' : 'Claude ' + (acc?.ready ? 'on' : 'off') + ', Codex ' + (acc?.primeCodex ? 'on' : 'off') + '. Antigravity, Hermes, Kimi and OpenCode can’t be primed.';
  h += '<h3>Automation</h3><div class="box checklist">' +
    sw('monitoring', acc?.monitoring !== false, 'Background monitoring', 'Keeps usage and sign-in status of every account current, every few minutes. When off, only the active Claude account is checked; use Refresh for the rest.') +
    sw('autoSwitch', acc?.autoSwitch !== false, 'Automatic account switching', 'When the active Claude account runs out, Claude Code moves to the best other account. When off, you switch by hand.') +
    '<div class="ci disclose' + (S.primingOpen ? ' open' : '') + '" data-act="toggle-priming" role="button" tabindex="0" aria-expanded="' + (S.primingOpen ? 'true' : 'false') + '"><div class="grow"><div class="t">Session priming <span class="chev" aria-hidden="true">›</span></div><div class="d">' + summary + ' ' + (S.primingOpen ? 'Click to hide the platforms.' : 'Click to show each platform.') + '</div></div>' +
    '<label class="switch" title="Main switch for every platform"><input type="checkbox" data-setting="primeAll"' + (pAll ? ' checked' : '') + '><span></span></label></div>' +
    (S.primingOpen ? '<div class="nested">' +
      sw('ready', !!acc?.ready, 'Claude', 'Starts each account’s 5-hour window as soon as the previous one ends: about 240 tokens per account every 5 hours.', { disabled: !pAll }) +
      sw('primeCodex', !!acc?.primeCodex, 'Codex', codexHas5h ? 'Starts an idle 5-hour window, at most once per window: about 19k tokens, mostly cached.' : 'Works only on plans with a 5-hour window. Your Codex account has a weekly window only, so nothing would be sent.', { disabled: !pAll }) +
      locked('Antigravity', 'Tested: a hi does not start Antigravity’s quota window, which only starts once real quota is used.') +
      locked('Hermes, Kimi and OpenCode', 'These providers don’t publish a session window, so there is nothing to start early.') +
      '</div>' : '') +
    '</div>';

  h += '<h3>Platforms</h3><div class="box checklist">';
  for (const p of PLAT_ORDER) {
    const hl = platHealth(p); const inst = (st.platforms || []).find((x) => x.platform === p);
    const detail = inst && !inst.installed ? 'Install the ' + PLAT[p][1] + ' CLI to use it here.' :
      hl.signed ? hl.signed + (hl.signed > 1 ? ' accounts' : ' account') + ' signed in' + (hl.why ? '. ' + esc(hl.why) : platAccounts(p).find((a) => a.warning) ? '. ' + esc(platAccounts(p).find((a) => a.warning).warning) : '') : 'Sign in once and it stays saved.';
    const btn = inst && !inst.installed ? '' : hl.signed ? '<button data-act="goto-plat" data-p="' + p + '">Manage</button>' : '<button class="primary" data-act="add-account" data-p="' + p + '">Sign in</button>';
    h += '<div class="ci"><div class="mono-badge" aria-hidden="true">' + PLAT[p][0] + '</div><div class="grow"><div class="t">' + PLAT[p][1] + ' <span class="badge b-' + hl.level + '">' + hl.text + '</span></div><div class="d">' + detail + '</div></div>' + btn + '</div>';
  }
  h += '</div>';
  const recent = [...agents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  if (recent.length) h += '<h3>Recent agents</h3><div class="box">' + recent.map((a) => '<div class="item ' + sClass(a.status) + '" data-sel="' + a.id + '"><div class="l1"><span class="dot ' + sClass(a.status) + '"></span><b>' + esc(a.name) + '</b><span class="plat">' + esc(a.platform) + '</span></div><div class="l2">' + esc(SLABEL[a.status] || a.status) + ', ' + clock(a.updatedAt) + (a.lastReply ? ': ' + esc(plain(a.lastReply).slice(0, 110)) : '') + '</div></div>').join('') + '</div>';
  return h + '</div>';
}

// ── accounts tab (every platform) ──
function usageBlock(label, w) {
  if (!w) return '';
  const now = Date.now();
  return '<div class="metric"><div class="row"><span class="muted">' + label + '</span><span style="color:' + heat(w.util) + ';font-weight:600">' + w.util + '%</span></div><div class="bar"><i style="width:' + Math.min(100, w.util) + '%;background:' + heat(w.util) + '"></i></div><div class="small muted" style="margin-top:3px">' + (w.resetsAt ? 'resets in ' + dur(w.resetsAt - now) + ' · ' + clock(w.resetsAt) : 'no window running') + '</div></div>';
}
function accountCard(p, a) {
  let badge;
  const lt = lastTest(p, a.name);
  if (a.pendingLogin) badge = '<span class="badge b-info"><span class="spin"></span>Signing in…</span>';
  else if (!a.signedIn) badge = '<span class="badge b-warn">Not signed in</span>';
  else if (lt && lt.ok === false) badge = '<span class="badge b-err">Not working</span>';
  else if (a.paused) badge = '<span class="badge b-idle">Paused</span>';
  else if (a.claude && a.status !== 'ok') badge = '<span class="badge b-err">' + esc(cap(a.statusLabel)) + '</span>';
  else if (a.limitedUntil || a.usage?.limited) badge = '<span class="badge b-err">Limited</span>';
  else if (a.warning) badge = '<span class="badge b-warn">Attention</span>';
  else badge = '<span class="badge b-ok">Signed in</span>';
  const live = a.claude ? a.live : p === 'agy' ? a.active : a.preferred;
  const held = a.claude && a.live && S.state?.accounts?.forced === a.name;
  const liveLabel = a.claude ? (held ? 'Active · held' : 'Active') : p === 'agy' ? 'Active' : 'Used for new agents';
  const ident = a.email ? (a.plan || '') : (a.plan || (a.isDefaultHome ? 'your normal ' + PLAT[p][1] + ' login' : ''));
  let h = '<div class="acard' + (live ? ' live' : '') + '"><div class="h"><b title="' + esc(a.email || a.name) + '">' + esc(a.email || a.name) + '</b>' + (a.email ? '<span class="small muted" title="Saved as">' + esc(a.name) + '</span>' : '') + (live ? '<span class="badge b-info">' + liveLabel + '</span>' : '') + '<span style="margin-left:auto">' + badge + '</span></div>';
  if (ident) h += '<div class="id" title="' + esc(ident) + '">' + esc(ident) + '' + '</div>';
  if (a.claude) h += usageBlock('5-hour session', a.five) + usageBlock('Weekly limit', a.week) + (a.verdict ? '<div class="small muted">Plan: ' + esc(a.verdict.text) + '</div>' : '');
  else if (a.usage && !a.usage.error) {
    h += usageBlock('5-hour window', a.usage.five) + usageBlock('Weekly limit', a.usage.week);
    if (a.usage.groups) h += a.usage.groups.slice(0, 4).map((g) => usageBlock(g.label + ' quota', { util: g.util, resetsAt: g.resetsAt })).join('');
    if (a.usage.stale) h += '<div class="small muted">usage: last known (refreshes when the account is active)</div>';
  }
  // last test result / test in progress
  const tkey = p + ':' + a.name; const test = S.state?.tests?.[tkey];
  if (S.testing[tkey]) h += '<div class="small"><span class="spin"></span>Testing: sending a one-word "hi"…</div>';
  else if (test) {
    const tk = test.tokens ? (test.tokens.input || 0) + (test.tokens.output || 0) : null;
    h += test.ok
      ? '<div class="small" style="color:var(--ok)">✓ Works · ' + (test.ms / 1000).toFixed(1) + 's' + (tk != null ? ' · ' + (tk ? k(tk) + ' tokens' : 'no tokens used') + (test.tokens.cached ? ' (+' + k(test.tokens.cached) + ' cached)' : '') : '') + ' · ' + ago(test.at) + '</div>'
      : '<div class="small" style="color:var(--err)" title="' + esc(test.error || '') + '">✕ Not working (tested ' + ago(test.at) + '): ' + esc(friendly(test.error)) + '</div>';
  }
  if (a.warning) h += '<div class="warnline">⚠ ' + esc(a.warning) + '</div>';
  if (held) h += '<div class="small" style="color:var(--info)">You force-switched here: it stays active until it reaches 100%, then automatic switching moves on.</div>';
  if (a.limitedUntil) h += '<div class="warnline">Limited until ' + clock(a.limitedUntil) + '; agents use another account meanwhile</div>';
  const acts = [];
  if (!a.signedIn) acts.push('<button class="primary" data-act="relogin" data-p="' + p + '" data-n="' + esc(a.name) + '">Sign in</button>');
  else {
    acts.push('<button data-act="acct-test" data-p="' + p + '" data-n="' + esc(a.name) + '" title="Sends the cheapest possible one-word message to check this account works"' + (S.testing[p + ':' + a.name] ? ' disabled' : '') + '>Test</button>');
    acts.push('<button data-act="relogin" data-p="' + p + '" data-n="' + esc(a.name) + '">Sign in again</button>');
  }
  if (a.signedIn && !live && !a.paused) {
    if (a.claude) acts.push(a.usable
      ? '<button data-act="acct-activate" data-p="claude" data-n="' + esc(a.name) + '">Switch to</button>'
      : '<button data-act="acct-force" data-p="claude" data-n="' + esc(a.name) + '" title="Use this account anyway: it is kept until it reaches 100%, then automatic switching moves on">Force switch</button>');
    else if (p === 'agy') acts.push('<button data-act="acct-activate" data-p="agy" data-n="' + esc(a.name) + '">Make active</button>');
    else acts.push('<button data-act="acct-preferred" data-p="' + p + '" data-n="' + esc(a.name) + '">Use for new agents</button>');
  }
  if (held) acts.push('<button data-act="acct-release" title="Let automatic switching decide again now">Release hold</button>');
  acts.push('<button class="ghost" data-act="acct-pause" data-p="' + p + '" data-n="' + esc(a.name) + '" data-paused="' + (!a.paused) + '">' + (a.paused ? 'Resume' : 'Pause') + '</button>');
  if (!a.isDefaultHome) acts.push('<button class="ghost" data-act="acct-remove" data-p="' + p + '" data-n="' + esc(a.name) + '">Remove</button>');
  return h + '<div class="acts">' + acts.join('') + '</div></div>';
}
function renderAccounts() {
  const p = S.acctPlat;
  let menu = '';
  for (const q of PLAT_ORDER) { const hl = platHealth(q); menu += '<div class="pitem' + (q === p ? ' sel' : '') + '" data-act="goto-plat" data-p="' + q + '"><div class="mono-badge">' + PLAT[q][0] + '</div><div><div>' + PLAT[q][1] + '</div><div class="small" style="opacity:.8"><span class="dot s-' + (hl.level === 'ok' ? 'working' : hl.level === 'warn' ? 'needs' : hl.level === 'err' ? 'error' : 'idle') + '"></span>' + hl.text + '</div></div><span class="cnt">' + hl.signed + '</span></div>'; }
  const info = S.state?.platformAccounts?.[p];
  const inst = (S.state?.platforms || []).find((x) => x.platform === p);
  const accts = platAccounts(p);
  let body = '<div class="pad"><div style="display:flex;align-items:center;gap:10px"><div class="mono-badge">' + PLAT[p][0] + '</div><div><div style="font-size:15px;font-weight:600">' + PLAT[p][1] + '</div><div class="small muted">' + (inst ? (inst.installed ? 'Installed · ' + esc(inst.version) : 'Not installed') : '') + '</div></div><div style="margin-left:auto;display:flex;align-items:center;gap:8px">' +
    (S.refreshedAt[p] && !S.refreshing[p] ? '<span class="small muted">Updated ' + ago(S.refreshedAt[p]) + '</span>' : '') +
    '<button data-act="acct-refresh" data-p="' + p + '" title="Fetch live usage and sign-in status for ' + PLAT[p][1] + ' now"' + (S.refreshing[p] ? ' disabled' : '') + '>' + (S.refreshing[p] ? '<span class="spin"></span>Refreshing…' : '↻ Refresh') + '</button>' +
    '<button class="primary" data-act="add-account" data-p="' + p + '">Add an account</button></div></div>';
  const how = {
    claude: 'Each account is signed in once and saved. The active one is used by Claude Code; it switches automatically when limits run out.',
    codex: 'Each account is a separate Codex login. Agents use the one marked "Used for new agents", and move to the next one automatically when a limit is hit.',
    hermes: 'Each account is a separate Hermes home with its own providers. Pick providers during sign-in.',
    agy: 'agy keeps one login at a time, so the extension saves each account and makes the chosen one active.',
    kimi: 'Each account is a separate Kimi home. After signing in, run kimi once and choose a model (/model).',
    opencode: 'Each account is a separate OpenCode data folder with its own provider logins.',
  }[p];
  body += '<div class="howto">' + how + (info?.login ? ' Sign-in command: <span class="mono">' + esc(info.login) + '</span>' : p === 'claude' ? ' Sign-in command: <span class="mono">claude auth login</span>' : '') + '</div>';
  body += accts.length ? '<div class="acards">' + accts.map((a) => accountCard(p, a)).join('') + '</div>' : '<div class="box" style="padding:24px;text-align:center"><div style="margin-bottom:10px">No ' + PLAT[p][1] + ' accounts yet.</div><button class="primary" data-act="add-account" data-p="' + p + '">Sign in to your first account</button></div>';
  if (p === 'claude' && S.state?.accounts?.accounts?.length) {
    const d = S.state.accounts; const now = Date.now();
    body += '<h3>Weekly plan · goal: use 100% before each reset</h3><div class="box"><table><tr><th>Account</th><th>Used</th><th>Left</th><th>Resets</th><th>Needs</th><th>Verdict</th></tr>';
    for (const a of [...d.accounts].sort((x, y) => (x.week.resetsAt || 9e15) - (y.week.resetsAt || 9e15)))
      body += '<tr><td><b title="Saved as ' + esc(a.name) + '">' + esc(a.email || a.name) + '</b></td><td style="width:150px"><div class="bar"><i style="width:' + a.week.util + '%;background:' + heat(a.week.util) + '"></i></div></td><td>' + a.remaining + '%</td><td>' + (a.week.resetsAt ? clock(a.week.resetsAt) + ' <span class="muted">(' + dur(a.week.resetsAt - now) + ')</span>' : '—') + '</td><td>' + (a.remaining <= 2 ? '—' : '~' + a.need + (a.need === 1 ? ' session' : ' sessions')) + '</td><td><span class="badge b-' + ({ good: 'ok', bad: 'err', warn: 'warn', muted: 'idle' }[a.verdict.level] || 'idle') + '">' + esc(a.verdict.text) + '</span></td></tr>';
    body += '</table></div><div class="small muted" style="margin-top:10px">24/7 priming: ' + (d.ready ? 'on' : 'off') + ' · <a href="#" data-act="ready" data-on="' + (!d.ready) + '">turn ' + (d.ready ? 'off' : 'on') + '</a>' + (d.lastSwitch ? ' · last switch ' + esc(claudeLabel(d.lastSwitch.from)) + ' → ' + esc(claudeLabel(d.lastSwitch.to)) + ' at ' + clock(d.lastSwitch.at) : '') + '</div>';
  }
  body += '</div>';
  return '<div class="acctwrap"><div class="pmenu">' + menu + '</div><div style="flex:1;min-width:0;overflow:auto">' + body + '</div></div>';
}

// ── agents tab ──
function agentItem(a) {
  return '<div class="item ' + sClass(a.status) + (S.sel === a.id ? ' sel' : '') + '" data-sel="' + a.id + '"><div class="l1"><span class="dot ' + sClass(a.status) + '"></span><b>' + esc(a.name) + '</b><span class="plat">' + esc(a.platform) + '</span></div><div class="l2">' + esc(SLABEL[a.status] || a.status) + (a.model ? ' · ' + esc(a.model) : '') + ' · ' + k((a.tokens?.input || 0) + (a.tokens?.output || 0)) + ' tok</div></div>';
}
function renderAgents() {
  const agents = S.state?.agents || [];
  const groups = [['Needs you', (a) => ['needs-login', 'error'].includes(a.status)], ['Working', (a) => a.status === 'working'], ['Waiting', (a) => a.status === 'waiting'], ['Done', (a) => a.status === 'done'], ['Idle', (a) => !['needs-login', 'error', 'working', 'waiting', 'done'].includes(a.status)]];
  let list = '<div style="padding:10px 12px"><button class="primary" data-act="new" style="width:100%">Start an agent</button></div>';
  for (const [g, f] of groups) { const xs = agents.filter(f); if (xs.length) list += '<div class="grp">' + g + ' · ' + xs.length + '</div>' + xs.map(agentItem).join(''); }
  const chats = S.state?.claudeChats || [];
  if (chats.length) list += '<div class="grp">Claude chats (extension)</div>' + chats.slice(0, 8).map((c) => '<div class="item" data-chat="' + esc(c.sessionId) + '"><div class="l1"><span class="dot"></span><b>' + esc(c.title) + '</b></div><div class="l2">' + clock(c.updatedAt) + ' · ' + c.helpers.length + (c.helpers.length === 1 ? ' helper' : ' helpers') + ' · ' + c.sizeKb + ' KB</div></div>').join('');
  if (!agents.length && !S.newForm) list += '<div class="small muted" style="padding:10px 12px">No agents yet. Start one here, or ask Claude: "start a Codex critic to review src/…".</div>';
  const a = agents.find((x) => x.id === S.sel);
  let right;
  if (S.newForm) right = renderNewForm();
  else if (!a) right = '<div class="empty">Select an agent to see its conversation, commands and file changes.</div>';
  else right = renderThread(a);
  return '<div class="split' + (a || S.newForm ? ' has-sel' : '') + '"><div class="list">' + list + '</div><div class="thread">' + right + '</div></div>';
}
function renderThread(a) {
  const ev = S.events[a.id] || [];
  const t = a.tokens || {};
  let h = '<div class="thead">' + (S.compact ? '<button class="ghost" data-act="back">‹</button>' : '') + '<span class="dot ' + sClass(a.status) + '"></span><b>' + esc(a.name) + '</b><span class="meta">' + esc(a.platform) + (a.model ? ' · ' + esc(a.model) : '') + ' · ' + esc(a.permission) + (a.account ? ' · acct ' + esc(a.account) : '') + ' · ' + (t.turns || 0) + ' turns · in ' + k(t.input) + ' / out ' + k(t.output) + (t.cached ? ' / cached ' + k(t.cached) : '') + '</span>' +
    '<div class="acts">' + (a.status === 'working' ? '<button data-act="stop">Stop</button>' : '') + (['error', 'needs-login', 'waiting', 'stopped'].includes(a.status) ? '<button data-act="retry">Retry</button>' : '') + '<button data-act="model">Model…</button><button class="ghost" data-act="remove" title="Remove agent">Remove</button></div></div>';
  if (a.role || a.cwd) h += '<div class="status-line muted">' + (a.role ? esc(a.role) + ' · ' : '') + '<span class="mono">' + esc(a.cwd) + '</span></div>';
  if (['error', 'needs-login', 'waiting'].includes(a.status) && a.statusDetail) h += '<div class="status-line ' + (a.status === 'error' ? 'err' : 'warn') + '">' + esc(a.statusDetail) + '</div>';
  if (S.modelTable?.agent === a.id) h += '<div class="status-line">' + S.modelTable.html + '</div>';
  h += '<div class="events" id="events">' + (ev.length ? ev.map(renderEvent).join('') : '<div class="empty">No messages yet.</div>') + (a.status === 'working' ? '<div class="sys">working…</div>' : '') + '</div>';
  h += '<div class="composer"><textarea id="msg" rows="2" placeholder="Message ' + esc(a.name) + '…  (Ctrl+Enter to send)"></textarea><button class="primary" data-act="send">Send</button></div>';
  return h;
}
function renderEvent(e) {
  switch (e.kind) {
    case 'user': return '<div class="ev user"><div class="who">' + esc(e.from === 'user' ? 'You' : e.from || 'You') + ' · ' + clock(e.t) + '</div><div class="body">' + md(e.text) + '</div></div>';
    case 'assistant': return '<div class="ev assistant"><div class="who">Agent · ' + clock(e.t) + '</div><div class="body">' + md(e.text) + '</div></div>';
    case 'tool': return '<div class="tool' + (e.ok === false ? ' fail' : '') + '" title="' + esc(e.text) + '">▸ ' + esc(e.name) + '  ' + esc(e.text) + (e.ok === false ? '  ✕' + (e.exit != null ? ' exit ' + e.exit : '') + (e.detail ? '\\n' + esc(e.detail) : '') : '') + '</div>';
    case 'tool_result': return e.ok === false ? '<div class="tool fail">✕ ' + esc(e.text) + '</div>' : '';
    case 'file': return '<div class="tool file">✎ ' + esc(e.name || 'edit') + '  ' + esc(e.text) + '</div>';
    case 'error': return '<div class="errrow">✕ ' + esc(e.text) + (e.class ? ' [' + esc(e.class) + ']' : '') + '</div>';
    case 'usage': return '<div class="sys">tokens +' + k(e.input) + ' in / ' + k(e.output) + ' out' + (e.cached ? ' / ' + k(e.cached) + ' cached' : '') + '</div>';
    case 'status': return e.status === 'working' ? '' : '<div class="sys">' + esc(e.text) + '</div>';
    default: return '<div class="sys">' + esc(e.text) + '</div>';
  }
}
function renderNewForm() {
  const plats = (S.state?.platforms || []).filter((p) => p.installed);
  const pf = S.formPlatform || 'codex';
  const models = S.models[pf] || [];
  const opt = (v, l, sel) => '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(l) + '</option>';
  return '<div class="pad form"><h3 style="margin-top:0">New agent</h3>' +
    '<div class="row"><label>Name</label><input id="f-name" placeholder="e.g. critic"></div>' +
    '<div class="row"><label>Platform</label><select id="f-platform">' + plats.map((p) => opt(p.platform, p.label + (p.unsupported ? ' (terminal only)' : ''), p.platform === pf)).join('') + '</select></div>' +
    '<div class="row"><label>Model</label><div><input id="f-model" list="f-models" placeholder="' + esc((plats.find((p) => p.platform === pf) || {}).defaultModel || 'platform default') + '"><datalist id="f-models">' + models.map((m) => opt(m.id, m.name || m.id)).join('') + '</datalist>' +
      (S.models[pf] === undefined ? '<div class="loading" style="padding:4px 0 0"><span class="spin"></span>Loading models…</div>' : models.length ? '<div class="small muted" style="margin-top:3px">' + models.length + ' models available · type to filter</div>' : '<div class="small muted" style="margin-top:3px">This platform has no model list; leave empty for its default.</div>') + '</div></div>' +
    '<div class="row"><label>Account</label><select id="f-acct">' + (pf === 'claude' ? opt('', 'Active Claude account (switches automatically)', true) : opt('', 'Automatic (preferred account, fails over on limits)', true) + platAccounts(pf).filter((x) => x.signedIn && !x.paused).map((x) => opt(x.name, x.name + (x.email ? ' · ' + x.email : ''))).join('')) + '</select></div>' +
    '<div class="row"><label>Permission</label><select id="f-perm">' + opt('read', 'Read only (review, debate)', true) + opt('edit', 'Edit + run inside the project') + opt('full', 'Full access (no sandbox)') + '</select></div>' +
    '<div class="row"><label>Project folder</label><input id="f-cwd" value="' + esc(S.workspace || '') + '"></div>' +
    '<div class="row"><label>Role</label><input id="f-role" placeholder="e.g. skeptical reviewer"></div>' +
    '<div class="row" style="align-items:start"><label>First task</label><textarea id="f-task" rows="5" placeholder="What should it do? Include your rules."></textarea></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end"><button data-act="cancel-new">Cancel</button><button class="primary" data-act="create">Start agent</button></div></div>';
}

// ── map tab ──
function renderMap() {
  const st = S.state || {}; const agents = st.agents || []; const links = st.links || [];
  const byName = Object.fromEntries(agents.map((a) => [a.name.toLowerCase(), a]));
  const nodes = []; const edges = []; const W = 230, H = 52, GX = 90, GY = 18;
  const talk = {};
  for (const l of links) { const to = agents.find((a) => a.id === l.to); if (!to) continue; const from = (l.from || 'user').toLowerCase(); const key = from + '→' + to.id; talk[key] = (talk[key] || 0) + 1; }
  const usesMaster = agents.some((a) => a.createdBy === 'master') || Object.keys(talk).some((k2) => k2.startsWith('master→'));
  const depth = {}; const dfs = (a, seen = new Set()) => { if (depth[a.id] != null) return depth[a.id]; if (seen.has(a.id)) return 1; seen.add(a.id); const p = agents.find((x) => x.id === a.parentId); depth[a.id] = p ? dfs(p, seen) + 1 : (a.createdBy === 'master' ? 1 : (usesMaster && talk['master→' + a.id] ? 1 : 0)); return depth[a.id]; };
  agents.forEach((a) => dfs(a));
  const connected = new Set(); for (const a of agents) if (a.parentId) { connected.add(a.id); connected.add(a.parentId); }
  for (const key of Object.keys(talk)) { const [f, to] = key.split('→'); connected.add(to); if (byName[f]) connected.add(byName[f].id); }
  const team = agents.filter((a) => connected.has(a.id) || a.createdBy === 'master');
  const indep = agents.filter((a) => !team.includes(a));
  const cols = {}; const place = (id, label, sub, d, kind, status, ref) => { cols[d] = (cols[d] || 0) + 1; nodes.push({ id, label, sub, x: 20 + d * (W + GX), y: 30 + (cols[d] - 1) * (H + GY), kind, status, ref }); };
  if (usesMaster) place('master', 'Master (your Claude chat)', 'orchestrates · ' + (st.accounts?.active ? 'acct ' + claudeLabel(st.accounts.active) : ''), 0, 'master', 'idle');
  for (const a of team.sort((x, y) => depth[x.id] - depth[y.id])) place(a.id, a.name, a.platform + (a.model ? ' · ' + a.model : '') + ' · ' + k((a.tokens?.input || 0) + (a.tokens?.output || 0)) + ' tok', depth[a.id], 'agent', a.status, a.id);
  const teamBottom = Math.max(0, ...nodes.map((n) => n.y + H));
  for (const a of agents) { if (a.parentId && team.includes(a)) edges.push({ from: a.parentId, to: a.id, kind: 'spawn' }); else if (a.createdBy === 'master' && usesMaster) edges.push({ from: 'master', to: a.id, kind: 'spawn' }); }
  for (const [key, n] of Object.entries(talk)) { const [f, to] = key.split('→'); const fromId = f === 'master' ? 'master' : byName[f]?.id; if (fromId && fromId !== to) edges.push({ from: fromId, to, kind: 'talk', n }); }
  // independent agents
  let y = teamBottom + 60; const indepLabelY = y - 16;
  indep.forEach((a, i) => nodes.push({ id: a.id, label: a.name, sub: a.platform + (a.model ? ' · ' + a.model : '') + ' · ' + k((a.tokens?.input || 0) + (a.tokens?.output || 0)) + ' tok', x: 20 + (i % 3) * (W + 30), y: y + Math.floor(i / 3) * (H + GY), kind: 'agent', status: a.status, ref: a.id }));
  if (indep.length) y += Math.ceil(indep.length / 3) * (H + GY) + 40;
  // Claude chats (extension) and their helper agents
  const chats = (st.claudeChats || []).filter((c) => c.helpers.length).slice(0, 4); const chatLabelY = y - 16;
  for (const c of chats) { nodes.push({ id: 'c_' + c.sessionId, label: c.title.slice(0, 30), sub: 'Claude chat · ' + c.helpers.length + (c.helpers.length === 1 ? ' helper' : ' helpers'), x: 20, y, kind: 'chat', status: 'idle', chat: c.sessionId }); c.helpers.slice(0, 8).forEach((hp, i) => { const id = 'h_' + hp.id; nodes.push({ id, label: hp.description.slice(0, 30), sub: (hp.model || hp.type || '') + (hp.finished ? ' · finished' : ' · running'), x: 20 + W + GX, y: y + i * (H + GY), kind: 'helper', status: hp.finished ? 'done' : 'working' }); edges.push({ from: 'c_' + c.sessionId, to: id, kind: 'spawn' }); }); y += Math.max(1, Math.min(8, c.helpers.length)) * (H + GY) + 30; }
  if (!nodes.length) return '<div class="empty">No agents yet. The map shows who started whom (solid) and who talks to whom (dashed, with message counts).</div>';
  const pos = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const width = Math.max(...nodes.map((n) => n.x + W)) + 40; const height = Math.max(...nodes.map((n) => n.y + H)) + 30;
  let svg = '<svg width="' + width + '" height="' + height + '">';
  if (indep.length) svg += '<text class="sub" x="20" y="' + indepLabelY + '">INDEPENDENT AGENTS</text>';
  if (chats.length) svg += '<text class="sub" x="20" y="' + chatLabelY + '">Claude chats in the extension</text>';
  for (const e of edges) { const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue; const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2 + (e.kind === 'talk' ? 8 : 0); const sameCol = x2 <= x1; const p = sameCol ? 'M' + (a.x + W / 2) + ' ' + (a.y + H) + ' C ' + (a.x + W / 2) + ' ' + (a.y + H + 30) + ', ' + (b.x + W / 2) + ' ' + (b.y - 30) + ', ' + (b.x + W / 2) + ' ' + b.y : 'M' + x1 + ' ' + y1 + ' C ' + (x1 + 45) + ' ' + y1 + ', ' + (x2 - 45) + ' ' + y2 + ', ' + x2 + ' ' + y2; svg += '<path class="edge' + (e.kind === 'talk' ? ' talk' : '') + '" d="' + p + '"/>'; if (e.kind === 'talk') svg += '<text class="elabel" x="' + ((x1 + x2) / 2 - 10) + '" y="' + ((y1 + y2) / 2 - 4) + '">' + e.n + ' msg</text>'; }
  for (const n of nodes) { // green only while running; finished / idle = gray
    const col = { working: 'var(--ok)', 'needs-login': 'var(--warn)', error: 'var(--err)', waiting: 'var(--warn)' }[n.status] || 'var(--idle)'; svg += '<g class="node ' + n.kind + '"' + (n.ref ? ' data-sel="' + n.ref + '"' : '') + '><rect x="' + n.x + '" y="' + n.y + '" width="' + W + '" height="' + H + '" rx="5"/><circle cx="' + (n.x + 14) + '" cy="' + (n.y + 18) + '" r="4" fill="' + col + '"/><text x="' + (n.x + 26) + '" y="' + (n.y + 22) + '">' + esc(n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label) + '</text><text class="sub" x="' + (n.x + 14) + '" y="' + (n.y + 40) + '">' + esc(n.sub.length > 36 ? n.sub.slice(0, 35) + '…' : n.sub) + '</text></g>'; }
  svg += '</svg>';
  const legend = '<div class="legend"><span><svg width="34" height="8"><path class="edge" d="M0 4 L34 4"/></svg>started by</span><span><svg width="34" height="8"><path class="edge talk" d="M0 4 L34 4"/></svg>messages (count)</span><span><span class="dot s-working"></span>running</span><span><span class="dot"></span>finished / idle</span><span><span class="dot s-needs"></span>needs you / waiting</span><span><span class="dot s-error"></span>error</span></div>';
  return '<div class="pad map">' + legend + '<div style="overflow:auto">' + svg + '</div></div>';
}

// ── platforms tab ──
function renderPlatforms() {
  const ps = S.state?.platforms || []; const agents = S.state?.agents || [];
  let h = '<div class="pad"><div style="display:flex;align-items:center;gap:10px"><h3 style="margin:0">Agent platforms on this machine</h3><button style="margin-left:auto" data-act="refresh-platforms">Re-check</button></div><table style="margin-top:8px"><tr><th>Platform</th><th>Version</th><th>Status</th><th>Default model</th><th>Agents</th><th></th></tr>';
  for (const p of ps) h += '<tr><td><b>' + esc(p.label || p.platform) + '</b> <span class="mono muted">' + esc(p.platform) + '</span></td><td class="mono small">' + esc(p.installed ? p.version : '—') + '</td><td>' + (!p.installed ? '<span class="pill err">not installed</span>' : p.unsupported ? '<span class="pill warn" title="' + esc(p.unsupported) + '">terminal only</span>' : '<span class="pill ok">installed</span>') + '</td><td class="mono small">' + esc(p.defaultModel || 'its own default') + '</td><td>' + agents.filter((a) => a.platform === p.platform).length + '</td><td class="right">' + (p.installed ? '<button data-act="models" data-p="' + p.platform + '">Models</button>' : '') + '</td></tr>';
  h += '</table>';
  if (S.modelTable && !S.modelTable.agent) {
    const mt = S.modelTable; const label = (PLAT[mt.platform] || [, mt.platform])[1];
    h += '<div style="display:flex;align-items:center;gap:10px;margin-top:18px"><h3 style="margin:0">' + esc(label) + ' models</h3>' +
      (mt.loading ? '<span class="loading" style="padding:0"><span class="spin"></span>Loading… the first load can take up to a minute; after that it is instant.</span>' : '<span class="small muted">' + (mt.cachedAt ? 'cached ' + dur(Date.now() - mt.cachedAt) + ' ago' : '') + '</span><button style="margin-left:auto" data-act="models-refresh" data-p="' + esc(mt.platform) + '">Refresh list</button>') + '</div>';
    if (!mt.loading) h += '<div style="margin-top:8px">' + mt.html + '</div>';
  }
  h += '<div class="small muted" style="margin-top:14px">Logins are managed by each CLI: <span class="mono">codex login</span>, <span class="mono">hermes auth</span>, <span class="mono">kimi</span> then /login, <span class="mono">opencode auth login</span>. Claude accounts are on the Accounts tab.</div></div>';
  return h;
}
function modelsHtml(list) {
  if (!list.length) return '<div class="small muted">This platform does not publish a model list; any model name it accepts works.</div>';
  return '<table><tr><th>Model</th><th>Name</th><th>Notes</th></tr>' + list.slice(0, 80).map((m) => '<tr><td class="mono">' + esc(m.id) + '</td><td>' + esc(m.name && m.name !== m.id ? m.name : '') + '</td><td class="small muted">' + esc(m.note || (m.efforts?.length ? 'effort: ' + m.efforts.join(', ') : '')) + '</td></tr>').join('') + '</table>';
}

// ── help tab ──
function renderHelp() {
  const sec = (title, body) => '<h3>' + title + '</h3><div class="box" style="padding:12px 16px">' + body + '</div>';
  const li = (xs) => '<ul style="margin:4px 0 0;padding-left:18px">' + xs.map((x) => '<li style="margin:4px 0">' + x + '</li>').join('') + '</ul>';
  const go = (tab, label) => '<a href="#" data-act="help-goto" data-tab2="' + tab + '">' + label + '</a>';
  const dot = (cls, t) => '<span><span class="dot ' + cls + '"></span>' + t + '</span>';
  return '<div class="pad" style="max-width:900px">' +
    '<div style="font-size:15px;font-weight:600">How to use the Agent Hub</div><div class="small muted" style="margin-top:2px">One place to manage your AI accounts and run several agents. Everything runs on this computer.</div>' +
    sec('1 · Get started (5 minutes, once)', li([
      'Open ' + go('home', 'Home') + ' → <b>Setup checklist</b>. Each platform shows whether it is installed and signed in.',
      'Click <b>Sign in</b> next to a platform (or ' + go('accounts', 'Accounts') + ' → <b>+ Add account</b>). Give the account a short name, then finish the sign-in in the terminal that opens. The card turns green by itself.',
      'Click <b>Test</b> on a card to check the account really works. It sends the cheapest possible one-word "hi" and shows the time and tokens used.',
      'Add more accounts of the same platform the same way: they are kept separate and never overwrite each other.',
    ])) +
    sec('2 · Accounts', li([
      '<b>Claude</b>: the <b>Active</b> account is what Claude Code uses. When it runs low, the hub switches to the best other account automatically (soonest-expiring weekly quota first). <b>Switch to</b> does it by hand. New chats use the new account.',
      '<b>Codex, Hermes, Kimi, OpenCode</b>: each account is its own login. <b>Use for new agents</b> picks the default; when an agent hits a limit it moves to your next signed-in account automatically.',
      '<b>Antigravity (agy)</b>: agy holds one login at a time. <b>Make active</b> chooses which one. Adding an account saves your current login first; if you close the sign-in without finishing, your previous login is restored.',
      '<b>Pause</b> takes an account out of rotation without deleting it. <b>Remove</b> deletes its saved login from this computer.',
      '<b>Force switch</b> appears on a Claude account that is past the automatic limits (5-hour ≥ 95% or weekly ≥ 98%). Use it to spend the last few percent: Claude Code stays on that account until it reaches 100%, then switches automatically. <b>Release hold</b> hands control back to automatic switching earlier. In a terminal: <span class="mono">cam switch &lt;name&gt; --force</span>.',
      '<b>↻ Refresh</b> (top-right of each platform) fetches live usage and sign-in status right now. Without it, everything updates by itself every few minutes.',
      '<b>Home → Automation</b>: turn <b>Background monitoring</b>, <b>Automatic account switching</b> and <b>Session priming</b> on or off, the main priming switch and one per platform (Claude, Codex). Antigravity, Hermes, Kimi and OpenCode can’t be primed: their limits don’t start from a “hi”.',
      'Usage bars: Claude (5-hour + weekly), Codex (weekly), Antigravity (quota per model family). Green &lt; 60 %, amber 60-85 %, red ≥ 85 %. Other platforms don’t publish limits.',
    ])) +
    sec('3 · Agents', li([
      '<b>From your Claude chat</b> (easiest): describe what you want, e.g. <span class="mono">"Start a Codex critic to find loopholes in src/auth, Claude defends, you decide"</span> or <span class="mono">/claude-agent-hub:duo …</span>. Claude starts the agents, relays their messages and gives a verdict. This tab opens by itself.',
      '<b>From here</b>: ' + go('agents', 'Agents') + ' → <b>+ New agent</b> → choose platform, account, model, permission, project folder and the first task.',
      'Click an agent to see its conversation, every command it ran (failed ones in red) and every file it changed. Type in the box to send it another message: it remembers the whole conversation.',
      'Permissions: <b>Read only</b> for reviews and debates · <b>Edit</b> to change files and run commands in the project · <b>Full access</b> only when you trust the task.',
      'Status: ' + dot('s-working', 'running') + ' · ' + dot('', 'finished / idle') + ' · ' + dot('s-needs', 'needs you (login) / waiting for a limit') + ' · ' + dot('s-error', 'error'),
      '<b>Stop</b> ends the current turn. <b>Retry</b> re-sends the last message after you fix a login or model. <b>Model…</b> changes the model (unknown names show you the list).',
    ])) +
    sec('4 · Agent Map', li([
      'Solid line = who started whom. Dashed line = who messaged whom, with the number of messages.',
      'Independent agents are listed separately. Your Claude chats and their helper agents appear at the bottom. Click any box to open that agent.',
    ])) +
    sec('5 · Limits, waiting and nothing lost', li([
      'A Claude helper that hits a limit switches account and continues the <b>same</b> conversation.',
      'Other platforms wait and retry automatically (15 min, then 30, then 60) or move to your next account with a short recap of the work so far.',
      'If the computer restarts, interrupted work continues by itself. Every conversation is kept on disk.',
      '24/7 priming (Accounts → Claude): sends a tiny "hi" when a Claude 5-hour window ends, so a fresh session is always close. It costs about 240 tokens per account per 5 hours. Turn it off any time.',
    ])) +
    sec('6 · Tokens and cost', li([
      'Monitoring, the status bar, this dashboard and the map use <b>no</b> tokens.',
      'Tests and priming use the cheapest check possible: Claude ≈ 210 tokens · Hermes ≈ 1.2k (no tools) · Codex and Antigravity 0 (login + quota checked without sending a message).',
      'Agents report their tokens per turn (in / out / cached), shown on each agent and in the map. Your Claude chat receives short summaries, never whole transcripts.',
      'Tip: ask agents to write long results to a file and reply with the path. It saves context and tokens.',
    ])) +
    sec('7 · Where to look when something is wrong', li([
      '<b>Attention / Needs you</b> on a card or agent: the message says exactly what to do (usually <b>Sign in again</b>).',
      '<b>Offline</b> in the header: the background service is restarting; it comes back within 5 minutes by itself. In a terminal, <span class="mono">cam doctor</span> checks everything.',
      'Models list slow the first time: it loads once (spinner), then it is cached for 24 h. <b>Refresh list</b> forces a new copy.',
      go('logs', 'Logs') + ' shows every switch, sign-in, test, limit and error with the time.',
      'Hover the <b>Agent Hub</b> item in the status bar for a quick overview without opening anything.',
    ])) +
    sec('8 · Ready-made instructions (copy → paste into your Claude chat)', '<div class="small muted" style="margin-bottom:8px">Change the parts in &lt;angle brackets&gt;. Claude becomes the "master": it starts the agents, you watch them here, and it ends with a verdict.</div>' + EXAMPLES.map(([title, text]) =>
      '<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)"><div style="flex:1;min-width:0"><div style="font-weight:600;margin-bottom:2px">' + esc(title) + '</div><div class="mono small muted" style="white-space:pre-wrap">' + esc(text) + '</div></div><button data-act="copy" data-text="' + esc(text) + '">Copy</button></div>').join('')) +
    sec('9 · Commands in the Claude chat', cmdTable([
      ['/claude-agent-hub:accounts', 'Table of all Claude accounts: 5-hour %, weekly %, resets, which is next'],
      ['/claude-agent-hub:accounts add &lt;name&gt;', 'Add a Claude account (opens a sign-in window)'],
      ['/claude-agent-hub:accounts relogin | pause | resume | remove &lt;name&gt;', 'Manage one Claude account'],
      ['/claude-agent-hub:switch-account [name]', 'Switch Claude Code to that account now (no name = the best one)'],
      ['/claude-agent-hub:week', 'Weekly plan: what is left per account and whether any quota will be wasted'],
      ['/claude-agent-hub:ready on | off', 'Turn the 24/7 priming "hi" on or off'],
      ['/claude-agent-hub:duo &lt;your setup&gt;', 'Run agents together in any arrangement you describe (debate, build + test, review…)'],
    ]) + '<div class="small muted" style="margin-top:8px">You can also just write in plain words, e.g. "use Codex to review this": the same skill starts automatically.</div>') +
    sec('10 · Commands in a terminal (<span class="mono">cam</span>)', cmdTable([
      ['cam status', 'All Claude accounts with usage, resets and the next account'],
      ['cam switch [name]', 'Switch now (no name = best account)'],
      ['cam best', 'Usable accounts ranked best-first'],
      ['cam week', 'Weekly plan'],
      ['cam refresh', 'Fetch live usage for every account now'],
      ['cam ready on | off', '24/7 priming on/off'],
      ['cam prime &lt;name&gt;', 'Send the priming "hi" to one account now (≈240 tokens)'],
      ['cam accounts add | import | relogin | remove | pause | resume &lt;name&gt;', 'Manage Claude accounts from the terminal'],
      ['cam log [n]', 'Last n events (switches, primes, tests, errors)'],
      ['cam doctor', 'Check that everything is installed and running'],
      ['cam keep-awake on | off', 'Keep the laptop awake while plugged in (for 24/7 work)'],
      ['cam install / cam uninstall [--purge]', 'Set up or remove everything (--purge also deletes saved logins)'],
    ])) +
    sec('11 · In the editor', cmdTable([
      ['Status bar → Agent Hub', 'Click: open this dashboard · Hover: quick overview of accounts, agents and platforms'],
      ['People icon (editor top-right / Activity Bar)', 'Open this dashboard as a tab or in the side bar'],
      ['Ctrl+Shift+P → "Agent Hub: Open dashboard"', 'Same, from the command palette'],
      ['Ctrl+Shift+P → "Agent Hub: Refresh"', 'Re-check platforms, accounts and usage now'],
      ['Ctrl+Enter in an agent’s message box', 'Send the message'],
    ])) +
    sec('12 · What the master (Claude) can do for you', cmdTable([
      ['agent_start', 'Start a named agent on a platform, with a role, permission, model and first task'],
      ['agent_send', 'Send the next message to an agent (it keeps its whole conversation)'],
      ['agent_read', 'Read an agent’s status and latest reply (short summary, saves tokens)'],
      ['agent_list · agent_stop · agent_retry', 'List, stop, or retry agents'],
      ['agent_set_model · models_list', 'Change an agent’s model / show available models (unknown model → you get a table to choose from)'],
      ['switch_account · account_status · weekly_plan', 'Claude account actions'],
    ]) + '<div class="small muted" style="margin-top:8px">You never call these yourself. Ask Claude in plain words and it uses them.</div>') +
    '</div>';
}
function cmdTable(rows) {
  return '<table><tr><th style="width:45%">Command</th><th>What it does</th></tr>' + rows.map(([c, d]) => '<tr><td class="mono small">' + c + '</td><td class="small">' + d + '</td></tr>').join('') + '</table>';
}
const EXAMPLES = [
  ['Debate: find holes in my code', 'Use /claude-agent-hub:duo. Claude says <file or feature> is correct and safe; Codex must disagree and find loopholes with file:line evidence. 2 rounds, then you decide and save the verdict.'],
  ['Build with Claude, test like a real user with Codex', 'Use /claude-agent-hub:duo. Claude builds <feature> in <folder>. Codex tests it as a real user: no test scripts, run the app and try normal, edge and wrong inputs. Loop until it passes, max 3 rounds.'],
  ['Review my uncommitted changes', 'Start a Codex agent (read only) to review my uncommitted changes in this project. Claude fixes what it finds. Report what was changed.'],
  ['Second opinion from another model', 'Ask Hermes and Codex separately: <your question>. Compare both answers and recommend one, with reasons.'],
  ['Use a specific model', 'Start a Codex agent named reviewer using model <model name> to review <file>. If that model does not exist, show me the list of models to choose from.'],
  ['Use a specific account', 'Start a Codex agent on my "<account name>" account to <task>.'],
  ['Check on running agents', 'List all hub agents and summarize what each one is doing and whether any need me.'],
  ['Continue after a limit or a restart', 'Check the Agent Hub: list the agents, read their latest replies, and continue the work where it stopped.'],
  ['Stop everything', 'Stop all running hub agents and tell me what each one had finished.'],
  ['Account check', 'Show my Claude accounts, which one is active, and which one will be used next. Is any weekly quota going to be wasted?'],
];

// ── logs tab ──
function renderLogs() {
  const rows = [...(S.logs || [])].reverse();
  return '<div class="pad"><div style="display:flex;gap:10px;align-items:center"><h3 style="margin:0">Recent events</h3><input id="logf" placeholder="filter (e.g. switch, prime, hub, error)" style="max-width:320px;margin-left:auto" value="' + esc(S.logFilter || '') + '"><button data-act="refresh-logs">Refresh</button></div><table style="margin-top:8px"><tr><th style="width:130px">Time</th><th style="width:200px">Event</th><th>Details</th></tr>' +
    rows.filter((r) => !S.logFilter || JSON.stringify(r).toLowerCase().includes(S.logFilter.toLowerCase())).slice(0, 300).map((r) => { const { at, type, ...rest } = r; const bad = /error|fail|deferred|limited/.test(type); return '<tr><td class="small muted">' + clock(Date.parse(at)) + '</td><td class="mono small" style="color:' + (bad ? 'var(--err)' : 'inherit') + '">' + esc(type) + '</td><td class="mono small muted" style="white-space:pre-wrap;word-break:break-word">' + esc(JSON.stringify(rest).slice(0, 400)) + '</td></tr>'; }).join('') + '</table></div>';
}

function render() {
  renderHeader();
  const view = { home: renderHome, accounts: renderAccounts, agents: renderAgents, map: renderMap, platforms: renderPlatforms, logs: renderLogs, help: renderHelp }[S.tab] || renderAgents;
  const keepMsg = $('msg')?.value; const scroller = $('events'); const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  $('main').innerHTML = S.state ? view() : '<div class="empty">' + (S.error ? esc(S.error) : 'Connecting to the Agent Hub…') + '</div>';
  if (keepMsg && $('msg')) $('msg').value = keepMsg;
  const ev = $('events'); if (ev && atBottom) ev.scrollTop = ev.scrollHeight;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.switch')) return; // the switch handles itself (change event)
  const t = e.target.closest('[data-tab],[data-sel],[data-act],[data-chat]'); if (!t) return;
  if (t.dataset.tab) { S.tab = t.dataset.tab; if (S.tab === 'logs') post({ cmd: 'logs' }); save(); return render(); }
  if (t.dataset.chat) return post({ cmd: 'open-chat' });
  if (t.dataset.sel) { S.sel = t.dataset.sel; S.newForm = false; S.tab = 'agents'; S.modelTable = null; save(); post({ cmd: 'events', id: S.sel }); return render(); }
  const a = (S.state?.agents || []).find((x) => x.id === S.sel);
  switch (t.dataset.act) {
    case 'new': S.newForm = true; S.formPlatform = S.formPlatform || 'codex'; post({ cmd: 'models', platform: S.formPlatform }); return render();
    case 'cancel-new': S.newForm = false; return render();
    case 'back': S.sel = null; S.newForm = false; save(); return render();
    case 'create': return post({ cmd: 'create', body: { name: $('f-name').value.trim(), platform: $('f-platform').value, model: $('f-model').value.trim() || null, permission: $('f-perm').value, account: $('f-acct')?.value || null, cwd: $('f-cwd').value.trim(), role: $('f-role').value.trim(), task: $('f-task').value.trim() } });
    case 'send': { const v = $('msg').value.trim(); if (!v || !a) return; $('msg').value = ''; return post({ cmd: 'send', id: a.id, text: v }); }
    case 'stop': return post({ cmd: 'stop', id: a.id });
    case 'retry': return post({ cmd: 'retry', id: a.id });
    case 'remove': return post({ cmd: 'remove', id: a.id, name: a.name });
    case 'model': return post({ cmd: 'set-model', id: a.id, platform: a.platform, current: a.model });
    case 'models': S.modelTable = { platform: t.dataset.p, loading: true }; render(); return post({ cmd: 'models-table', platform: t.dataset.p });
    case 'models-refresh': S.modelTable = { platform: t.dataset.p, loading: true }; render(); return post({ cmd: 'models-table', platform: t.dataset.p, refresh: true });
    case 'refresh-platforms': return post({ cmd: 'refresh', platforms: true });
    case 'refresh-logs': return post({ cmd: 'logs' });
    case 'switch-account': return post({ cmd: 'switch-account', name: t.dataset.name });
    case 'ready': e.preventDefault(); return post({ cmd: 'ready', on: t.dataset.on === 'true' });
    case 'new-from-home': S.tab = 'agents'; S.newForm = true; S.formPlatform = S.formPlatform || 'codex'; post({ cmd: 'models', platform: S.formPlatform }); save(); return render();
    case 'goto-plat': S.tab = 'accounts'; S.acctPlat = t.dataset.p; save(); return render();
    case 'add-account': return post({ cmd: 'acct-add', platform: t.dataset.p });
    case 'relogin': return post({ cmd: 'acct-login', platform: t.dataset.p, name: t.dataset.n, relogin: true });
    case 'acct-activate': return post({ cmd: 'acct-activate', platform: t.dataset.p, name: t.dataset.n });
    case 'acct-preferred': return post({ cmd: 'acct-preferred', platform: t.dataset.p, name: t.dataset.n });
    case 'acct-force': return post({ cmd: 'acct-force', name: t.dataset.n });
    case 'acct-release': return post({ cmd: 'acct-release' });
    case 'acct-pause': return post({ cmd: 'acct-pause', platform: t.dataset.p, name: t.dataset.n, paused: t.dataset.paused === 'true' });
    case 'acct-remove': return post({ cmd: 'acct-remove', platform: t.dataset.p, name: t.dataset.n });
    case 'acct-test': S.testing[t.dataset.p + ':' + t.dataset.n] = true; render(); return post({ cmd: 'acct-test', platform: t.dataset.p, name: t.dataset.n });
    case 'toggle-priming': S.primingOpen = !S.primingOpen; save(); return render();
    case 'help-goto': S.tab = t.dataset.tab2; save(); return render();
    case 'copy': return post({ cmd: 'copy', text: t.dataset.text });
    case 'acct-refresh': S.refreshing[t.dataset.p] = true; render(); return post({ cmd: 'acct-refresh', platform: t.dataset.p });
    case 'open-chat': return post({ cmd: 'open-chat' });
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset?.setting) {
    const key = e.target.dataset.setting, on = e.target.checked;
    if (S.state?.accounts) S.state.accounts[key] = on; // optimistic: flips immediately
    render();
    return post({ cmd: 'setting', key, value: on });
  }
  if (e.target.id === 'f-platform') { S.formPlatform = e.target.value; post({ cmd: 'models', platform: S.formPlatform }); const keep = { n: $('f-name').value, t: $('f-task').value, r: $('f-role').value, c: $('f-cwd').value }; render(); $('f-name').value = keep.n; $('f-task').value = keep.t; $('f-role').value = keep.r; $('f-cwd').value = keep.c; } });
document.addEventListener('input', (e) => { if (e.target.id === 'logf') { S.logFilter = e.target.value; const pos = e.target.selectionStart; render(); const el = $('logf'); el.focus(); el.setSelectionRange(pos, pos); } });
document.addEventListener('keydown', (e) => {
  if (e.target.classList?.contains('disclose') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); S.primingOpen = !S.primingOpen; save(); render(); const d = document.querySelector('.disclose'); if (d) d.focus(); return; } if (e.target.id === 'msg' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.querySelector('[data-act="send"]')?.click(); } });

window.addEventListener('message', (m) => {
  const d = m.data;
  if (d.type === 'state') { S.state = d.state; S.workspace = d.workspace || S.workspace; S.error = null; if (S.sel && !S.state.agents.some((a) => a.id === S.sel)) S.sel = null; render(); if (S.sel && !S.events[S.sel]) post({ cmd: 'events', id: S.sel }); }
  else if (d.type === 'live') { S.live = d.live; renderHeader(); }
  else if (d.type === 'error') { S.error = d.text; if (!S.state) render(); }
  else if (d.type === 'events') { S.events[d.id] = d.events; if (S.tab === 'agents' && S.sel === d.id) render(); }
  else if (d.type === 'event') { const arr = S.events[d.agentId]; if (arr) { arr.push(d.event); if (arr.length > 1500) arr.splice(0, arr.length - 1500); } if (S.tab === 'agents' && S.sel === d.agentId) render(); }
  else if (d.type === 'agent') { if (!S.state) return; const i = S.state.agents.findIndex((a) => a.id === d.agent.id); if (d.agent.status === 'removed') { if (i >= 0) S.state.agents.splice(i, 1); } else if (i >= 0) S.state.agents[i] = d.agent; else S.state.agents.push(d.agent); if (S.tab !== 'logs' && S.tab !== 'platforms') render(); else renderHeader(); }
  else if (d.type === 'link') { if (S.state) { S.state.links.push(d.link); if (S.tab === 'map') render(); } }
  else if (d.type === 'accounts') { if (S.state) { S.state.accounts = d.accounts; if (S.tab === 'accounts') render(); else renderHeader(); } }
  else if (d.type === 'models') { S.models[d.platform] = d.models; if (S.newForm) { const v = $('f-model')?.value; render(); if ($('f-model')) $('f-model').value = v || ''; } }
  else if (d.type === 'models-table') { S.modelTable = { platform: d.platform, agent: d.agent || null, html: modelsHtml(d.models), cachedAt: d.cachedAt || null }; if (d.models) S.models[d.platform] = d.models; render(); }
  else if (d.type === 'created') { S.newForm = false; S.sel = d.id; S.tab = 'agents'; save(); post({ cmd: 'events', id: d.id }); render(); }
  else if (d.type === 'logs') { S.logs = d.logs; if (S.tab === 'logs') render(); }
  else if (d.type === 'platformAccounts') { if (S.state) { S.state.platformAccounts = d.data; if (S.tab === 'home' || S.tab === 'accounts' || S.newForm) render(); } }
  else if (d.type === 'refreshed') { delete S.refreshing[d.platform]; if (d.ok) S.refreshedAt[d.platform] = Date.now(); render(); toast(d.ok ? (PLAT[d.platform] || [, d.platform])[1] + ' refreshed in ' + (d.ms / 1000).toFixed(1) + 's' + (d.hasUsage ? '' : ' (sign-in status only: this platform does not publish usage limits)') : 'Refresh failed: ' + friendly(d.error), !d.ok); }
  else if (d.type === 'test-result') { delete S.testing[d.key]; if (S.state) { S.state.tests = S.state.tests || {}; S.state.tests[d.key] = d.result; } render(); toast(d.result.ok ? '✓ ' + d.key.replace(':', ' · ') + ' works (' + (d.result.ms / 1000).toFixed(1) + 's)' : '✕ ' + d.key.replace(':', ' · ') + ': ' + String(d.result.error || 'failed').slice(0, 140), !d.result.ok); }
  else if (d.type === 'toast') toast(d.text, d.err);
  else if (d.type === 'select') { S.sel = d.id; S.tab = 'agents'; S.newForm = false; save(); post({ cmd: 'events', id: d.id }); render(); }
});
post({ cmd: 'ready' });
</script></body></html>`;
}

function nonce() { return require('crypto').randomBytes(16).toString('hex'); }
const PLATFORM_LABEL = { claude: 'Claude', codex: 'Codex', hermes: 'Hermes', agy: 'Antigravity CLI', kimi: 'Kimi', opencode: 'OpenCode' };

/** Status bar hover: clean sections, aligned columns, color-graded values. */
function richTooltip(state, live) {
  const C = { ok: '#3f9b6b', warn: '#c68b2c', err: '#c8534a', info: '#4f7cac', idle: '#8b929c' };
  const col = (u) => (u >= 85 ? C.err : u >= 60 ? C.warn : C.ok);
  const span = (c, t) => `<span style="color:${c};">${t}</span>`;
  const muted = (t) => span(C.idle, t);
  const left = (t) => {
    if (!t) return muted('—');
    const m = Math.max(0, Math.round((t - Date.now()) / 6e4));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return muted(d ? `${d}d ${h}h` : h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`);
  };
  const md = new vscode.MarkdownString('', true);
  md.supportHtml = true;
  md.isTrusted = true;
  const acc = state?.accounts || readJson(STATUS_JSON);

  md.appendMarkdown(`**Agent Hub** &nbsp; ${span(live ? C.ok : C.err, live ? '● Live' : '● Offline')} &nbsp;·&nbsp; ${acc?.ready ? '24/7 priming on' : 'priming off'}${acc?.autoSwitch === false ? ' &nbsp;·&nbsp; ' + span(C.warn, 'auto-switch off') : ''}\n\n---\n\n`);

  if (acc?.accounts?.length) {
    const rows = [...acc.accounts].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    md.appendMarkdown('**Claude accounts**\n\n');
    md.appendMarkdown('| Account | 5-hour | Resets | Weekly | Resets | Status |\n|:--|--:|:--|--:|:--|:--|\n');
    for (const a of rows) {
      const st = a.active ? span(C.info, acc.forced === a.name ? 'Active · held to 100%' : 'Active') : a.usable ? span(C.ok, 'Ready') : span(C.err, a.statusLabel);
      md.appendMarkdown(`| ${a.active ? `**${a.email || a.name}** ▸` : a.email || a.name} | ${span(col(a.five.util), a.five.util + '%')} | ${left(a.five.resetsAt)} | ${span(col(a.week.util), a.week.util + '%')} | ${left(a.week.resetsAt)} | ${st} |\n`);
    }
    if (acc.next) md.appendMarkdown(`\n${muted('If the active account runs out →')} **${(acc.accounts.find((x) => x.name === acc.next.name) || {}).email || acc.next.name}**\n`);
    md.appendMarkdown('\n---\n\n');
  }

  const agents = state?.agents || [];
  const running = agents.filter((a) => a.status === 'working').length;
  const needs = agents.filter((a) => ['needs-login', 'error'].includes(a.status)).length;
  const waiting = agents.filter((a) => a.status === 'waiting').length;
  md.appendMarkdown('**Agents**\n\n');
  md.appendMarkdown('| Running | Need you | Waiting | Total |\n|:-:|:-:|:-:|:-:|\n');
  md.appendMarkdown(`| ${span(running ? C.ok : C.idle, '● ' + running)} | ${span(needs ? C.warn : C.idle, '● ' + needs)} | ${span(waiting ? C.warn : C.idle, '● ' + waiting)} | ${agents.length} |\n\n---\n\n`);

  const pa = state?.platformAccounts;
  if (pa) {
    md.appendMarkdown('**Platforms**\n\n');
    md.appendMarkdown('| Platform | Accounts | Weekly | Status |\n|:--|:-:|--:|:--|\n');
    for (const v of Object.values(pa)) {
      const signed = v.accounts.filter((a) => a.signedIn).length;
      const warn = v.accounts.find((a) => a.warning);
      const lim = v.accounts.find((a) => a.usage?.week);
      const status = !signed ? span(C.warn, '● Not signed in') : warn ? span(C.warn, '● Attention') : span(C.ok, '● Ready');
      md.appendMarkdown(`| ${v.label} | ${signed} | ${lim ? span(col(lim.usage.week.util), lim.usage.week.util + '%') : muted('—')} | ${status} |\n`);
    }
    md.appendMarkdown('\n---\n\n');
  }
  md.appendMarkdown(muted('Click to open the Agent Hub'));
  return md;
}

function activate(ctx) {
  const views = new Set();
  let state = null, live = false, panel = null, lastActive = null;
  const autoOpenedFor = new Set();
  const workspace = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const broadcast = (msg) => views.forEach((w) => w.postMessage(msg));

  const hostLabel = (nm) => ((state?.accounts?.accounts || []).find((x) => x.name === nm) || {}).email || nm;
  // status bar
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  item.command = 'cam.dashboard';
  item.text = '$(account) Agent Hub';
  item.show();
  function paintStatus() {
    const acc = state?.accounts || readJson(STATUS_JSON);
    const act = acc?.accounts?.find((a) => a.active);
    const agents = state?.agents || [];
    const working = agents.filter((a) => a.status === 'working').length;
    const needs = agents.filter((a) => ['needs-login', 'error'].includes(a.status)).length;
    const parts = [];
    if (act) parts.push(`${act.email ? act.email.split('@')[0] : act.name}  5h ${act.five.util}%  wk ${act.week.util}%`);
    if (working) parts.push(`$(sync~spin) ${working}`);
    if (needs) parts.push(`$(bell) ${needs}`);
    item.text = `$(account) ${parts.join('   ') || 'Agent Hub'}`;
    item.backgroundColor = needs || (act && (act.status !== 'ok' || !acc.service?.running)) ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.tooltip = richTooltip(state, live);
    if (lastActive && act && act.name !== lastActive)
      vscode.window.showInformationMessage(`Claude account switched to ${act.email || act.name}. New chats use it; for an open chat use "New conversation".`, 'New conversation').then((p) => p && vscode.commands.executeCommand('claude-vscode.newConversation'));
    if (act) lastActive = act.name;
  }

  async function refreshState(opts = {}) {
    try {
      state = await api('GET', '/api/state' + (opts.platforms ? '?refresh=1' : ''));
      broadcast({ type: 'state', state, workspace: workspace() });
    } catch (e) {
      broadcast({ type: 'error', text: e.message });
    }
    paintStatus();
  }

  const stream = connectStream((type, data) => {
    if (type === 'event') broadcast({ type: 'event', agentId: data.agentId, event: data.event });
    else if (type === 'agent') {
      if (state) { const i = state.agents.findIndex((a) => a.id === data.id); if (i >= 0) state.agents[i] = data; else if (data.status !== 'removed') state.agents.push(data); }
      broadcast({ type: 'agent', agent: data });
      paintStatus();
      // Open the dashboard automatically when the Claude master starts a new agent (once per agent, without stealing focus).
      if (data.createdBy === 'master' && !autoOpenedFor.has(data.id) && vscode.workspace.getConfiguration('agentHub').get('autoOpen', true)) {
        autoOpenedFor.add(data.id);
        openPanel(true).then(() => broadcast({ type: 'select', id: data.id }));
      }
      if (data.status === 'needs-login' || data.status === 'error') vscode.window.showWarningMessage(`Agent ${data.name}: ${String(data.statusDetail || data.status).split('\n')[0]}`, 'Open').then((p) => p && openPanel(false).then(() => broadcast({ type: 'select', id: data.id })));
    } else if (type === 'link') broadcast({ type: 'link', link: data });
    else if (type === 'accounts') { if (state) state.accounts = data; broadcast({ type: 'accounts', accounts: data }); paintStatus(); }
    else if (type === 'platformAccounts') { if (state) state.platformAccounts = data; broadcast({ type: 'platformAccounts', data }); paintStatus(); }
  }, (ok) => { if (ok !== live) { live = ok; broadcast({ type: 'live', live }); if (ok) refreshState(); paintStatus(); } });

  async function onMessage(w, m) {
    try {
      switch (m.cmd) {
        case 'ready': if (state) w.postMessage({ type: 'state', state, workspace: workspace() }); w.postMessage({ type: 'live', live }); return refreshState();
        case 'refresh': return refreshState({ platforms: !!m.platforms });
        case 'events': return w.postMessage({ type: 'events', id: m.id, events: await api('GET', `/api/agents/${encodeURIComponent(m.id)}/events?limit=1500`) });
        case 'send': return api('POST', `/api/agents/${encodeURIComponent(m.id)}/send`, { text: m.text, from: 'user' }).then((r) => r.queued && w.postMessage({ type: 'toast', text: `Queued (position ${r.position}); the agent is busy.` }));
        case 'stop': return api('POST', `/api/agents/${encodeURIComponent(m.id)}/stop`);
        case 'retry': return api('POST', `/api/agents/${encodeURIComponent(m.id)}/retry`);
        case 'remove': {
          const ok = await vscode.window.showWarningMessage(`Remove agent "${m.name}"? Its transcript stays on disk.`, { modal: true }, 'Remove');
          if (ok) { await api('DELETE', `/api/agents/${encodeURIComponent(m.id)}`); refreshState(); }
          return;
        }
        case 'create': {
          const r = await api('POST', '/api/agents', { ...m.body, from: 'user' });
          w.postMessage({ type: 'created', id: r.agent.id });
          return refreshState();
        }
        case 'models': return w.postMessage({ type: 'models', platform: m.platform, models: await api('GET', `/api/models/${m.platform}`) });
        case 'models-table': {
          const models = await api('GET', `/api/models/${m.platform}${m.refresh ? '?refresh=1' : ''}`);
          const cached = await api('GET', '/api/models-cache').catch(() => ({}));
          return w.postMessage({ type: 'models-table', platform: m.platform, models, cachedAt: cached[m.platform] || null });
        }
        case 'set-model': {
          const pick = await pickModel(m.platform, m.current);
          if (!pick) return;
          try { await api('POST', `/api/agents/${encodeURIComponent(m.id)}/model`, { model: pick }); w.postMessage({ type: 'toast', text: `Model set to ${pick}` }); }
          catch (e) {
            if (e.code === 'MODEL_NOT_FOUND') w.postMessage({ type: 'models-table', platform: m.platform, agent: m.id, models: await api('GET', `/api/models/${m.platform}`).catch(() => []) });
            w.postMessage({ type: 'toast', text: e.message.split('\n')[0], err: true });
          }
          return refreshState();
        }
        case 'switch-account': await api('POST', '/api/accounts/switch', { name: m.name }); w.postMessage({ type: 'toast', text: `Switched to ${hostLabel(m.name)}. New Claude chats use it.` }); return refreshState();
        case 'ready': await api('POST', '/api/ready', { on: m.on }); return refreshState();
        case 'logs': return w.postMessage({ type: 'logs', logs: await api('GET', '/api/logs?n=400') });
        case 'acct-add': {
          const label = PLATFORM_LABEL[m.platform] || m.platform;
          const name = await vscode.window.showInputBox({
            title: `Add ${label} account`,
            prompt: 'A short name for this account (you will sign in next)',
            placeHolder: 'e.g. work2, personal',
            validateInput: (v) => (/^[A-Za-z0-9_-]{1,24}$/.test(v) ? null : 'Use 1-24 letters, digits, - or _'),
          });
          if (!name) return;
          if (m.platform === 'agy') {
            const ok = await vscode.window.showWarningMessage('agy keeps one login at a time. Your current agy login is saved first, then a fresh sign-in opens.', { modal: true }, 'Continue');
            if (!ok) return;
          }
          return startLogin(w, m.platform, name, false);
        }
        case 'acct-login': return startLogin(w, m.platform, m.name, true);
        case 'acct-refresh': {
          try {
            const r = await api('POST', `/api/platform-accounts/${m.platform}/refresh`, {}, 120000);
            await refreshState();
            return w.postMessage({ type: 'refreshed', platform: m.platform, ok: true, ms: r.ms, hasUsage: r.hasUsage });
          } catch (e) {
            return w.postMessage({ type: 'refreshed', platform: m.platform, ok: false, error: e.message });
          }
        }
        case 'setting': {
          try {
            await api('POST', '/api/settings', { [m.key]: !!m.value });
            const label = { autoSwitch: 'Automatic account switching', ready: 'Claude priming', monitoring: 'Background monitoring', primeAll: 'Session priming (all platforms)', primeCodex: 'Codex priming' }[m.key] || m.key;
            w.postMessage({ type: 'toast', text: `${label} is ${m.value ? 'on' : 'off'}.` });
          } catch (e) { w.postMessage({ type: 'toast', text: e.message, err: true }); }
          return refreshState();
        }
        case 'copy': await vscode.env.clipboard.writeText(m.text || ''); return w.postMessage({ type: 'toast', text: 'Copied. Paste it into your Claude chat and edit the <parts>.' });
        case 'acct-test': {
          const key = `${m.platform}:${m.name}`;
          let result;
          try { result = await api('POST', `/api/platform-accounts/${m.platform}/${encodeURIComponent(m.name)}/test`, {}, 180000); }
          catch (e) { result = { ok: false, error: e.message, ms: 0, at: Date.now() }; }
          return w.postMessage({ type: 'test-result', key, result });
        }
        case 'acct-activate': {
          const r = await api('POST', `/api/platform-accounts/${m.platform}/${encodeURIComponent(m.name)}/activate`);
          w.postMessage({ type: 'toast', text: m.platform === 'claude' ? (r.changed ? `Switched to ${hostLabel(m.name)}. New Claude chats use it.` : `Already on ${hostLabel(m.name)}.`) : `${m.name} is now the active ${PLATFORM_LABEL[m.platform]} account.` });
          return refreshState();
        }
        case 'acct-force': {
          const a = (state?.accounts?.accounts || []).find((x) => x.name === m.name) || {};
          const ok = await vscode.window.showWarningMessage(
            `Force-switch to ${a.email || m.name}?`,
            { modal: true, detail: `It is at ${a.five?.util ?? '?'}% of its 5-hour session and ${a.week?.util ?? '?'}% of its weekly limit. Claude Code will stay on it until it reaches 100%, then automatic switching moves to the best account. New chats use it; for an open chat start a new conversation.` },
            'Force switch');
          if (!ok) return;
          const r = await api('POST', `/api/platform-accounts/claude/${encodeURIComponent(m.name)}/force`);
          w.postMessage({ type: 'toast', text: `${r.changed ? 'Switched to' : 'Staying on'} ${a.email || m.name}: held until it reaches 100%.` });
          return refreshState();
        }
        case 'acct-release': await api('POST', '/api/accounts/release-hold'); w.postMessage({ type: 'toast', text: 'Hold released: automatic switching decides again.' }); return refreshState();
        case 'acct-preferred': await api('POST', `/api/platform-accounts/${m.platform}/${encodeURIComponent(m.name)}/preferred`); w.postMessage({ type: 'toast', text: `New ${PLATFORM_LABEL[m.platform]} agents will use ${m.name}.` }); return refreshState();
        case 'acct-pause': await api('POST', `/api/platform-accounts/${m.platform}/${encodeURIComponent(m.name)}/pause`, { paused: m.paused }); return refreshState();
        case 'acct-remove': {
          const ok = await vscode.window.showWarningMessage(`Remove ${PLATFORM_LABEL[m.platform]} account "${m.name}"? Its saved login is deleted from this computer.`, { modal: true }, 'Remove');
          if (!ok) return;
          await api('DELETE', `/api/platform-accounts/${m.platform}/${encodeURIComponent(m.name)}`);
          w.postMessage({ type: 'toast', text: `Removed ${m.name}.` });
          return refreshState();
        }
        case 'open-chat': return vscode.commands.executeCommand('claude-vscode.focus').then(undefined, () => vscode.commands.executeCommand('claude-vscode.sidebar.open'));
      }
    } catch (e) {
      w.postMessage({ type: 'toast', text: e.message, err: true });
    }
  }

  /** Model picker that opens instantly with a spinner, then fills in (from cache: instant; first time: a few seconds). */
  function pickModel(platform, current) {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      const other = { label: '$(edit) Type another model…', alwaysShow: true, other: true };
      qp.title = `Model for this agent (now: ${current || 'default'})`;
      qp.placeholder = 'Loading models…';
      qp.busy = true;
      qp.matchOnDescription = true;
      qp.items = [other];
      let done = false;
      qp.onDidAccept(async () => {
        const sel = qp.selectedItems[0];
        done = true;
        qp.hide();
        if (!sel) return resolve(qp.value || null);
        if (sel.other) return resolve((await vscode.window.showInputBox({ prompt: 'Model name', value: qp.value || current || '' })) || null);
        resolve(sel.label);
      });
      qp.onDidHide(() => { if (!done) resolve(null); qp.dispose(); });
      qp.show();
      api('GET', `/api/models/${platform}`)
        .then((list) => {
          qp.items = [...list.map((x) => ({ label: x.id, description: x.name && x.name !== x.id ? x.name : '', detail: x.note || '' })), other];
          qp.placeholder = list.length ? 'Choose a model (type to filter)' : 'This platform has no model list: type a model name';
        })
        .catch(() => { qp.placeholder = 'Could not load the list: type a model name'; })
        .finally(() => { qp.busy = false; });
    });
  }

  /** Sign-in happens in an IDE terminal (CLIs need it for browser / device-code logins), with the account's env. */
  async function startLogin(w, platform, name, relogin) {
    const r = await api('POST', `/api/platform-accounts/${platform}/login`, { name, relogin });
    const term = vscode.window.createTerminal({ name: `Sign in · ${PLATFORM_LABEL[platform] || platform} · ${name}`, env: r.env || {}, cwd: r.cwd || undefined, iconPath: new vscode.ThemeIcon('key') });
    term.show();
    term.sendText(r.command);
    vscode.window.showInformationMessage(`${PLATFORM_LABEL[platform]} · ${name}: ${r.hint || 'Complete the sign-in in the terminal.'} The account appears as signed in automatically.`);
    const sub = vscode.window.onDidCloseTerminal(async (t) => {
      if (t !== term) return;
      sub.dispose();
      if (platform === 'agy') {
        // agy stores its login in Windows Credential Manager: capture the new login, or restore the previous one.
        const r = await api('POST', '/api/platform-accounts/agy/login-finished').catch(() => ({}));
        if (r.captured) vscode.window.showInformationMessage(`Antigravity account "${r.captured}" saved.`);
        else if (r.rolledBack) vscode.window.showWarningMessage(`Antigravity sign-in was not completed. Your previous login${r.restored ? ` (${r.restored})` : ''} was restored.`);
      }
      refreshState();
    });
    ctx.subscriptions.push(sub);
    // Refresh while the user signs in, so the card turns green without any extra click.
    let n = 0;
    const poll = setInterval(() => { refreshState(); if (++n > 18) clearInterval(poll); }, 10000);
    w.postMessage({ type: 'toast', text: 'Sign-in opened in the terminal below.' });
  }

  function wire(webview, compact, onDispose) {
    webview.options = { enableScripts: true };
    webview.html = html(nonce(), compact);
    views.add(webview);
    onDispose(() => views.delete(webview));
    webview.onDidReceiveMessage((m) => onMessage(webview, m));
  }

  async function openPanel(preserveFocus) {
    if (panel) { panel.reveal(undefined, preserveFocus); return; }
    panel = vscode.window.createWebviewPanel('agentHub', 'Claude Agent Hub', { viewColumn: vscode.ViewColumn.Active, preserveFocus }, { enableScripts: true, retainContextWhenHidden: false });
    panel.iconPath = vscode.Uri.file(path.join(__dirname, 'media', 'icon.svg'));
    wire(panel.webview, false, (fn) => panel.onDidDispose(() => { fn(); panel = null; }));
    await new Promise((r) => setTimeout(r, 400));
  }

  ctx.subscriptions.push(
    item,
    stream,
    vscode.window.registerWebviewViewProvider('camDashboardView', { resolveWebviewView(view) { wire(view.webview, true, (fn) => view.onDidDispose(fn)); } }),
    vscode.commands.registerCommand('cam.dashboard', () => openPanel(false)),
    vscode.commands.registerCommand('cam.newAgent', async () => { await openPanel(false); }),
    vscode.commands.registerCommand('cam.refresh', () => refreshState({ platforms: true })),
  );
  refreshState();
  const timer = setInterval(() => refreshState(), 20000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}
module.exports = { activate, deactivate, _html: html, _richTooltip: richTooltip };
