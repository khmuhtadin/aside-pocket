// Talks to the bridge. See docs/api.md.
const KEY = 'aside-pocket-token';

export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

// app.js sets hooks.unauthorized to show the pairing screen.
export const hooks = { unauthorized() {} };

function unpaired() {
  setToken(null);
  hooks.unauthorized();
}

// api('/api/x', { method, json, body, type }). Throws Error with .status (undefined = network down).
export async function api(path, { method = 'GET', json, body, type } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (type) {
    headers['Content-Type'] = type;
  }
  const res = await fetch(path, { method, headers, body });
  if (res.status === 401 && path !== '/api/pair') unpaired();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Something the bridge serves behind the token -> object URL for <img>. Throws Error with .status.
async function blobUrl(path) {
  const res = await fetch(path, { headers: { Authorization: 'Bearer ' + getToken() } });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return URL.createObjectURL(await res.blob());
}
export const imageUrl = (path) => blobUrl('/api/file?path=' + encodeURIComponent(path));
export const screenshotUrl = (id) => blobUrl(`/api/sessions/${id}/screenshot`);

// SSE over fetch so we can send the Authorization header. Reconnects with backoff.
// Returns a function that closes the stream.
export function openStream({ onEvent, onOpen, onClose }) {
  let stopped = false;
  let ctrl;
  let delay = 1000;

  async function run() {
    while (!stopped) {
      ctrl = new AbortController();
      let stall;
      try {
        const res = await fetch('/api/stream', {
          headers: { Authorization: 'Bearer ' + getToken(), Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (res.status === 401) return unpaired();
        if (!res.ok) throw new Error('HTTP ' + res.status);
        delay = 1000;
        onOpen();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          // The bridge pings every 20 s. Silence for 45 s means the connection is dead.
          clearTimeout(stall);
          stall = setTimeout(() => ctrl.abort(), 45000);
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            onEvent(event, parsed);
          }
        }
      } catch {
        // network error or abort: fall through to reconnect
      }
      clearTimeout(stall);
      if (stopped) return;
      onClose();
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }

  run();
  return () => {
    stopped = true;
    if (ctrl) ctrl.abort();
  };
}
