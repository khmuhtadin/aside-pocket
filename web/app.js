import { html, render, useState, useEffect, useLayoutEffect, useRef } from '/vendor/preact-htm.js';
import { api, getToken, setToken, hooks, openStream, imageUrl, screenshotUrl } from '/api.js';

// ---------- small helpers ----------

const ICONS = {
  inbox: 'M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5zm0 0h4.5a3.5 3.5 0 0 0 7 0H20',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 12l2.5 2.5 4.5-5',
  plus: 'M12 5v14M5 12h14',
  retry: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2',
  gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  back: 'M15 5l-7 7 7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
  up: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  tick: 'M5 12.5l4.5 4.5L19 7.5',
  archive: 'M4 5h16v4H4zM6 9v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9M10 13h4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  close: 'M6 6l12 12M18 6L6 18',
  screen: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 20h6M12 16v4',
};

const Icon = ({ name, size = 22 }) => html`
  <svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width=${name === 'more' ? 2.6 : 1.7} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d=${ICONS[name]} />
  </svg>`;

const STATUS = { running: 'Running', waiting: 'Waiting for you', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const cap = (e) => e[0].toUpperCase() + e.slice(1);
const effortLabel = (e) => (e === 'xhigh' ? 'Extra high' : cap(e));
// "claude-code/claude-opus-5-5" -> "claude-opus-5-5"
const shortModel = (m) => String(m || '').split('/').pop();
// The name the bridge lists for a model id; a model it does not list (a custom one) shows its modelId.
const modelName = (id, models) => (models.models.find((m) => m.id === id) || { name: shortModel(id) }).name;
const PERMISSIONS = { guard: 'Guard', 'full-access': 'Full access' };
const SOURCES = { cli: 'Pocket', sidepanel: 'Side panel', 'new-tab': 'New tab', 'tasks-page': 'Tasks page', 'mini-popup': 'Popup', branch: 'Branch' };

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return '';
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function when(iso) {
  if (!iso) return 'none';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const DAYS = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const UNITS = { MINUTELY: 'minute', HOURLY: 'hour', DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };

// "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9" -> "Every week on Mon, Wed at 09:00"
function schedule(rrule) {
  const line = String(rrule || '').split('\n').find((l) => l.includes('FREQ=')) || '';
  const p = Object.fromEntries(line.replace(/^RRULE:/, '').split(';').map((kv) => kv.split('=')));
  if (!p.FREQ) return 'No schedule';
  const n = Number(p.INTERVAL) || 1;
  const unit = UNITS[p.FREQ] || p.FREQ.toLowerCase();
  let text = n === 1 ? 'Every ' + unit : `Every ${n} ${unit}s`;
  if (p.BYDAY) text += ' on ' + p.BYDAY.split(',').map((d) => DAYS[d] || d).join(', ');
  if (p.BYHOUR) {
    const min = String(p.BYMINUTE || '0').split(',')[0].padStart(2, '0');
    text += ' at ' + p.BYHOUR.split(',').map((h) => h.padStart(2, '0') + ':' + min).join(', ');
  }
  return text;
}

// What a waiting session wants. The bridge sends { suspension, toolQuestion }: an approval
// ({ request: { scope: { type, path, mode } } }) or ask_user_question arguments ({ questions: [...] }).
function readQuestion(q) {
  if (q == null) return { text: '', options: [], raw: '' };
  if (typeof q !== 'object') return { text: String(q), options: [], raw: '' };
  const ask = q.toolQuestion || q;
  if (Array.isArray(ask.questions) && ask.questions.length) {
    const text = ask.questions.map((x) => x.question).join('\n\n');
    const options = ask.questions.length === 1 ? (ask.questions[0].options || []).map((o) => o.label) : [];
    return { text, options, raw: '' };
  }
  const scope = (q.suspension || q).request && (q.suspension || q).request.scope;
  if (scope && scope.path) return { text: `Wants to ${scope.mode || 'use'} ${scope.path}`, options: [], raw: '' };
  const text = ['question', 'text', 'prompt'].map((k) => q[k]).filter((v) => typeof v === 'string' && v).join('\n\n');
  const options = (Array.isArray(q.options) ? q.options : []).map((o) =>
    o && typeof o === 'object' ? String(o.label || o.text || o.title || o.value || JSON.stringify(o)) : String(o));
  return { text, options, raw: text ? '' : JSON.stringify(q, null, 2) };
}

function urlBase64ToUint8Array(base64url) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// One toast at a time. App wires this up.
let toast = () => {};

// ---------- markdown (builds elements, never innerHTML) ----------

// ![alt](src). Web images load directly; files an agent saved on the Mac come through the bridge.
function Img({ src, alt }) {
  const [url, setUrl] = useState(/^https?:/.test(src) ? src : '');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (url) return;
    let made;
    let gone = false; // unmounted before the image arrived
    imageUrl(src).then((u) => { if (gone) return URL.revokeObjectURL(u); made = u; setUrl(u); }, () => setFailed(true));
    return () => { gone = true; made && URL.revokeObjectURL(made); };
  }, []);
  if (failed) return html`<span class="img-missing">${alt || 'Image'} (not available)</span>`;
  if (!url) return html`<span class="img-missing">${alt || 'Image'}…</span>`;
  return html`<img class="md-img" src=${url} alt=${alt} loading="lazy" onError=${() => setFailed(true)} />`;
}

// Emphasis needs a non-word character outside and no space inside, so snake_case, 2 * 3 and *.js stay as typed.
const INLINE = new RegExp([
  /!\[([^\]]*)\]\(([^)\n]+)\)/, // 1 2 image
  /`([^`]+)`/, // 3 code
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, // 4 5 link
  /(https?:\/\/[^\s<>"')]+)/, // 6 bare link
  /\*\*\*(?!\s)(.+?)\*\*\*/, // 7 bold italic
  /\*\*(?!\s)(.+?)\*\*/, // 8 bold
  /~~(?!\s)(.+?)~~/, // 9 strike
  /(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])/, // 10 italic
  /(?<![\w_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\w_])/, // 11 italic
].map((r) => r.source).join('|'), 'g');

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(html`<${Img} key=${m[2]} src=${m[2].trim()} alt=${m[1]} />`);
    else if (m[3] != null) out.push(html`<code>${m[3]}</code>`);
    else if (m[5] || m[6]) out.push(html`<a href=${m[5] || m[6]} target="_blank" rel="noopener noreferrer">${m[4] || m[6]}</a>`);
    else if (m[7] != null) out.push(html`<strong><em>${inline(m[7])}</em></strong>`);
    else if (m[8] != null) out.push(html`<strong>${inline(m[8])}</strong>`);
    else if (m[9] != null) out.push(html`<s>${inline(m[9])}</s>`);
    else out.push(html`<em>${inline(m[10] || m[11])}</em>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// items: [{ text, start, kids }]. start is the number an ordered item was written with, null for a bullet.
function list(items) {
  const lis = items.map((it) => html`<li>${inline(it.text)}${it.kids && it.kids.length ? list(it.kids) : null}</li>`);
  return items[0].start == null ? html`<ul>${lis}</ul>` : html`<ol start=${items[0].start}>${lis}</ol>`;
}

function Markdown({ text }) {
  const blocks = [];
  let para = [];
  let items = [];
  let indent = 0; // of the list's first item; 2+ spaces deeper is a nested item
  let rows = [];
  let quote = [];
  const flush = () => {
    if (quote.length) blocks.push(html`<blockquote>${inline(quote.join('\n'))}</blockquote>`);
    quote = [];
    if (rows.length) {
      const [head, ...body] = rows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
      blocks.push(html`<div class="table"><table>
        <thead><tr>${head.map((c) => html`<th>${inline(c)}</th>`)}</tr></thead>
        <tbody>${body.map((r) => html`<tr>${r.map((c) => html`<td>${inline(c)}</td>`)}</tr>`)}</tbody>
      </table></div>`);
      rows = [];
    }
    if (para.length) blocks.push(html`<p>${inline(para.join('\n'))}</p>`);
    if (items.length) blocks.push(list(items));
    para = [];
    items = [];
  };
  String(text || '').split('```').forEach((part, i) => {
    if (i % 2) {
      flush();
      blocks.push(html`<pre>${part.replace(/^[^\n]*\n/, '').trimEnd()}</pre>`);
      return;
    }
    for (const line of part.split('\n')) {
      const item = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const cells = line.trim().match(/^\|(.+)\|$/);
      const quoted = line.match(/^\s*>\s?(.*)$/);
      if (!line.trim()) flush();
      else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flush();
        blocks.push(html`<hr />`);
      } else if (quoted) {
        if (para.length || items.length || rows.length) flush();
        quote.push(quoted[1]);
      } else if (cells) {
        if (para.length || items.length) flush();
        rows.push(cells[1].split("|").map((c) => c.trim()));
      } else if (heading) {
        flush();
        // The screen title is the h1, so # starts at h2.
        const h = 'h' + Math.min(heading[1].length + 1, 4);
        blocks.push(html`<${h}>${inline(heading[2])}<//>`);
      } else if (item) {
        if (para.length) flush();
        const it = { text: item[3], start: /\d/.test(item[2]) ? parseInt(item[2], 10) : null, kids: [] };
        if (!items.length) indent = item[1].length;
        if (items.length && item[1].length >= indent + 2) items[items.length - 1].kids.push(it);
        else items.push(it);
      } else {
        if (items.length) flush();
        para.push(line);
      }
    }
  });
  flush();
  return html`<div class="md">${blocks}</div>`;
}

