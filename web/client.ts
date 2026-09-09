type Msg =
  | { type: 'ready' } | { type: 'closed' } | { type: 'interrupted' }
  | { type: 'audio'; data: string }
  | { type: 'user_partial'; text: string } | { type: 'user'; text: string } | { type: 'agent'; text: string }
  | { type: 'answer'; name: string; value: unknown; display: string; answers: Record<string, unknown> }
  | { type: 'submit'; ok: boolean; instanceId?: string; message?: string }
  | { type: 'latency'; total: number; user_to_toolcall: number|null; tool_handling: number|null; toolresult_to_reply: number|null; reply_to_audio: number|null }
  | { type: 'error' | 'fatal'; message: string };

const $ = (id: string) => document.getElementById(id)!;
const log = (t: string, cls = '') => { const d = document.createElement('div'); d.className = 'line ' + cls; d.textContent = t; $('transcript').append(d); $('transcript').scrollTop = 1e9; };
const b64ToBuf = (b64: string) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
const bufToB64 = (buf: ArrayBuffer) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };

let ws: WebSocket, ctx: AudioContext, capture: AudioWorkletNode, playback: AudioWorkletNode, micOn = false, holding = false;
const lat: number[] = [];
let turnEndedAt = 0; // performance.now() when respondent released the button
let awaitingAudio = false;

async function start() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => { $('status').textContent = 'disconnected'; };
  await new Promise((r) => (ws.onopen = () => r(null)));

  ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('/audio-worklet.js');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const src = ctx.createMediaStreamSource(stream);
  capture = new AudioWorkletNode(ctx, 'capture');
  capture.port.onmessage = (e) => { if (micOn && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio', data: bufToB64(e.data.buffer) })); };
  src.connect(capture);
  playback = new AudioWorkletNode(ctx, 'playback');
  playback.connect(ctx.destination);

  const lang = (document.getElementById('lang') as HTMLSelectElement).value;
  ws.send(JSON.stringify({ type: 'start', lang }));
  $('status').textContent = 'connecting to agent…';
  $('start').setAttribute('disabled', 'true');
  (document.getElementById('lang') as HTMLSelectElement).setAttribute('disabled', 'true');
}

function onMsg(m: Msg) {
  switch (m.type) {
    case 'ready': $('status').textContent = 'ready — hold the button and let the respondent speak'; $('talk').removeAttribute('disabled'); $('stop').removeAttribute('disabled'); break;
    case 'audio': {
      if (awaitingAudio && turnEndedAt) {
        awaitingAudio = false;
        const felt = Math.round(performance.now() - turnEndedAt);
        lat.push(felt); const avg = Math.round(lat.reduce((a,b)=>a+b,0)/lat.length);
        log(`⏱ heard reply ${felt}ms after you released (avg ${avg}ms over ${lat.length})`, 'lat');
      }
      const buf = b64ToBuf(m.data);
      playback.port.postMessage(buf, [buf]);
      break;
    }
    case 'interrupted': playback.port.postMessage('clear'); break;
    case 'user_partial': $('partial').textContent = m.text; break;
    case 'user': $('partial').textContent = ''; log('Respondent: ' + m.text, 'user'); break;
    case 'agent': log('Agent: ' + m.text, 'agent'); break;
    case 'answer': paintAnswer(m.name, m.display); break;
    case 'submit': log(m.ok ? '✓ Submitted to Kobo (' + m.instanceId + ')' : '✗ Submit failed: ' + m.message, m.ok ? 'ok' : 'err'); $('status').textContent = m.ok ? 'done — record in Kobo' : 'submit failed'; break;
    case 'closed': $('status').textContent = 'disconnected'; $('talk').setAttribute('disabled','true'); $('stop').setAttribute('disabled','true'); $('start').removeAttribute('disabled'); break;
    case 'latency': break; // server-side breakdown still logged on the server
    case 'error': case 'fatal': log('Error: ' + m.message, 'err'); break;
  }
}

function paintAnswer(name: string, display: string) {
  // on mobile, surface the form panel when an answer lands
  const t = document.querySelector<HTMLElement>('#tabs button[data-tab="left"]');
  if (t && getComputedStyle(document.getElementById('tabs')!).display !== 'none') t.click();
  let row = document.querySelector<HTMLElement>(`[data-q="${name}"]`);
  if (!row) { row = document.createElement('div'); row.className = 'field'; row.dataset.q = name; row.innerHTML = `<span class="qn">${name}</span><span class="qv"></span>`; $('form').append(row); }
  row.querySelector('.qv')!.textContent = display;
  row.classList.add('flash'); setTimeout(() => row!.classList.remove('flash'), 600);
}

// Push-to-talk: mic is live only while held. Agent TTS keeps playing; the respondent's
// answer is what we capture. Releasing stops capture so enumerator coaching isn't recorded.
function hold(on: boolean) {
  micOn = on; holding = on; $('talk').classList.toggle('holding', on);
  if (!on) { turnEndedAt = performance.now(); awaitingAudio = true; }
}
const talk = $('talk');
const press = (on: boolean) => (e: Event) => { e.preventDefault(); hold(on); };
talk.addEventListener('pointerdown', press(true));
talk.addEventListener('pointerup', press(false));
talk.addEventListener('pointercancel', press(false));
talk.addEventListener('pointerleave', () => { if (holding) hold(false); });
// iOS Safari sometimes fires touch events without pointer events; cover both.
talk.addEventListener('touchstart', press(true), { passive: false });
talk.addEventListener('touchend', press(false), { passive: false });
function stop() {
  try { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'end' })); } catch {}
  micOn = false; holding = false;
  try { playback?.port.postMessage('clear'); } catch {}
  try { ws?.close(); } catch {}
  try { ctx?.close(); } catch {}
  $('status').textContent = 'stopped';
  $('talk').setAttribute('disabled', 'true');
  $('stop').setAttribute('disabled', 'true');
  $('start').removeAttribute('disabled');
  (document.getElementById('lang') as HTMLSelectElement).removeAttribute('disabled');
}
$('stop').addEventListener('click', stop);
$('start').addEventListener('click', () => start().catch((e) => log('Start failed: ' + e.message, 'err')));
