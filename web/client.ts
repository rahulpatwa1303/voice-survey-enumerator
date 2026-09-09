type Msg =
  | { type: 'ready' } | { type: 'closed' } | { type: 'interrupted' }
  | { type: 'audio'; data: string }
  | { type: 'user_partial'; text: string } | { type: 'user'; text: string } | { type: 'agent'; text: string }
  | { type: 'answer'; name: string; value: unknown; display: string; answers: Record<string, unknown> }
  | { type: 'submit'; ok: boolean; instanceId?: string; message?: string }
  | { type: 'error' | 'fatal'; message: string };

const $ = (id: string) => document.getElementById(id)!;
const log = (t: string, cls = '') => { const d = document.createElement('div'); d.className = 'line ' + cls; d.textContent = t; $('transcript').append(d); $('transcript').scrollTop = 1e9; };
const b64ToBuf = (b64: string) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
const bufToB64 = (buf: ArrayBuffer) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };

let ws: WebSocket, ctx: AudioContext, capture: AudioWorkletNode, playback: AudioWorkletNode, micOn = false, holding = false;

async function start() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => { $('status').textContent = 'disconnected'; };
  await new Promise((r) => (ws.onopen = () => r(null)));

  ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/audio-worklet.js');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const src = ctx.createMediaStreamSource(stream);
  capture = new AudioWorkletNode(ctx, 'capture');
  capture.port.onmessage = (e) => { if (micOn && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio', data: bufToB64(e.data.buffer) })); };
  src.connect(capture);
  playback = new AudioWorkletNode(ctx, 'playback');
  playback.connect(ctx.destination);

  $('status').textContent = 'connecting to agent…';
  $('start').setAttribute('disabled', 'true');
}

function onMsg(m: Msg) {
  switch (m.type) {
    case 'ready': $('status').textContent = 'ready — hold the button and let the respondent speak'; $('talk').removeAttribute('disabled'); break;
    case 'audio': playback.port.postMessage(b64ToBuf(m.data), [b64ToBuf(m.data)]); break;
    case 'interrupted': playback.port.postMessage('clear'); break;
    case 'user_partial': $('partial').textContent = m.text; break;
    case 'user': $('partial').textContent = ''; log('Respondent: ' + m.text, 'user'); break;
    case 'agent': log('Agent: ' + m.text, 'agent'); break;
    case 'answer': paintAnswer(m.name, m.display); break;
    case 'submit': log(m.ok ? '✓ Submitted to Kobo (' + m.instanceId + ')' : '✗ Submit failed: ' + m.message, m.ok ? 'ok' : 'err'); $('status').textContent = m.ok ? 'done — record in Kobo' : 'submit failed'; break;
    case 'error': case 'fatal': log('Error: ' + m.message, 'err'); break;
  }
}

function paintAnswer(name: string, display: string) {
  let row = document.querySelector<HTMLElement>(`[data-q="${name}"]`);
  if (!row) { row = document.createElement('div'); row.className = 'field'; row.dataset.q = name; row.innerHTML = `<span class="qn">${name}</span><span class="qv"></span>`; $('form').append(row); }
  row.querySelector('.qv')!.textContent = display;
  row.classList.add('flash'); setTimeout(() => row!.classList.remove('flash'), 600);
}

// Push-to-talk: mic is live only while held. Agent TTS keeps playing; the respondent's
// answer is what we capture. Releasing stops capture so enumerator coaching isn't recorded.
function hold(on: boolean) { micOn = on; holding = on; $('talk').classList.toggle('holding', on); }
$('talk').addEventListener('pointerdown', () => hold(true));
$('talk').addEventListener('pointerup', () => hold(false));
$('talk').addEventListener('pointerleave', () => { if (holding) hold(false); });
$('start').addEventListener('click', () => start().catch((e) => log('Start failed: ' + e.message, 'err')));