// ---------- shared pieces ----------

function Header({ title, back, st, children }) {
  const { online, health } = st;
  const up = online && (!health || health.aside);
  const running = (health && health.running) || 0;
  const label = !online ? 'Offline' : !health ? 'Connecting' : !health.aside ? 'Aside down' : running ? running + ' running' : 'Online';
  // Online needs no words (the green dot is enough); offline and Aside down have their banner.
  const quiet = label !== 'Connecting' && !(up && running);
  const dot = 'dot ' + (label === 'Connecting' ? '' : up ? 'on' : 'off');
  return html`
    <header class="header">
      <div class="bar">
        ${back && html`<a class="iconbtn" href=${back} aria-label="Back"><${Icon} name="back" /></a>`}
        <h1 class=${back ? 'small' : ''}>${title}</h1>
        ${back
          ? html`<span class="health" role="img" aria-label=${label}><i class=${dot}></i></span>`
          : html`<span class="health" role=${quiet ? 'img' : null} aria-label=${quiet ? label : null}>
              <i class=${dot}></i>${!quiet && label}</span>`}
        ${!back && st.switcher && html`
          <button class="switcher" aria-label=${`Profile ${st.switcher.name}. Switch profile`} onClick=${st.switcher.open}>
            <span>${st.switcher.name}</span><${Icon} name="down" size=${14} />
            ${st.switcher.alert && html`<i class="alert" role="img" aria-label="Activity in another profile"></i>`}
          </button>`}
        ${children}
      </div>
      ${!online && html`<div class="banner" role="alert">Mac unreachable — check Tailscale</div>`}
      ${online && health && !health.aside && html`<div class="banner" role="alert">Aside is not running on the Mac</div>`}
    </header>`;
}

// Scroll area with pull to refresh.
function Scroller({ onRefresh, children }) {
  const el = useRef();
  const hint = useRef();
  const touch = useRef(null);
  const [busy, setBusy] = useState(false);

  const start = (e) => {
    touch.current = el.current.scrollTop <= 0 ? { y: e.touches[0].clientY, x: e.touches[0].clientX, pull: 0 } : null;
  };
  const move = (e) => {
    const t = touch.current;
    if (!t) return;
    const dy = e.touches[0].clientY - t.y;
    const dx = e.touches[0].clientX - t.x;
    if (dy <= 0 || Math.abs(dx) > dy) return;
    t.pull = Math.min(dy * 0.45, 72);
    if (!hint.current) return; // the screen changed while a finger was still down
    hint.current.style.height = t.pull + 'px';
    hint.current.textContent = t.pull >= 56 ? 'Release to refresh' : 'Pull to refresh';
  };
  const end = async () => {
    const t = touch.current;
    touch.current = null;
    if (!hint.current) return;
    hint.current.style.height = '';
    hint.current.textContent = '';
    if (!t || t.pull < 56) return;
    setBusy(true);
    await onRefresh();
    setBusy(false);
  };

  return html`
    <main class="scroll" ref=${el} onTouchStart=${start} onTouchMove=${move} onTouchEnd=${end} onTouchCancel=${end}>
      <div class="pull" ref=${hint}></div>
      ${busy && html`<div class="pull busy">Refreshing…</div>`}
      ${children}
    </main>`;
}

// Placeholder rows while a list loads.
const Skeleton = ({ n = 8 }) => html`
  <ul class="skel" aria-label="Loading">${Array.from({ length: n }, () => html`<li><i></i><i></i></li>`)}</ul>`;

// Textarea that grows with its content. Cmd/Ctrl+Enter submits.
function Grow({ value, onInput, onSubmit, placeholder, tall, label }) {
  const el = useRef();
  useEffect(() => {
    el.current.style.height = 'auto';
    el.current.style.height = Math.min(el.current.scrollHeight, tall ? 260 : 160) + 'px';
  }, [value]);
  return html`<textarea ref=${el} class="input" rows=${tall ? 3 : 1} value=${value}
    placeholder=${placeholder} aria-label=${label} onInput=${(e) => onInput(e.target.value)}
    onKeyDown=${(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && onSubmit()}></textarea>`;
}

// Hold to talk. Sends the recording to /api/voice and hands back the text.
function Mic({ onText }) {
  const [state, setState] = useState('idle'); // idle | rec | busy
  const cur = useRef({});

  const down = async (e) => {
    e.preventDefault();
    if (state !== 'idle') return;
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Voice recording is not supported here');
    const s = (cur.current = { held: true });
    setState('rec');
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('idle');
      return toast('Microphone permission denied');
    }
    const release = () => s.stream.getTracks().forEach((t) => t.stop());
    if (!s.held) {
      // Finger lifted while iOS was asking for permission.
      release();
      setState('idle');
      return toast('Hold the mic button to talk');
    }
    const type = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
    const chunks = [];
    const started = Date.now();
    s.rec = new MediaRecorder(s.stream, { mimeType: type });
    s.rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    s.rec.onstop = async () => {
      release();
      if (Date.now() - started < 400) {
        setState('idle');
        return toast('Hold the mic button to talk');
      }
      setState('busy');
      try {
        const { text } = await api('/api/voice', { method: 'POST', body: new Blob(chunks, { type }), type });
        if (text) onText(text);
      } catch (err) {
        toast(err.status === 503 ? 'Voice needs GROQ_API_KEY on the Mac' : 'Voice failed: ' + err.message);
      }
      setState('idle');
    };
    s.rec.start();
  };
  const up = () => {
    const s = cur.current;
    s.held = false;
    if (s.rec && s.rec.state === 'recording') s.rec.stop();
  };

  return html`
    <button type="button" class=${'btn mic ' + state} aria-label="Hold to talk" disabled=${state === 'busy'}
      onPointerDown=${down} onPointerUp=${up} onPointerCancel=${up} onPointerLeave=${up}
      onContextMenu=${(e) => e.preventDefault()}>
      <${Icon} name="mic" />${state === 'rec' ? 'Listening…' : state === 'busy' ? 'Transcribing…' : ''}
    </button>`;
}

const addText = (old, text) => (old.trim() ? old.trimEnd() + ' ' : '') + text;

// ---------- sheets ----------

// Bottom sheet. Closes on backdrop tap, Escape or a drag down. render(close) draws the content.
function Sheet({ label, onClose, render }) {
  const [closing, setClosing] = useState(false);
  const el = useRef();
  const drag = useRef({ dy: 0 });

  // Slide out, then unmount.
  const close = () => {
    if (!el.current) return;
    el.current.style.transition = '';
    el.current.style.transform = 'translateY(100%)';
    setClosing(true);
    setTimeout(onClose, 200);
  };
  useEffect(() => {
    // Keep focus inside the sheet: everything behind it is inert while it is open.
    const before = document.activeElement;
    const behind = [...el.current.parentNode.children].filter((n) => n !== el.current && !n.matches('.sheet-backdrop'));
    behind.forEach((n) => { n.inert = true; });
    el.current.focus();
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      behind.forEach((n) => { n.inert = false; });
      before.focus();
    };
  }, []);

  // Drag down to dismiss: far enough or a quick flick closes, anything else springs back.
  // A touch inside a list that has something to scroll scrolls it; it does not drag the sheet.
  const start = (e) => {
    const list = e.target.closest('.sheet-scroll');
    drag.current = { y: e.touches[0].clientY, at: Date.now(), dy: 0, off: !!list && list.scrollHeight > list.clientHeight };
  };
  const move = (e) => {
    const d = drag.current;
    if (!el.current || d.off) return; // closed while a finger was still down, or scrolling the list
    d.dy = Math.max(0, e.touches[0].clientY - d.y);
    el.current.style.transition = 'none';
    el.current.style.transform = `translateY(${d.dy}px)`;
  };
  const end = () => {
    const d = drag.current;
    if (d.dy > 90 || (d.dy > 12 && d.dy / (Date.now() - d.at) > 0.5)) return close();
    if (!el.current) return;
    el.current.style.transition = '';
    el.current.style.transform = '';
  };
  // A drag that ends on a button is not a tap.
  const click = (e) => {
    if (drag.current.dy < 8) return;
    e.preventDefault();
    e.stopPropagation();
  };

  return html`
    <div class=${'sheet-backdrop' + (closing ? ' closing' : '')} onClick=${close}></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${label} tabindex="-1" ref=${el}
      onTouchStart=${start} onTouchMove=${move} onTouchEnd=${end} onTouchCancel=${end} onClickCapture=${click}>
      <div class="grabber"></div>
      ${render(close)}
    </div>`;
}

