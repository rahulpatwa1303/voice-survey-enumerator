type Msg =
  | { type: 'ready' } | { type: 'closed' } | { type: 'interrupted' }
  | { type: 'audio'; data: string }
  | { type: 'user_partial'; text: string } | { type: 'user'; text: string } | { type: 'agent'; text: string }
  | { type: 'answer'; name: string; value: unknown; display: string; answers: Record<string, unknown> }
  | { type: 'submit'; ok: boolean; instanceId?: string; message?: string }
  | { type: 'phase'; phase: 'idle'|'listening'|'thinking'|'speaking' }
  | { type: 'stalled'; nudging: boolean }
  | { type: 'latency'; total: number; user_to_toolcall: number|null; tool_handling: number|null; toolresult_to_reply: number|null; reply_to_audio: number|null }
  | { type: 'error' | 'fatal'; message: string };

const $ = (id: string) => document.getElementById(id)!;
const log = (t: string, cls = '') => { const d = document.createElement('div'); d.className = 'line ' + cls; d.textContent = t; $('transcript').append(d); $('transcript').scrollTop = 1e9; };
function download(name: string, data: string, mime: string) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
const downloadJSON = (obj: unknown) => download('survey-record.json', JSON.stringify(obj, null, 2), 'application/json');
const b64ToBuf = (b64: string) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
const bufToB64 = (buf: ArrayBuffer) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };

let ws: WebSocket, ctx: AudioContext, capture: AudioWorkletNode, playback: AudioWorkletNode, micOn = false, holding = false;
const lat: number[] = [];
let turnEndedAt = 0; // performance.now() when respondent released the button
let uploadedFormId: string | null = null;
let lastReceipt: { json: unknown; text: string } | null = null;
let thinkingSince = 0, phaseTimer: number | undefined;

const PHASE_TEXT: Record<string, string> = {
  idle: 'Ready — hold to let the respondent speak',
  listening: 'Listening to the respondent…',
  thinking: 'Thinking…',
  speaking: 'Agent is speaking…',
};

function setPhase(p: 'idle'|'listening'|'thinking'|'speaking') {
  const pill = $('phase');
  pill.className = 'pill ' + p;
  pill.textContent = PHASE_TEXT[p];
  clearInterval(phaseTimer);
  if (p === 'thinking') {
    thinkingSince = performance.now();
    // show a counter so nobody is left wondering whether it is stuck
    phaseTimer = setInterval(() => {
      const s = ((performance.now() - thinkingSince) / 1000).toFixed(1);
      pill.textContent = `Thinking… ${s}s`;
    }, 100) as unknown as number;
  }
  $('nudge').toggleAttribute('disabled', !(p === 'thinking' || p === 'idle'));
}
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
  ws.send(JSON.stringify({ type: 'start', lang, formId: uploadedFormId }));
  $('status').textContent = 'connecting to agent…';
  $('start').setAttribute('disabled', 'true');
  (document.getElementById('lang') as HTMLSelectElement).setAttribute('disabled', 'true');
}

