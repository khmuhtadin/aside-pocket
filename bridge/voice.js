// Speech to text with Groq Whisper.

export function fileName(mime) {
  if (mime.startsWith('audio/mp4')) return 'audio.m4a';
  if (mime.startsWith('audio/webm')) return 'audio.webm';
  return 'audio.wav';
}

export async function transcribe(buffer, mime) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw Object.assign(new Error('GROQ_API_KEY missing'), { status: 503 });

  const form = new FormData();
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  form.append('file', new Blob([buffer], { type: mime }), fileName(mime));

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw Object.assign(new Error(`Groq responded ${res.status}`), { status: 502 });
  return (await res.json()).text;
}