// One row of a sheet list. The current one gets a tick.
const Choice = ({ title, meta, on, onClick }) => html`
  <li>
    <button class="account" aria-current=${on ? 'true' : null} onClick=${onClick}>
      <span class="row-text">
        <span class="row-title strong">${title}</span>
        ${meta && html`<span class="row-meta">${meta}</span>`}
      </span>
      ${on && html`<${Icon} name="tick" size=${20} />`}
    </button>
  </li>`;

function EffortSheet({ value, onPick, onClose }) {
  return html`
    <${Sheet} label="Effort" onClose=${onClose} render=${(close) => html`
      <h2>Effort</h2>
      <ul class="accounts">
        ${EFFORTS.map((e) => html`<${Choice} key=${e} title=${effortLabel(e)} on=${e === value} onClick=${() => { onPick(e); close(); }} />`)}
      </ul>`} />`;
}

// A question before something that cannot be taken back. danger = the action destroys something.
function Confirm({ title, text, action, danger, onConfirm, onClose }) {
  return html`
    <${Sheet} label=${title} onClose=${onClose} render=${(close) => html`
      <p class="confirm-title">${title}</p>
      ${text && html`<p class="hint">${text}</p>`}
      <button class=${'btn wide ' + (danger ? 'danger' : 'primary')} onClick=${() => { close(); onConfirm(); }}>${action}</button>
      <button class="btn wide ghost" onClick=${close}>Cancel</button>`} />`;
}

// The tab the session's agent is using. Refreshes every 5 s while the session runs.
function ScreenSheet({ id, running, onClose }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const made = useRef('');
  const gone = useRef(false); // the sheet closed
  const load = async () => {
    setBusy(true);
    try {
      const next = await screenshotUrl(id);
      if (gone.current) return URL.revokeObjectURL(next);
      URL.revokeObjectURL(made.current);
      made.current = next;
      setUrl(next);
      setNote('');
    } catch (err) {
      setNote(err.status === 404 ? 'No open tab for this session.' : err.status ? 'Could not load the screen.' : 'Mac unreachable — check Tailscale');
    }
    setBusy(false);
  };
  useEffect(() => {
    load();
    const timer = running && setInterval(() => document.hidden || load(), 5000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => {
    gone.current = true;
    URL.revokeObjectURL(made.current);
  }, []);
  return html`
    <${Sheet} label="Screen" onClose=${onClose} render=${() => html`
      <div class="sheet-head">
        <h2>Screen</h2>
        <button class="routine-retry" aria-label="Refresh" disabled=${busy} onClick=${load}><${Icon} name="retry" size=${18} /></button>
      </div>
      <div class="screen">
        ${note ? html`<p class="hint" role="status">${note}</p>`
          : url ? html`<img src=${url} alt="The tab this session is using" />`
          : html`<p class="hint">Loading…</p>`}
      </div>`} />`;
}

// The models the bridge knows for an account. Reloads when the account changes.
function useModels(account) {
  const [models, setModels] = useState({ default: '', models: [] });
  useEffect(() => {
    if (!account) return;
    api('/api/models?account=' + account).then(setModels, (err) => err.status && err.status !== 401 && toast(err.message));
  }, [account]);
  return models;
}

// Lists the account's models plus the custom ones typed here before (kept in localStorage per account).
function ModelSheet({ account, models, value, onPick, onClose }) {
  const key = 'aside-pocket-models-' + account;
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');
  const saved = JSON.parse(localStorage.getItem(key) || '[]');
  const current = value || models.default;
  const all = [...models.models,
    ...saved.filter((id) => !models.models.some((m) => m.id === id)).map((id) => ({ id, name: shortModel(id), group: 'Custom' }))];
  // The current pick first, the rest under their group in the order the bridge sends them.
  const rest = all.filter((m) => m.id !== current);
  const groups = [...new Set(rest.map((m) => m.group))];
  const row = (m, close) => html`
    <${Choice} key=${m.id} title=${m.name} on=${m.id === current}
      meta=${[m.name !== shortModel(m.id) && shortModel(m.id), m.id === models.default && 'Default'].filter(Boolean).join(' · ')}
      onClick=${() => { onPick(m.id); close(); }} />`;

  const add = (close) => {
    const m = custom.trim();
    if (!/^[^/\s]+\/\S+$/.test(m)) return setError('Write it as provider/modelId');
    localStorage.setItem(key, JSON.stringify([...new Set([...saved, m])]));
    onPick(m);
    close();
  };

  return html`
    <${Sheet} label="Model" onClose=${onClose} render=${(close) => html`
      <h2>Model</h2>
      <div class="sheet-scroll">
        ${current && html`
          <ul class="accounts">${row(all.find((m) => m.id === current) || { id: current, name: shortModel(current) }, close)}</ul>`}
        ${groups.map((g) => html`
          <div class="label provider">${g}</div>
          <ul class="accounts">${rest.filter((m) => m.group === g).map((m) => row(m, close))}</ul>`)}
      </div>
      <form class="field" onSubmit=${(e) => { e.preventDefault(); add(close); }}>
        <label class="label" for="custom-model">Custom</label>
        <input id="custom-model" type="text" placeholder="provider/modelId" autocapitalize="off" autocorrect="off"
          autocomplete="off" spellcheck=${false} enterkeyhint="done" aria-invalid=${!!error}
          value=${custom} onInput=${(e) => { setCustom(e.target.value); setError(''); }} />
        <button class="btn" disabled=${!custom.trim()}>Use</button>
        <p class="error" role="alert">${error}</p>
      </form>`} />`;
}

// ---------- pairing ----------

function Pairing({ onPaired }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (value) => {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      const { token } = await api('/api/pair', { method: 'POST', json: { code: value } });
      setToken(token);
      onPaired();
    } catch (err) {
      setError(err.status === 401 ? 'Wrong or expired code' : err.status ? err.message : 'Mac unreachable — check Tailscale');
      setBusy(false);
    }
  };
  const input = (e) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(value);
    if (value.length === 6) submit(value);
  };

  return html`
    <form class="pairing" onSubmit=${(e) => { e.preventDefault(); submit(code); }}>
      <img src="/icons/icon-192.png" width="64" height="64" alt="" />
      <h1>Aside Pocket</h1>
      <label for="code">Pairing code</label>
      <input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6"
        placeholder="000000" value=${code} onInput=${input} />
      <p class="error" role="alert">${error}</p>
      <button class="btn primary wide" disabled=${busy || code.length !== 6}>${busy ? 'Pairing…' : 'Pair'}</button>
      <p class="hint">Run <code>aside-pocket pair</code> on the Mac to get a code.</p>
    </form>`;
}

// ---------- inbox ----------