function onMsg(m: Msg) {
  switch (m.type) {
    case 'ready': $('status').textContent = 'connected'; $('talk').removeAttribute('disabled'); $('stop').removeAttribute('disabled'); break;
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
    case 'submit': {
      const anyM = m as any;
      if (anyM.receipt) {
        lastReceipt = { json: anyM.receipt, text: anyM.receiptText };
        $('receipt').removeAttribute('disabled');
        renderReceipt(anyM.receipt);
        showReceipt(true);
        const sum = anyM.receipt.summary;
        log(`🧾 Receipt ready — ${sum.answered} answered, ${sum.skipped} skipped, ${sum.corrections} corrections`, 'ok');
      }
      const msg = anyM.instanceId ? '✓ Submitted to Kobo (' + anyM.instanceId + ')' : anyM.note ? '✓ ' + anyM.note : (m.ok ? '✓ Recorded' : '✗ Submit failed: ' + anyM.message);
      log(msg, m.ok ? 'ok' : 'err');
      $('status').textContent = m.ok ? 'done' : 'submit failed';
      break;
    }
    case 'closed': setPhase('idle'); $('phase').textContent = 'Disconnected'; $('status').textContent = 'disconnected'; $('talk').setAttribute('disabled','true'); $('stop').setAttribute('disabled','true'); $('start').removeAttribute('disabled'); break;
    case 'latency': break; // server-side breakdown still logged on the server
    case 'phase': setPhase(m.phase); break;
    case 'stalled':
      if (m.nudging) { $('phase').className = 'pill stalled'; log('⏳ Agent went quiet — nudging it to continue.', 'err'); }
      else { $('phase').className = 'pill stalled'; $('phase').textContent = 'No response — tap Retry'; log('✗ Agent is not responding. Tap Retry, or Stop and start again.', 'err'); }
      break;
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
async function onUpload(file: File) {
  $('status').textContent = 'parsing form…';
  const buf = await file.arrayBuffer();
  const res = await fetch('/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
  const data = await res.json();
  if (!res.ok) { log('Upload failed: ' + (data.error || res.status), 'err'); $('status').textContent = 'upload failed'; return; }
  uploadedFormId = data.id;
  const sel = document.getElementById('lang') as HTMLSelectElement;
  sel.innerHTML = (data.languages as string[]).map((l) => `<option value="${l}">${l}</option>`).join('');
  $('status').textContent = `loaded "${data.title}" — ${data.questions} questions, languages: ${(data.languages as string[]).join(', ')}`;
  log(`Loaded form "${data.title}" (${data.questions} questions).`, 'ok');
  for (const lim of data.limitations as string[]) log('⚠ ' + lim, 'err');
}
(document.getElementById('file') as HTMLInputElement).addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (f) onUpload(f).catch((err) => log('Upload error: ' + err.message, 'err'));
});
function esc(t: unknown) { return String(t ?? '').replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!)); }

function renderReceipt(r: any) {
  $('receiptsummary').textContent =
    `${r.form.title} · ${r.summary.answered} answered · ${r.summary.skipped} skipped · ${r.summary.corrections} correction(s)`;
  const parts: string[] = [];
  for (const e of r.events) {
    if (e.t === 'answer') {
      parts.push(`<div class="rq"><div class="q">${esc(e.question)}</div>
        <div class="v">${esc(e.display)}</div>
        ${e.heard ? `<div class="meta heard">respondent said: “${esc(e.heard)}”</div>` : ''}
        ${e.shownBecause ? `<div class="meta">asked because ${esc(e.shownBecause)}</div>` : ''}
        ${e.validatedBy ? `<div class="meta">checked against ${esc(e.validatedBy)}</div>` : ''}</div>`);
    } else if (e.t === 'rejected') {
      parts.push(`<div class="rq bad"><div class="q">${esc(e.question)}</div>
        <div class="v">rejected “${esc(e.attempted)}” — ${esc(e.reason)}</div>
        ${e.heard ? `<div class="meta heard">respondent said: “${esc(e.heard)}”</div>` : ''}
        ${e.rule ? `<div class="meta">rule ${esc(e.rule)}</div>` : ''}</div>`);
    } else if (e.t === 'skipped') {
      parts.push(`<div class="rq skip"><div class="q">${esc(e.question)}</div><div class="v">skipped (optional)</div></div>`);
    } else if (e.t === 'submitted') {
      parts.push(`<div class="rq"><div class="q">Submitted to ${esc(e.destination)}</div>
        <div class="meta">${e.ok ? esc(e.instanceId ?? 'ok') : 'failed: ' + esc(e.message)}</div></div>`);
    }
  }
  $('receiptbody').innerHTML = parts.join('');
}

function showReceipt(on: boolean) {
  ($('receiptpanel') as HTMLElement).hidden = !on;
  ($('tabs') as HTMLElement).style.display = on ? 'none' : '';
  document.querySelectorAll<HTMLElement>('main > section:not(#receiptpanel)').forEach((el) => { el.style.display = on ? 'none' : ''; });
}
$('closereceipt').addEventListener('click', () => showReceipt(false));
$('dlreceipt').addEventListener('click', () => lastReceipt && download('interview-receipt.txt', lastReceipt.text, 'text/plain'));
$('dljson').addEventListener('click', () => lastReceipt && download('interview-receipt.json', JSON.stringify(lastReceipt.json, null, 2), 'application/json'));
$('nudge').addEventListener('click', () => {
  if (ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'nudge' })); log('↻ Asked the agent to continue.', 'lat'); }
});
$('receipt').addEventListener('click', () => { if (lastReceipt) showReceipt(true); });
$('start').addEventListener('click', () => start().catch((e) => log('Start failed: ' + e.message, 'err')));