function Row({ s, onArchive }) {
  const el = useRef();
  const g = useRef(null);
  const moved = useRef(false);
  const [open, setOpen] = useState(false);

  const slide = (x, animate) => {
    // A live update can remove the row while a finger is still on it; the touch events keep coming.
    if (!el.current) return;
    el.current.style.transition = animate ? '' : 'none';
    el.current.style.transform = x ? `translateX(${x}px)` : '';
  };
  const start = (e) => {
    moved.current = false;
    g.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: open ? -88 : 0, dx: 0, horizontal: null };
  };
  const move = (e) => {
    const t = g.current;
    if (!t) return;
    const dx = e.touches[0].clientX - t.x;
    const dy = e.touches[0].clientY - t.y;
    if (t.horizontal === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      t.horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (!t.horizontal) return;
    moved.current = true;
    t.dx = Math.min(0, t.base + dx);
    slide(t.dx, false);
  };
  const end = () => {
    const t = g.current;
    g.current = null;
    if (!t || !t.horizontal || !el.current) return;
    if (t.dx < -el.current.offsetWidth * 0.55) return onArchive(s); // full swipe archives
    const stay = t.dx < -44;
    setOpen(stay);
    slide(stay ? -88 : 0, true);
  };
  const click = (e) => {
    if (!moved.current && !open) return;
    e.preventDefault();
    if (!moved.current) {
      setOpen(false);
      slide(0, true);
    }
  };

  const live = s.status === 'running' || s.status === 'waiting';
  const mark = live ? s.status : s.unread ? 'unread' : '';
  return html`
    <li class="row">
      <button class="swipe-action" tabindex=${open ? 0 : -1} onClick=${() => onArchive(s)}>
        <${Icon} name="archive" />Archive
      </button>
      <a class="row-main" ref=${el} href=${'#/s/' + s.id} onClick=${click}
        onTouchStart=${start} onTouchMove=${move} onTouchEnd=${end} onTouchCancel=${end}>
        <i class=${'mark ' + mark} aria-label=${s.unread ? 'Unread' : null}></i>
        <span class="row-text">
          <span class=${'row-title' + (s.unread || live ? ' strong' : '')}>${s.title || 'Untitled'}</span>
          <span class="row-meta">
${s.status !== 'done' && html`<span class=${s.status}>${STATUS[s.status]}</span> · `}${SOURCES[s.source] || 'Aside'}
          </span>
        </span>
        <time>${ago(s.updatedAt)}</time>
      </a>
    </li>`;
}

function Group({ title, list, onArchive, children }) {
  if (!list.length) return null;
  return html`
    <section class="group">
      ${title && html`<h2>${title}</h2>`}
      <ul class="list">${list.map((s) => html`<${Row} key=${s.id} s=${s} onArchive=${onArchive} />`)}</ul>
      ${children}
    </section>`;
}

const byUpdated = (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1);

// Sessions per project, most recently active project first, "No project" last.
function projectGroups(sessions, projects) {
  const groups = projects.map((p) => ({ id: p.id, name: p.name, list: sessions.filter((s) => s.projectId === p.id) }));
  const known = new Set(projects.map((p) => p.id));
  const none = { id: 'none', name: 'No project', list: sessions.filter((s) => !known.has(s.projectId)) };
  const latest = (g) => g.list[0] || { updatedAt: '' };
  return [...groups.sort((x, y) => byUpdated(latest(x), latest(y))), none];
}

function ProjectRow({ g }) {
  const unread = g.list.filter((s) => s.unread).length;
  const running = g.list.some((s) => s.status === 'running');
  return html`
    <li class="row">
      <a class="row-main" href=${'#/p/' + encodeURIComponent(g.id)}>
        <i class=${'mark ' + (running ? 'running' : unread ? 'unread' : '')}></i>
        <span class="row-text">
          <span class=${'row-title' + (running || unread ? ' strong' : '')}>${g.name}</span>
          <span class="row-meta">
            ${g.list.length} ${g.list.length === 1 ? 'session' : 'sessions'}${running && html` · <span class="running">Running</span>`}${unread ? html` · <span class="unread">${unread} unread</span>` : null}
          </span>
        </span>
        <time>${ago(g.list[0].updatedAt)}</time>
      </a>
    </li>`;
}

function Inbox({ st, sessions, projects, loaded, filter, setFilter, search, setSearch, onArchive, onRefresh }) {
  const [shown, setShown] = useState(50);
  const row = useRef();
  const field = useRef();
  const opener = useRef();
  // iOS opens the keyboard only when focus() runs inside the tap, so the row switches here, before the render.
  const openSearch = () => {
    row.current.classList.add('searching');
    field.current.focus();
    setSearch('');
  };
  const closeSearch = () => {
    row.current.classList.remove('searching');
    opener.current.focus();
    setSearch(null);
  };
  // search: null = closed. Every word typed must be in the title.
  const words = (search || '').toLowerCase().split(/\s+/).filter(Boolean);
  const found = words.length ? sessions.filter((s) => words.every((w) => (s.title || '').toLowerCase().includes(w))) : null;
  const unread = sessions.filter((s) => s.unread);
  const waiting = sessions.filter((s) => s.status === 'waiting');
  const running = sessions.filter((s) => s.status === 'running');
  const rest = sessions.filter((s) => s.status !== 'waiting' && s.status !== 'running');
  const done = filter === 'unread' ? unread.filter((s) => rest.includes(s)) : rest;
  const pill = (key, label, n) => html`
    <button class=${filter === key ? 'on' : ''} aria-pressed=${filter === key} onClick=${() => setFilter(key)}>
      <span>${label}${n ? html`<b>${n}</b>` : null}</span>
    </button>`;
  return html`
    <${Header} title="Inbox" st=${st} />
    <${Scroller} onRefresh=${onRefresh}>
      <div class=${'pills-row' + (search != null ? ' searching' : '')} ref=${row}>
        <div class="pills">${pill('all', 'All')}${pill('unread', 'Unread', unread.length)}${pill('projects', 'Projects')}</div>
        <button class="iconbtn" aria-label="Search sessions" ref=${opener} onClick=${openSearch}><${Icon} name="search" size=${20} /></button>
        <form class="search" role="search" onSubmit=${(e) => { e.preventDefault(); field.current.blur(); }}>
          <${Icon} name="search" size=${18} />
          <input ref=${field} type="text" aria-label="Search sessions" placeholder="Search sessions" enterkeyhint="search"
            autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck=${false} value=${search || ''}
            onInput=${(e) => setSearch(e.target.value)} onKeyDown=${(e) => e.key === 'Escape' && closeSearch()} />
          <button type="button" class="iconbtn" aria-label="Close search" onClick=${closeSearch}><${Icon} name="close" size=${20} /></button>
        </form>
      </div>
      <div class="stale-target">
        ${found ? html`
          <${Group} list=${found.slice(0, shown)} onArchive=${onArchive}>
            ${found.length > shown && html`
              <button class="btn wide ghost" onClick=${() => setShown(shown + 50)}>Show more (${found.length - shown})</button>`}
          <//>
          ${!found.length && html`<div class="empty"><p>No sessions match</p></div>`}`
        : filter === 'projects' ? html`
          <section class="group">
            <ul class="list">
              ${projectGroups(sessions, projects).filter((g) => g.list.length).map((g) => html`<${ProjectRow} key=${g.id} g=${g} />`)}
            </ul>
          </section>` : html`
          <${Group} title="Waiting for you" list=${waiting} onArchive=${onArchive} />
          <${Group} title="Running" list=${running} onArchive=${onArchive} />
          <${Group} title=${waiting.length || running.length ? 'Earlier' : ''} list=${done.slice(0, shown)} onArchive=${onArchive}>
            ${done.length > shown && html`
              <button class="btn wide ghost" onClick=${() => setShown(shown + 50)}>Show more (${done.length - shown})</button>`}
          <//>`}
        ${!found && loaded && filter === 'unread' && sessions.length > 0 && !unread.length && html`<div class="empty"><p>All caught up.</p></div>`}
        ${!found && loaded && !sessions.length && html`
          <div class="empty"><p>No sessions yet.</p><a class="btn primary" href="#/new">Start a task</a></div>`}
        ${!loaded && st.online && html`<${Skeleton} />`}
      </div>
    <//>`;
}

function Project({ id, st, sessions, projects, loaded, onArchive, onRefresh }) {
  const [shown, setShown] = useState(50);
  const g = projectGroups(sessions, projects).find((x) => x.id === id) || { name: 'Project', list: [] };
  return html`
    <${Header} title=${g.name} back="#/" st=${st} />
    <${Scroller} onRefresh=${onRefresh}>
      <div class="stale-target">
        <${Group} list=${g.list.slice(0, shown)} onArchive=${onArchive}>
          ${g.list.length > shown && html`
            <button class="btn wide ghost" onClick=${() => setShown(shown + 50)}>Show more (${g.list.length - shown})</button>`}
        <//>
        ${loaded && !g.list.length && html`<div class="empty"><p>No sessions in this project.</p></div>`}
        ${!loaded && st.online && html`<${Skeleton} />`}
      </div>
    <//>`;
}

// ---------- thread ----------

function Steps({ items }) {
  const [open, setOpen] = useState(false);
  const errors = items.filter((m) => m.tool && m.tool.isError).length;
  return html`
    <div class="steps">
      <button class=${'steps-toggle' + (open ? ' open' : '')} aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <${Icon} name="chevron" size=${16} />
        ${items.length} ${items.length === 1 ? 'step' : 'steps'}${errors ? ` · ${errors} failed` : ''}
      </button>
      ${open && html`
        <ol>${items.map((m) => {
          const tool = m.tool || {};
          const title = tool.title || m.text || '';
          return html`<li class=${tool.isError ? 'bad' : ''}><code>${tool.name || 'tool'}</code> ${title !== tool.name ? title : ''}</li>`;
        })}</ol>`}
    </div>`;
}

function Question({ question, busy, onReply }) {
  const q = readQuestion(question);
  return html`
    <div class="question">
      <div class="label">Waiting for you</div>
      ${q.text && html`<${Markdown} text=${q.text} />`}
      ${q.raw && html`<pre>${q.raw}</pre>`}
      <div class="replies">
        ${q.options.map((o) => html`<button class="btn" disabled=${busy} onClick=${() => onReply(o)}>${o}</button>`)}
        ${!q.options.length && html`
          <button class="btn primary" disabled=${busy} onClick=${() => onReply('Approve')}>Approve</button>
          <button class="btn" disabled=${busy} onClick=${() => onReply('Reject')}>Reject</button>`}
      </div>
    </div>`;
}

function Thread({ id, st, live, back, onArchive, onRead, onAccount }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const [screen, setScreen] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const limit = useRef(60); // how many of the latest messages to ask for
  const keep = useRef(null); // distance from the bottom to hold while earlier messages come in
  const scroll = useRef();
  const stick = useRef(true); // at the bottom: new content keeps it there
  const alive = useRef(true);

  const load = async () => {
    const asked = limit.current;
    try {
      const d = await api(`/api/sessions/${id}?limit=${asked}`);
      // "Load earlier" raised the limit while this was on its way: drop the shorter answer.
      if (!alive.current || asked !== limit.current) return;
      setData(d);
      setError('');
      onAccount(d.session.account);
      if (d.session.unread) {
        await api(`/api/sessions/${id}/read`, { method: 'POST' });
        onRead(id);
      }
    } catch (err) {
      if (alive.current && err.status) setError(err.message);
    }
  };

  const session = (data && data.session) || live || { id, title: '', status: '' };
  const status = session.status;
  const running = status === 'running';

  useEffect(() => {
    api(`/api/sessions/${id}/read`, { method: 'POST' }).then(() => onRead(id), () => {});
    return () => { alive.current = false; };
  }, []);
  // Reload when the stream reports a change to this session.
  useEffect(() => { load(); }, [live && live.updatedAt, live && live.status]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [running]);

  const loadEarlier = async () => {
    setEarlier(true);
    limit.current = Math.min(limit.current + 120, 600);
    keep.current = scroll.current.scrollHeight - scroll.current.scrollTop;
    await load();
    if (alive.current) setEarlier(false);
  };
  // The message that was at the top stays where it was.
  useLayoutEffect(() => {
    if (keep.current == null) return;
    scroll.current.scrollTop = scroll.current.scrollHeight - keep.current;
    keep.current = null;
  }, [data]);

  const messages = (data && data.messages) || [];
  // Before the browser reports the scroll: a layout shift must not count as leaving the bottom.
  useLayoutEffect(() => {
    if (scroll.current && stick.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length, data && data.answer, data && data.queued && data.queued.length, status]);

  // resume | steer | queue | stop
  const act = async (kind, prompt) => {
    if (busy) return;
    setBusy(true);
    stick.current = true;
    try {
      await api(`/api/sessions/${id}/${kind}`, { method: 'POST', json: kind === 'stop' ? undefined : { prompt } });
      if (kind !== 'stop') setText('');
      if (kind === 'resume') setData((d) => d && { ...d, question: null, session: { ...d.session, status: 'running' } });
      await load();
    } catch (err) {
      // Aside's words for a session that was archived
      toast(/pending purge/.test(err.message) ? 'This session is archived' : err.status ? err.message : 'Mac unreachable — check Tailscale');
    }
    setBusy(false);
  };
  const send = (kind) => text.trim() && act(kind, text.trim());
  const models = useModels(session.account);
  const changeModel = async (model) => {
    try {
      await api(`/api/sessions/${id}/model`, { method: 'POST', json: { model } });
      setData((d) => d && { ...d, model });
      toast('Model changes from the next message');
    } catch (err) {
      toast(err.status ? err.message : 'Mac unreachable — check Tailscale');
    }
  };

  // Collapse runs of tool messages into one "N steps" row.
  const parts = [];
  for (const m of messages) {
    const last = parts[parts.length - 1];
    if (m.role !== 'tool') parts.push(m);
    else if (last && last.steps) last.steps.push(m);
    else parts.push({ steps: [m] });
  }
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const answer = data && data.answer && (!lastAssistant || lastAssistant.text.trim() !== data.answer.trim()) ? data.answer : '';

  return html`
    <${Header} title=${session.title || (data ? 'Untitled' : '')} back=${back} st=${st}>
      <button class="iconbtn" aria-label="Session menu" aria-expanded=${menu} onClick=${() => setMenu(!menu)}>
        <${Icon} name="more" />
      </button>
      ${menu && html`
        <div class="menu-backdrop" onClick=${() => setMenu(false)}></div>
        <div class="menu">
          <button onClick=${() => { setMenu(false); setScreen(true); }}><${Icon} name="screen" size=${18} />View screen</button>
          <button class="danger" onClick=${() => onArchive(session, true)}><${Icon} name="archive" size=${18} />Archive</button>
        </div>`}
    <//>
    <main class="scroll thread" ref=${scroll}
      onScroll=${(e) => { stick.current = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 60; }}>
      <div class="stale-target">
        ${status && status !== 'done' && html`<div class=${'status ' + status}><i class=${'dot ' + status}></i>${STATUS[status] || status}</div>`}
        ${!data && !error && st.online && html`<${Skeleton} n=${4} />`}
        ${error && html`<div class="errorbox">${error}</div>`}
        ${data && data.more && limit.current < 600 && html`
          <button class="quiet" disabled=${earlier} onClick=${loadEarlier}>${earlier ? 'Loading…' : 'Load earlier'}</button>`}
        ${parts.map((m) => m.steps ? html`<${Steps} key=${m.steps[0].ts} items=${m.steps} />`
          : m.role === 'user' ? html`<div class="bubble" key=${m.ts}>${m.text}</div>`
          : html`<${Markdown} key=${m.ts} text=${m.text} />`)}
        ${answer && html`<${Markdown} text=${answer} />`}
        ${data && data.error && html`<div class="errorbox">${data.error}</div>`}
        ${data && (data.queued || []).map((q) => html`<div class="bubble queued"><span>Queued</span>${q}</div>`)}
        ${running && html`<div class="working"><i></i><i></i><i></i></div>`}
      </div>
    </main>
    <footer class="composer">
      ${status === 'waiting' && data && html`
        <${Question} question=${data.question} busy=${busy} onReply=${(reply) => act('resume', reply)} />`}
      <div class="box">
        <${Grow} value=${text} onInput=${setText} onSubmit=${() => send(running ? 'steer' : 'resume')} label="Message"
          placeholder=${running ? 'Steer or queue a follow-up' : status === 'waiting' ? 'Or type your own reply' : 'Reply'} />
        <div class="actions">
          <${Mic} onText=${(t) => setText((old) => addText(old, t))} />
          ${running && html`
            <button class="chip danger" disabled=${busy} onClick=${() => act('stop')}><${Icon} name="stop" size=${16} />Stop</button>`}
          ${data && !running && html`
            <button class="chip" aria-label=${'Model: ' + (modelName(data.model, models) || 'default')} onClick=${() => setPicking(true)}>
              <span>${modelName(data.model, models) || 'Model'}</span>
            </button>`}
          ${running && text.trim() && html`<button class="chip" disabled=${busy} onClick=${() => send('queue')}>Queue</button>`}
          <button class="send" aria-label=${running ? 'Steer' : 'Send'} disabled=${busy || !text.trim()}
            onClick=${() => send(running ? 'steer' : 'resume')}><${Icon} name="up" size=${20} /></button>
        </div>
      </div>
    </footer>
    ${picking && html`
      <${ModelSheet} account=${session.account} models=${models} value=${data.model} onPick=${changeModel} onClose=${() => setPicking(false)} />`}
    ${screen && html`<${ScreenSheet} id=${id} running=${running} onClose=${() => setScreen(false)} />`}`;
}

// ---------- new task ----------

function NewTask({ st, account, draft, setDraft }) {
  const [effort, setEffort] = useState('medium');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(''); // '' | 'model' | 'effort'
  // The last model picked for this account. Empty = never picked: send none and Aside uses its default.
  const modelKey = 'aside-pocket-model-' + account;
  const [model, setModel] = useState(localStorage.getItem(modelKey) || '');
  const models = useModels(account);
  const pickModel = (m) => {
    localStorage.setItem(modelKey, m);
    setModel(m);
  };
  // Prompts saved to reuse, newest first, 20 at most, per account.
  const templatesKey = 'aside-pocket-templates-' + account;
  const [templates, setTemplates] = useState(JSON.parse(localStorage.getItem(templatesKey) || '[]'));
  const saveTemplates = (list) => {
    localStorage.setItem(templatesKey, JSON.stringify(list));
    setTemplates(list);
  };
  const text = draft.trim();

  const start = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    try {
      const { id } = await api('/api/sessions', { method: 'POST', json: { prompt: draft.trim(), effort, account, model: model || undefined } });
      setDraft('');
      location.hash = '#/s/' + id;
    } catch (err) {
      toast(err.status ? err.message : 'Mac unreachable — check Tailscale');
      setBusy(false);
    }
  };

  return html`
    <${Header} title="New task" back="#/" st=${st} />
    <main class=${'scroll' + (templates.length ? '' : ' newtask')}>
      ${templates.length > 0 && html`
        <section class="group">
          <h2>Templates</h2>
          <ul class="routines">
            ${templates.map((t) => html`
              <li class="routine" key=${t}>
                <button class="routine-main" onClick=${() => setDraft(t)}><span class="row-title">${t.split('\n')[0]}</span></button>
                <button class="iconbtn" aria-label="Remove template" onClick=${() => saveTemplates(templates.filter((x) => x !== t))}>
                  <${Icon} name="close" size=${20} />
                </button>
              </li>`)}
          </ul>
        </section>`}
      <div class="empty">
        <p class="hint">Runs in Aside on your Mac${st.switcher ? ` as ${st.switcher.name}` : ''} with Guard permission.</p>
        ${text && !templates.includes(text) && html`
          <button class="quiet" onClick=${() => { saveTemplates([text, ...templates].slice(0, 20)); toast('Template saved'); }}>Save as template</button>`}
      </div>
    </main>
    <footer class="composer">
      <div class="box">
        <${Grow} tall value=${draft} onInput=${setDraft} onSubmit=${start} label="Task" placeholder="Describe the task" />
        <div class="actions">
          <${Mic} onText=${(t) => setDraft(addText(draft, t))} />
          <button class="chip" aria-label=${'Model: ' + (modelName(model || models.default, models) || 'default')} onClick=${() => setSheet('model')}>
            <span>${modelName(model || models.default, models) || 'Model'}</span>
          </button>
          <button class="chip" aria-label=${'Effort: ' + effort} onClick=${() => setSheet('effort')}>
            ${effortLabel(effort)}
          </button>
          <button class="send start" aria-label="Start" disabled=${busy || !draft.trim()} onClick=${start}>
            <${Icon} name="up" size=${20} />
          </button>
        </div>
      </div>
    </footer>
    ${sheet === 'model' && html`
      <${ModelSheet} account=${account} models=${models} value=${model} onPick=${pickModel} onClose=${() => setSheet('')} />`}
    ${sheet === 'effort' && html`<${EffortSheet} value=${effort} onPick=${setEffort} onClose=${() => setSheet('')} />`}`;
}

// ---------- approvals ----------

function Approval({ s, who, onRefresh }) {
  const [question, setQuestion] = useState(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/sessions/' + s.id).then((d) => setQuestion(d.question), () => setQuestion(null));
  }, [s.updatedAt]);

  const reply = async (prompt) => {
    setBusy(true);
    try {
      await api(`/api/sessions/${s.id}/resume`, { method: 'POST', json: { prompt } });
      await onRefresh();
    } catch (err) {
      toast(err.status ? err.message : 'Mac unreachable — check Tailscale');
    }
    setBusy(false);
  };
  const q = readQuestion(question);
  return html`
    <li class="card approval">
      ${who && html`<div class="label">${who}</div>`}
      <a class="approval-head" href=${'#/s/' + s.id}>
        <span class="row-title strong">${s.title || 'Untitled'}</span><time>${ago(s.updatedAt)}</time>
        <${Icon} name="chevron" size=${18} />
      </a>
      ${question === undefined ? html`<${Skeleton} n=${1} />` : html`<p class="preview">${q.text ? inline(q.text) : q.raw || 'Needs your answer.'}</p>`}
      <div class="replies">
        ${q.options.map((o) => html`<button class="btn" disabled=${busy} onClick=${() => reply(o)}>${o}</button>`)}
        ${!q.options.length && html`
          <button class="btn primary" disabled=${busy} onClick=${() => reply('Approve')}>Approve</button>
          <button class="btn" disabled=${busy} onClick=${() => reply('Reject')}>Reject</button>`}
        <a class="btn ghost" href=${'#/s/' + s.id}>Open</a>
      </div>
    </li>`;
}

function Approvals({ st, sessions, who, onRefresh }) {
  const waiting = sessions.filter((s) => s.status === 'waiting');
  return html`
    <${Header} title="Approvals" st=${st} />
    <${Scroller} onRefresh=${onRefresh}>
      <ul class="stale-target cards">${waiting.map((s) => html`<${Approval} key=${s.id} s=${s} who=${who(s.account)} onRefresh=${onRefresh} />`)}</ul>
      ${!waiting.length && html`
        <div class="empty">
          <p>Nothing is waiting for you.</p>
          <p class="hint">Only sessions started in Aside itself can stop and wait for an answer. Tasks started from here run under Guard permission and do not ask.</p>
        </div>`}
    <//>`;
}

// ---------- routines ----------

function Routines({ st, account }) {
  const [routines, setRoutines] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('/api/routines?account=' + account).then(
    (d) => { setRoutines(d.routines); setError(''); },
    (err) => setError(err.status ? err.message : ''));
  useEffect(() => { if (account) load(); }, [st.online]);

  // Retry = continue the failed run in its own session, so it keeps the routine's context and settings.
  // The bridge allows it only when health.features.routineRetry is true.
  const canRetry = !!(st.health && st.health.features && st.health.features.routineRetry);
  const [busy, setBusy] = useState('');
  const [asking, setAsking] = useState(null); // the routine the confirm sheet is about
  const retry = async (r) => {
    setBusy(r.id);
    try {
      await api(`/api/sessions/${r.lastRunSessionId}/resume`, {
        method: 'POST', json: { prompt: 'The previous run of this routine failed. Run it again now.' },
      });
      location.hash = '#/s/' + r.lastRunSessionId;
    } catch (err) {
      toast(err.status ? err.message : 'Mac unreachable — check Tailscale');
    }
    setBusy('');
  };

  return html`
    <${Header} title="Routines" st=${st} />
    <${Scroller} onRefresh=${load}>
      ${error && html`<div class="errorbox">${error}</div>`}
      <ul class="stale-target routines">
        ${(routines || []).map((r) => {
          const failed = ['errored', 'error', 'failed'].includes(r.lastRunStatus);
          const tag = r.lastRunSessionId ? 'a' : 'div';
          return html`
            <li class="routine" key=${r.id}>
              <${tag} class="routine-main" href=${r.lastRunSessionId ? '#/s/' + r.lastRunSessionId : null}>
                <p class="routine-name">${r.name || 'Untitled'}</p>
                <p class="row-meta">
                  ${schedule(r.rrule)}${r.status === 'active' || !r.status ? '' : ' · ' + cap(r.status)}${r.nextRunAt ? ' · Next ' + when(r.nextRunAt) : ''}
                </p>
                ${failed && html`<p class="row-meta"><span class="failed">Last run failed</span>${r.lastRunError ? ' · ' + r.lastRunError : ''}</p>`}
              <//>
              ${canRetry && failed && r.lastRunSessionId && html`
                <button class="routine-retry" aria-label="Retry" disabled=${busy === r.id} onClick=${() => setAsking(r)}><${Icon} name="retry" size=${18} /></button>`}
            </li>`;
        })}
      </ul>
      ${routines && !routines.length && html`
        <div class="empty"><p>No routines.</p><p class="hint">Routines are created in Aside on the Mac.${canRetry ? ' A failed run can be retried from here.' : ''}</p></div>`}
      ${!routines && !error && st.online && html`<${Skeleton} n=${5} />`}
    <//>
    ${asking && html`
      <${Confirm} title=${`Run “${asking.name || 'Untitled'}” again?`} action="Run again"
        text=${`Continues the failed run in its own session with ${PERMISSIONS[asking.permissionMode] ? PERMISSIONS[asking.permissionMode] + ' permission' : 'that routine’s permissions'}.`}
        onConfirm=${() => retry(asking)} onClose=${() => setAsking(null)} />`}`;
}

// ---------- memory ----------

// mem = { q, results } lives in App so the results are still there after reading a file.
function Memory({ st, account, mem, setMem }) {
  const [q, setQ] = useState(mem.q);
  const [busy, setBusy] = useState(false);
  const field = useRef();
  const search = async (e) => {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    field.current.blur();
    setBusy(true);
    try {
      const d = await api(`/api/memory?account=${account}&q=${encodeURIComponent(text)}`);
      setMem({ q: text, results: d.results });
    } catch (err) {
      toast(err.status ? err.message : 'Mac unreachable — check Tailscale');
    }
    setBusy(false);
  };
  return html`
    <${Header} title="Memory" back="#/" st=${st} />
    <main class="scroll">
      <form class="search" role="search" onSubmit=${search}>
        <${Icon} name="search" size=${18} />
        <input ref=${field} type="text" aria-label="Search memory" placeholder="Search memory" enterkeyhint="search"
          autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck=${false} value=${q} onInput=${(e) => setQ(e.target.value)} />
      </form>
      <div class="stale-target">
        ${busy ? html`<${Skeleton} n=${4} />` : !mem.results ? html`
          <div class="empty"><p class="hint">Search what Aside remembers about you.</p></div>` : html`
          <section class="group">
            <ul class="list">
              ${mem.results.map((r) => html`
                <li class="row" key=${r.path}>
                  <a class="row-main" href=${'#/memory/' + encodeURIComponent(r.path)}>
                    <i class="mark"></i>
                    <span class="row-text">
                      <span class="row-title">${r.title || r.path.split('/').pop()}</span>
                      <span class="row-meta excerpt">${String(r.excerpt || '').replace(/\s+/g, ' ')}</span>
                    </span>
                  </a>
                </li>`)}
            </ul>
          </section>
          ${!mem.results.length && html`<div class="empty"><p>Nothing found</p></div>`}`}
      </div>
    </main>`;
}

function MemoryFile({ st, account, path }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!account) return;
    api(`/api/memory/file?account=${account}&path=${encodeURIComponent(path)}`).then(
      (d) => setText(d.text),
      (err) => setError(err.status ? err.message : 'Mac unreachable — check Tailscale'));
  }, [account]);
  return html`
    <${Header} title=${path.split('/').pop()} back="#/memory" st=${st} />
    <main class="scroll thread">
      <div class="stale-target">
        ${text == null && !error && st.online && html`<${Skeleton} n=${4} />`}
        ${error && html`<div class="errorbox">${error}</div>`}
        ${text != null && html`<${Markdown} text=${text} />`}
      </div>
    </main>`;
}

// ---------- settings and profiles ----------

// onClose(next): next is 'unpair' when the sheet closed to ask about unpairing.
function Settings({ health, onClose }) {
  const next = useRef('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (err) {
      setNote(err.status ? err.message : err.message || 'Mac unreachable — check Tailscale');
    }
    setBusy(false);
  };
  const enable = () => run(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return 'Notifications are not available here. On iPhone, open this from the Home Screen icon.';
    }
    if ((await Notification.requestPermission()) !== 'granted') return 'Notification permission was not granted.';
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('/api/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON() } });
    return 'Notifications are on for this device.';
  });
  const test = () => run(async () => {
    const { results } = await api('/api/push/test', { method: 'POST' });
    if (!results.length) return 'No device is subscribed yet. Enable notifications first.';
    return 'Test sent: ' + results.map((r) => r.status).join(', ');
  });

  const versions = [health && health.version && 'Aside Pocket ' + health.version,
    health && health.aside && health.aside.version && 'Aside ' + health.aside.version].filter(Boolean).join(' · ');
  const copy = () => navigator.clipboard.writeText(getToken()).then(() => toast('Token copied'), () => toast('Could not copy the token'));

  return html`
    <${Sheet} label="Settings" onClose=${() => onClose(next.current)} render=${(close) => html`
      <div class="sheet-scroll full">
        <ul class="accounts">
          <li>
            <a class="account" href="#/memory" onClick=${close}>
              <span class="row-text">
                <span class="row-title strong">Memory</span>
                <span class="row-meta">Search what Aside remembers about you</span>
              </span>
              <${Icon} name="chevron" size=${18} />
            </a>
          </li>
        </ul>
        <h2>Notifications</h2>
        <p class="hint">Get a push when a session finishes, fails or waits for you. On iPhone this only works after Share → Add to Home Screen, opened from that icon.</p>
        <button class="btn primary wide" disabled=${busy} onClick=${enable}>Enable notifications</button>
        <button class="btn wide" disabled=${busy} onClick=${test}>Send test</button>
        <p class="note" role="status">${note}</p>
        <h2>Share sheet shortcut</h2>
        <p class="hint">Send text or links from other apps to Aside with an iOS Shortcut. Setup steps are in the README.</p>
        <button class="btn wide" onClick=${copy}>Copy token</button>
        <h2>This device</h2>
        <button class="btn danger wide" onClick=${() => { next.current = 'unpair'; close(); }}>Unpair</button>
        ${versions && html`<p class="hint">${versions}</p>`}
      </div>`} />`;
}

// Two accounts can share a name; then the email tells them apart.
const accountName = (a, accounts) =>
  a.email && accounts.filter((x) => x.name === a.name).length > 1 ? a.email.split('@')[0] : a.name;

function Accounts({ accounts, current, sessions, onPick, onClose }) {
  return html`
    <${Sheet} label="Profiles" onClose=${onClose} render=${(close) => html`
      <h2>Profile</h2>
      <ul class="accounts">
        ${accounts.map((a) => {
          const list = sessions.filter((s) => s.account === a.id);
          const unread = list.filter((s) => s.unread).length;
          const running = list.some((s) => s.status === 'running');
          return html`
            <li key=${a.id}>
              <button class="account" disabled=${!a.connected} aria-current=${a.id === current ? 'true' : null}
                onClick=${() => { onPick(a.id); close(); }}>
                <i class=${'mark ' + (running ? 'running' : unread ? 'unread' : '')}></i>
                <span class="row-text">
                  <span class="row-title strong">${a.name}</span>
                  <span class="row-meta">${a.connected ? a.email : 'Profile not open on the Mac'}</span>
                  ${!a.connected && html`<span class="row-meta">${a.email}</span>`}
                </span>
                ${unread ? html`<span class="row-meta"><span class="unread">${unread} unread</span></span>` : null}
                ${a.id === current && html`<${Icon} name="tick" size=${20} />`}
              </button>
            </li>`;
        })}
      </ul>`} />`;
}

// ---------- app ----------

// Floating capsule. Scrolling a list down shrinks it to the current tab and the + button;
// scrolling up a little, reaching the top or tapping it brings it back.
function TabBar({ route, waiting, onSettings }) {
  const [mini, setMini] = useState(false);
  useEffect(() => {
    setMini(false);
    let last = 0;
    let low = 0; // the lowest point reached before scrolling back up
    const onScroll = (e) => {
      const el = e.target;
      if (!el.matches || !el.matches('.scroll')) return;
      const y = Math.max(0, Math.min(el.scrollTop, el.scrollHeight - el.clientHeight));
      if (y > last) {
        low = y;
        if (y > 24) setMini(true);
      } else if (y <= 0 || low - y > 24) setMini(false);
      last = y;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [route]);

  const tab = (href, icon, label, badge) => html`
    <a href=${href} class=${'tab' + (route === href ? ' on' : '')} aria-current=${route === href ? 'page' : null}>
      <span class="tab-icon"><${Icon} name=${icon} />${badge ? html`<b class="badge">${badge}</b>` : null}</span>
      <span class="tab-label">${label}</span>
    </a>`;
  return html`
    <nav class=${'tabbar' + (mini ? ' mini' : '')} aria-label="Main" onClick=${() => setMini(false)}>
      ${tab(route.startsWith('#/p/') ? route : '#/', 'inbox', 'Inbox')}
      ${tab('#/approvals', 'check', 'Approvals', waiting)}
      <a href="#/new" class="tab new" aria-label="New task"><span><${Icon} name="plus" size=${26} /></span></a>
      ${tab('#/routines', 'clock', 'Routines')}
      <button class="tab" onClick=${onSettings}><span class="tab-icon"><${Icon} name="gear" /></span><span class="tab-label">Settings</span></button>
    </nav>`;
}

const ACCOUNT_KEY = 'aside-pocket-account';
// Inbox and tabs are 0, a project, new task or memory search is 1, a thread or memory file is 2. Going deeper slides one way, back the other.
const depth = (route) => (route.startsWith('#/s/') || route.startsWith('#/memory/') ? 2
  : route.startsWith('#/p/') || route === '#/new' || route === '#/memory' ? 1 : 0);

function App() {
  const [paired, setPaired] = useState(!!getToken());
  // back = where the thread's back button goes: the list the thread was opened from.
  const [nav, setNav] = useState({ route: location.hash || '#/', dir: '', back: '#/' });
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [picked, setPicked] = useState(localStorage.getItem(ACCOUNT_KEY));
  const [projects, setProjects] = useState({ account: '', list: [] });
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState(null); // inbox search text, null = closed
  const [mem, setMem] = useState({ q: '', results: null }); // memory search
  const [health, setHealth] = useState(null);
  const [online, setOnline] = useState(true);
  const [sheet, setSheet] = useState(''); // '' | 'settings' | 'accounts' | 'unpair'
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');

  hooks.unauthorized = () => setPaired(false);
  toast = (text) => {
    setMessage(text);
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => setMessage(''), 3500);
  };

  // The current account: the one picked, or the first connected one.
  const current = accounts.find((a) => a.id === picked && a.connected) || accounts.find((a) => a.connected);
  const account = current && current.id;

  const refresh = async () => {
    try {
      const [list, h, acc] = await Promise.all([
        api('/api/sessions?filter=all&limit=2000'), api('/api/health'), api('/api/accounts')]);
      setSessions(list.sessions);
      setHealth(h);
      setAccounts(acc.accounts);
      setLoaded(true);
      setOnline(true);
    } catch (err) {
      if (!err.status) setOnline(false);
      else if (err.status !== 401) toast(err.message);
    }
  };

  useEffect(() => {
    const onHash = () => setNav((old) => {
      const route = location.hash || '#/';
      const d = depth(route) - depth(old.route);
      const back = !route.startsWith('#/s/') ? '#/' : old.route.startsWith('#/s/') ? old.back : old.route === '#/new' ? '#/' : old.route;
      return { route, dir: d > 0 ? 'fwd' : d < 0 ? 'back' : '', back };
    });
    const onMessage = (e) => { if (e.data && e.data.open) location.hash = e.data.open.slice(1); };
    // Keep the layout above the iOS keyboard.
    const vv = window.visualViewport;
    // iOS also scrolls the page to show the focused field, so follow both the size and the offset.
    const onViewport = () => {
      const root = document.documentElement;
      root.style.setProperty('--vh', vv.height + 'px');
      root.style.setProperty('--vt', vv.offsetTop + 'px');
      root.classList.toggle('kb', window.innerHeight - vv.height > 120);
    };
    window.addEventListener('hashchange', onHash);
    if (vv) {
      vv.addEventListener('resize', onViewport);
      vv.addEventListener('scroll', onViewport);
    }
    if ('serviceWorker' in navigator) {
      // A new service worker means new files: check when the app comes back, reload when one takes over.
      const hadWorker = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update());
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => hadWorker && location.reload());
      navigator.serviceWorker.addEventListener('message', onMessage);
    }
  }, []);

  useEffect(() => {
    if (!paired) return;
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    const close = openStream({
      onOpen: refresh,
      onClose: () => setOnline(false),
      onEvent: (event, data) => {
        if (event === 'health') setHealth(data);
        if (event !== 'sessions') return;
        const changed = data.changed || [];
        const gone = new Set([...(data.removed || []), ...changed.map((s) => s.id)]);
        if (gone.size) setSessions((old) => [...changed, ...old.filter((s) => !gone.has(s.id))].sort(byUpdated));
      },
    });
    return () => {
      close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [paired]);

  // A failed refresh marks the app offline while the stream may still be alive: keep trying until one works.
  useEffect(() => {
    if (!paired || online) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [paired, online]);

  // Project ids are only unique within an account, so the list remembers whose it is.
  useEffect(() => {
    if (!account || !online) return;
    api('/api/projects?account=' + account).then(
      (d) => setProjects({ account, list: d.projects }),
      (err) => err.status && err.status !== 401 && toast(err.message));
  }, [account, online]);

  if (!paired) return html`<div class="app"><${Pairing} onPaired=${() => setPaired(true)} /></div>`;

  const { route } = nav;
  const archive = async (s, goBack) => {
    try {
      await api(`/api/sessions/${s.id}/archive`, { method: 'POST' });
      setSessions((old) => old.filter((x) => x.id !== s.id));
      if (goBack) location.hash = nav.back;
    } catch (err) {
      toast(err.status ? err.message : 'Mac unreachable — check Tailscale');
    }
  };
  const markRead = (id) => setSessions((old) => old.map((s) => (s.id === id ? { ...s, unread: false } : s)));
  const pick = (id) => {
    localStorage.setItem(ACCOUNT_KEY, id);
    setPicked(id);
    setMem({ q: '', results: null });
  };
  // From the switcher. A project screen belongs to the old account, so leave it.
  const switchTo = (id) => {
    pick(id);
    if (route.startsWith('#/p/')) location.hash = '#/';
  };
  // A thread opened from a push or a link may belong to another account: follow it.
  const follow = (id) => {
    if (id === account) return;
    pick(id);
    setNav((old) => ({ ...old, back: '#/' }));
  };
  const unpair = () => {
    setToken(null);
    setSheet('');
    setSessions([]);
    setAccounts([]);
    setLoaded(false);
    setPaired(false);
  };

  const who = (id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? accountName(a, accounts) : '';
  };
  const several = accounts.filter((a) => a.connected).length > 1;
  const switcher = several && {
    name: who(account),
    alert: sessions.some((s) => s.account !== account && (s.unread || s.status === 'running' || s.status === 'waiting')),
    open: () => setSheet('accounts'),
  };
  const st = { online, health, switcher };
  const mine = sessions.filter((s) => s.account === account);
  const mineProjects = projects.account === account ? projects.list : [];
  const threadId = route.startsWith('#/s/') ? decodeURIComponent(route.slice(4)) : null;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;

  let view;
  if (threadId) {
    view = html`<${Thread} key=${threadId} id=${threadId} st=${st} live=${sessions.find((s) => s.id === threadId)}
      back=${nav.back} onArchive=${archive} onRead=${markRead} onAccount=${follow} />`;
  } else if (route === '#/new') view = html`<${NewTask} key=${account} st=${st} account=${account} draft=${draft} setDraft=${setDraft} />`;
  else if (route === '#/approvals') {
    view = html`<${Approvals} st=${st} sessions=${sessions} who=${(id) => several && who(id)} onRefresh=${refresh} />`;
  } else if (route === '#/routines') view = html`<${Routines} key=${account} st=${st} account=${account} />`;
  else if (route === '#/memory') view = html`<${Memory} key=${account} st=${st} account=${account} mem=${mem} setMem=${setMem} />`;
  else if (route.startsWith('#/memory/')) {
    view = html`<${MemoryFile} key=${route} st=${st} account=${account} path=${decodeURIComponent(route.slice(9))} />`;
  } else if (route.startsWith('#/p/')) {
    view = html`<${Project} key=${route} id=${decodeURIComponent(route.slice(4))} st=${st} sessions=${mine}
      projects=${mineProjects} loaded=${loaded} onArchive=${archive} onRefresh=${refresh} />`;
  } else {
    view = html`<${Inbox} st=${st} sessions=${mine} projects=${mineProjects} loaded=${loaded}
      filter=${filter} setFilter=${setFilter} search=${search} setSearch=${setSearch} onArchive=${archive} onRefresh=${refresh} />`;
  }

  return html`
    <div class=${'app ' + nav.dir + (online ? '' : ' stale')}>
      ${view}
      ${depth(route) === 0 || route.startsWith('#/p/') ? html`
        <${TabBar} route=${route} waiting=${waiting} onSettings=${() => setSheet('settings')} />` : null}
      ${sheet === 'settings' && html`<${Settings} health=${health} onClose=${setSheet} />`}
      ${sheet === 'unpair' && html`
        <${Confirm} title="Unpair this device?" text="You will need a new pairing code from the Mac to use it again."
          action="Unpair" danger onConfirm=${unpair} onClose=${() => setSheet('')} />`}
      ${sheet === 'accounts' && html`
        <${Accounts} accounts=${accounts} current=${account} sessions=${sessions} onPick=${switchTo} onClose=${() => setSheet('')} />`}
      ${message && html`<div class="toast" role="status">${message}</div>`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
