/*
 * Late Shift — enumerator front end.
 *
 * Talks to the server contract in the brief (§6) and nothing else.
 * web/audio-worklet.js is used as-is; the two processor names below are the only
 * coupling — check they match the registerProcessor() calls in that file.
 */

const CAPTURE_PROCESSOR = 'capture';
const PLAYBACK_PROCESSOR = 'playback';
const WORKLET_URL = '/audio-worklet.js';

/* ------------------------------------------------------------------ types */

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';
type View = 'setup' | 'interview' | 'review' | 'done';
type Tone = 'stop' | 'warn';

interface ParsedForm {
  id: string | null;
  title: string;
  questions: { name: string; label?: string }[];
  languages: string[];
  limitations: string[];
}

interface Receipt {
  form: { id: string; title: string };
  language: string;
  startedAt: string;
  finishedAt: string;
  summary: { answered: number; skipped: number; corrections: number };
  answers: Record<string, unknown>;
  events: {
    t: 'answer' | 'rejected' | 'skipped' | 'submitted';
    question?: string; display?: string; heard?: string; attempted?: string;
    reason?: string; rule?: string; shownBecause?: string; validatedBy?: string;
    ok?: boolean; destination?: string;
  }[];
}

interface Trouble { word: string; body: string; action: string; tone: Tone; act: string }

const DEMO: ParsedForm = {
  id: null, title: 'Maternal follow-up', questions: [], languages: ['en', 'hi', 'es'], limitations: []
};

const LANG_NAMES: Record<string, string> = {
  en: 'English', es: 'Español  Spanish', fr: 'Français  French', de: 'Deutsch  German',
  it: 'Italiano  Italian', pt: 'Português  Portuguese', hi: 'हिन्दी  Hindi', bn: 'বাংলা  Bengali',
  ta: 'தமிழ்  Tamil', ur: 'اردو  Urdu', ar: 'العربية  Arabic', sw: 'Kiswahili  Swahili',
  id: 'Bahasa Indonesia', vi: 'Tiếng Việt  Vietnamese', tr: 'Türkçe  Turkish',
  ru: 'Русский  Russian', zh: '中文  Chinese', ja: '日本語  Japanese'
};
const SPOKEN = ['en', 'es', 'fr', 'de', 'it', 'pt'];

/* ------------------------------------------------------------------ state */

const S = {
  screen: 'setup' as View,
  phase: 'idle' as Phase,
  form: DEMO as ParsedForm,
  usingUpload: false,
  uploaded: null as ParsedForm | null,
  uploadStage: 'idle' as 'idle' | 'busy' | 'ok' | 'bad',
  uploadError: '',
  uploadOpen: false,
  lang: 'en',
  hasKey: true,

  held: false,
  partial: '',
  agentText: '',
  answers: {} as Record<string, unknown>,
  display: {} as Record<string, string>,
  askedWith: {} as Record<string, string>,   // field -> the question as the agent actually said it
  qlabel: {} as Record<string, string>,      // field -> the canonical question from the form
  order: [] as string[],
  correcting: null as { name: string; label: string } | null,

  fixOpen: false,
  receiptOpen: false,
  trouble: null as Trouble | null,
  saved: 'remote' as 'remote' | 'local',
  receipt: null as Receipt | null,
  receiptText: '',
  record: null as unknown,
  notice: ''                                  // shown on the check screen after a refresh
};

const app = document.getElementById('app') as HTMLElement;
const fileInput = document.getElementById('file') as HTMLInputElement;

/* ------------------------------------------------------------------ audio */

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let capture: AudioWorkletNode | null = null;
let playback: AudioWorkletNode | null = null;

async function openAudio(): Promise<void> {
  if (ctx) { await ctx.resume(); return; }
  const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  ctx = new AC();
  await ctx.resume();                                  // must happen inside the Start gesture (iOS)
  await ctx.audioWorklet.addModule(WORKLET_URL);

  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });

  capture = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, { numberOfOutputs: 0 });
  capture.port.onmessage = (e) => {
    if (!S.held) return;                               // mic is only live while the button is held
    const data: ArrayBuffer | Int16Array = e.data && e.data.buffer ? e.data.buffer : e.data;
    send({ type: 'audio', data: toBase64(data as ArrayBuffer) });
  };
  ctx.createMediaStreamSource(stream).connect(capture);

  playback = new AudioWorkletNode(ctx, PLAYBACK_PROCESSOR, { numberOfInputs: 0, outputChannelCount: [1] });
  playback.connect(ctx.destination);
}

function play(b64: string): void { if (playback) playback.port.postMessage(fromBase64(b64)); }
function dropQueue(): void { if (playback) playback.port.postMessage('clear'); }

function closeAudio(): void {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (ctx) ctx.close();
  ctx = null; capture = null; playback = null;
}

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)) as any);
  return btoa(out);
}
function fromBase64(s: string): Int16Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new Int16Array(b.buffer);
}

/* ------------------------------------------------------------------ socket */

let ws: WebSocket | null = null;
let finishing = false;

function send(m: unknown): void { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }

function connect(): void {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  ws = new WebSocket(url);
  ws.onopen = () => send({ type: 'start', lang: S.lang, formId: S.usingUpload && S.uploaded ? S.uploaded.id : null });
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* ignore malformed frame */ } };
  ws.onerror = () => { if (S.screen === 'interview' && !finishing) setTrouble(TROUBLE.net); };
  ws.onclose = () => { if (S.screen === 'interview' && !finishing) setTrouble(TROUBLE.net); };
}

const TROUBLE: Record<string, Trouble> = {
  mic: { word: 'No sound', body: 'The phone cannot hear. Let this app use the microphone, then hold the button again.', action: 'Try again', tone: 'stop', act: 'mic-retry' },
  net: { word: 'No signal', body: 'The phone lost its connection. The answers so far are safe.', action: 'Try again', tone: 'warn', act: 'reconnect' },
  stalled: { word: 'Paused', body: 'The phone stopped talking. Tap to carry on from the last question.', action: 'Carry on', tone: 'warn', act: 'nudge' },
  broken: { word: 'Something is wrong', body: 'The phone cannot carry on with this interview. The answers so far are safe.', action: 'Stop and check answers', tone: 'stop', act: 'to-review' }
};

function setTrouble(t: Trouble): void {
  S.trouble = t; S.receiptOpen = false; S.fixOpen = false; S.held = false;
  draw();
}

function handle(m: any): void {
  switch (m.type) {
    case 'ready':
      go('interview'); S.phase = 'speaking'; break;
    case 'phase':
      S.phase = m.phase as Phase; break;
    case 'audio':
      // only the interview screen has a voice; elsewhere the agent must be silent
      if (S.screen === 'interview') play(m.data);
      break;
    case 'interrupted':
      dropQueue(); break;
    case 'user_partial':
      S.partial = m.text || ''; break;
    case 'user':
      S.partial = m.text || ''; break;
    case 'agent':
      S.agentText = m.text || ''; S.partial = ''; break;
    case 'answer': {
      const name = String(m.name);
      S.answers = m.answers || S.answers;
      S.display[name] = m.display != null ? String(m.display) : String(m.value);
      if (m.question) S.qlabel[name] = String(m.question);
      if (S.agentText && !S.askedWith[name]) S.askedWith[name] = S.agentText;
      if (S.order.indexOf(name) === -1) S.order.push(name);
      if (S.correcting && S.correcting.name === name) S.correcting = null;
      S.partial = '';
      // later questions may appear or disappear — never assume a fixed list
      S.order = S.order.filter((n) => n in S.answers);
      persist();
      break;
    }
    case 'stalled':
      if (!m.nudging) setTrouble(TROUBLE.stalled);
      return;
    case 'submit':
      finishing = true;
      S.receipt = m.receipt || null;
      S.receiptText = m.receiptText || '';
      S.record = m.record || null;
      S.saved = m.ok ? 'remote' : 'local';
      go('done'); S.phase = 'idle'; S.trouble = null;
      closeAudio();
      break;
    case 'error':
    case 'fatal':
      setTrouble(translate(String(m.message || '')));
      return;
    case 'closed':
      if (S.screen === 'interview' && !finishing) setTrouble(TROUBLE.net);
      return;
    case 'latency':
      return;                                          // development only
    default:
      return;
  }
  draw();
}

function translate(msg: string): Trouble {
  const m = msg.toLowerCase();
  if (/mic|permission|notallowed|getusermedia|audio/.test(m)) return TROUBLE.mic;
  if (/network|socket|connect|timeout|offline|econn/.test(m)) return TROUBLE.net;
  return TROUBLE.broken;
}

/* ------------------------------------------------------------------ actions */

async function start(): Promise<void> {
  try { await openAudio(); } catch { setTrouble(TROUBLE.mic); return; }
  finishing = false;
  S.answers = {}; S.display = {}; S.askedWith = {}; S.qlabel = {}; S.order = [];
  S.agentText = ''; S.partial = ''; S.correcting = null; S.trouble = null;
  go('interview'); S.phase = 'speaking';
  connect();
  draw();
}

function holdOn(e: Event): void {
  e.preventDefault();
  if (S.trouble || S.screen !== 'interview') return;
  S.held = true; S.partial = '';
  if (S.phase === 'speaking') { dropQueue(); }         // barge-in: stop playback, let the server lead
  paint();
}
function holdOff(e: Event): void {
  e.preventDefault();
  if (!S.held) return;
  S.held = false;
  paint();
}


/* ---------------------------------------------------------------------------
   URL routing + crash-safe state.
   The screen lives in the URL so refresh and browser back behave normally.
   Answers are mirrored into sessionStorage so a refresh never loses data.
   A live voice session cannot survive a reload (the socket, and the server's
   interview state with it, are gone), so a mid-interview refresh lands on the
   check screen with the answers intact rather than pretending otherwise.
--------------------------------------------------------------------------- */
const STORE_KEY = 'lateshift.interview';
const SCREENS: View[] = ['setup', 'interview', 'review', 'done'];

function persist(): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({
      screen: S.screen, answers: S.answers, display: S.display, qlabel: S.qlabel,
      askedWith: S.askedWith, order: S.order, lang: S.lang, usingUpload: S.usingUpload,
      uploaded: S.uploaded, saved: S.saved, receipt: S.receipt, receiptText: S.receiptText,
      record: S.record
    }));
  } catch { /* private mode: routing still works, persistence does not */ }
}

function go(screen: View, replace = false): void {
  S.screen = screen;
  const url = '#/' + screen;
  if (replace || location.hash === url) history.replaceState({ ls: screen }, '', url);
  else history.pushState({ ls: screen }, '', url);
  persist();
}

function screenFromUrl(): View | null {
  const h = location.hash.replace(/^#\/?/, '') as View;
  return SCREENS.indexOf(h) !== -1 ? h : null;
}

function restore(): void {
  let saved: any = null;
  try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { /* ignore */ }
  const urlScreen = screenFromUrl();
  if (!saved && !urlScreen) { go('setup', true); return; }

  if (saved) {
    S.answers = saved.answers || {}; S.display = saved.display || {};
    S.qlabel = saved.qlabel || {}; S.askedWith = saved.askedWith || {};
    S.order = saved.order || []; S.lang = saved.lang || S.lang;
    S.usingUpload = !!saved.usingUpload; S.uploaded = saved.uploaded || null;
    S.saved = saved.saved || 'remote'; S.receipt = saved.receipt || null;
    S.receiptText = saved.receiptText || ''; S.record = saved.record ?? null;
  }

  const want = urlScreen || (saved && saved.screen) || 'setup';
  const answered = Object.keys(S.answers).length;

  if (want === 'done' && S.receipt) { go('done', true); return; }
  if (want === 'interview') {
    // the voice session cannot be resumed after a reload
    if (answered) {
      S.notice = 'The page reloaded, so the voice session ended. The answers below were kept — check them and save, or start a new interview.';
      go('review', true);
    } else { go('setup', true); }
    return;
  }
  if (want === 'review' && answered) { go('review', true); return; }
  go('setup', true);
}

function finish(): void { dropQueue(); go('review'); S.fixOpen = false; S.held = false; draw(); }

function saveAll(): void { finishing = true; send({ type: 'end' }); S.phase = 'thinking'; draw(); }

function correct(name: string): void {
  S.correcting = { name, label: questionText(name) };
  S.fixOpen = false; go('interview');
  draw();
}

function nextInterview(): void {
  if (ws) { try { ws.close(); } catch { /* already gone */ } ws = null; }
  closeAudio();
  S.notice = ''; go('setup'); S.phase = 'idle'; S.trouble = null; S.receiptOpen = false; S.fixOpen = false;
  S.answers = {}; S.display = {}; S.askedWith = {}; S.qlabel = {}; S.order = []; S.correcting = null;
  S.receipt = null; S.receiptText = ''; S.record = null;
  draw();
}

function downloadRecord(): void {
  const blob = new Blob([S.receiptText || JSON.stringify(S.record, null, 2)], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'interview-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function upload(f: File): Promise<void> {
  S.uploadStage = 'busy'; S.uploadError = ''; draw();
  if (!/\.xlsx$/i.test(f.name)) {
    S.uploadStage = 'bad'; S.uploadError = 'This is not a survey file. Look for one ending in .xlsx.'; draw(); return;
  }
  if (f.size > 8 * 1024 * 1024) {
    S.uploadStage = 'bad'; S.uploadError = 'That file is too big for the phone. Ask your office for a smaller one.'; draw(); return;
  }
  try {
    const res = await fetch('/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await f.arrayBuffer()
    });
    const body = await res.json();
    if (!res.ok) {
      S.uploadStage = 'bad';
      S.uploadError = 'The phone could not read this survey. Ask your office to send it again.';
      draw(); return;
    }
    S.uploaded = {
      id: body.id,
      title: body.title || f.name.replace(/\.xlsx$/i, ''),
      questions: Array.isArray(body.questions) ? body.questions : [],
      languages: Array.isArray(body.languages) && body.languages.length ? body.languages : ['en'],
      limitations: Array.isArray(body.limitations) ? body.limitations : []
    };
    S.uploadStage = 'ok';
  } catch {
    S.uploadStage = 'bad';
    S.uploadError = 'The phone has no connection to your office right now. Try again when you have signal.';
  }
  draw();
}

/* ------------------------------------------------------------------ helpers */

function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
}
function form(): ParsedForm { return S.usingUpload && S.uploaded ? S.uploaded : S.form; }
function langName(c: string): string { return LANG_NAMES[c] || c.toUpperCase(); }
function langNote(c: string): string {
  return SPOKEN.indexOf(c) !== -1 ? 'Speaks and understands it' : 'Understands ' + langName(c).split('  ')[0] + ', answers in English';
}
function questionText(name: string): string {
  const q = form().questions.filter((x) => x.name === name)[0];
  return S.qlabel[name] || (q && q.label) || S.askedWith[name] || 'Earlier answer';
}
function total(): number {
  const qs = form().questions.length;
  return qs || 0;
}

const STATE_TEXT: Record<string, { word: string; hint: string; glyph: string }> = {
  listening: { word: 'Listening', hint: 'Keep holding while she answers', glyph: '<div class="g-dot"></div>' },
  speaking: { word: 'Speaking', hint: 'The phone is asking the question', glyph: '<div class="g-tri"></div>' },
  thinking: { word: 'One moment', hint: 'Writing the answer down', glyph: '<div class="g-dots"><i></i><i></i><i></i></div>' },
  idle: { word: 'Her turn', hint: 'Hold the button, point the phone at her', glyph: '<div class="g-ring"></div>' }
};
function bandPhase(): string { return S.held ? 'listening' : (S.phase === 'idle' ? 'idle' : S.phase); }

/* ------------------------------------------------------------------ views */

function setupView(): string {
  const f = form();
  const langs = f.languages.length ? f.languages : ['en'];
  const lims = f.limitations;
  return `
  <div class="screen">
    <div class="pad"><div class="eyebrow">Step 1 of 2</div><h1>New interview</h1></div>
    <div class="scroll">
      <div class="stack">
        <h2>Which survey?</h2>
        <button class="choice" aria-pressed="${!S.usingUpload}" data-act="use-demo">
          <div class="radio"><i></i></div>
          <div><div class="ctitle">${esc(DEMO.title)}</div><div class="csub">Ready on this phone</div></div>
        </button>
        ${S.uploaded ? `
        <button class="choice" aria-pressed="${S.usingUpload}" data-act="use-upload">
          <div class="radio"><i></i></div>
          <div><div class="ctitle">${esc(S.uploaded.title)}</div><div class="csub">From a file${S.uploaded.questions.length ? ' · ' + S.uploaded.questions.length + ' questions' : ''}</div></div>
        </button>` : ''}
        <button class="choice add" data-act="open-upload">
          <div class="radio"><i></i></div>
          <div><div class="ctitle">${S.uploaded ? 'Add another survey' : 'Add a survey'}</div><div class="csub">Open a file your office sent</div></div>
        </button>
      </div>

      <div class="stack">
        <h2>Which language?</h2>
        ${langs.map((c) => `
        <button class="choice" aria-pressed="${S.lang === c}" data-act="lang" data-val="${esc(c)}">
          <div class="radio"><i></i></div>
          <div><div class="ctitle">${esc(langName(c))}</div><div class="csub">${esc(langNote(c))}</div></div>
        </button>`).join('')}
      </div>

      ${lims.length ? `
      <div class="notice">
        <div style="display:flex;align-items:center;gap:10px"><div class="bang">!</div>
        <h2>${lims.length} ${lims.length === 1 ? 'question' : 'questions'} the phone cannot ask</h2></div>
        ${lims.map((l) => `<p>${esc(l)}</p>`).join('')}
        <p style="color:var(--quiet)">You can fill these in later on paper.</p>
      </div>` : ''}

      ${!S.hasKey ? `
      <div class="notice">
        <div style="display:flex;align-items:center;gap:10px"><div class="bang">!</div><h2>This phone cannot talk yet</h2></div>
        <p>Ask your office to finish setting it up.</p>
      </div>` : ''}
    </div>
    <div class="foot">
      <button class="big" data-act="start" ${S.hasKey ? '' : 'disabled'}>
        <span style="width:0;height:0;border-left:20px solid currentColor;border-top:13px solid transparent;border-bottom:13px solid transparent"></span>
        Start
      </button>
      <p style="text-align:center;font-size:15px;color:var(--quiet);margin:10px 0 0">The phone asks the first question.</p>
    </div>
  </div>`;
}

function interviewView(): string {
  const t = STATE_TEXT[bandPhase()];
  const tot = total();
  const n = S.order.length;
  const bars = tot ? Array.from({ length: tot }, (_, i) =>
    `<i class="${i < n ? 'on' : i === n ? 'now' : ''}"></i>`).join('') : '';
  const lastName = S.order[S.order.length - 1];
  return `
  <div class="screen">
    <div class="topbar">
      <div class="count" id="count">${tot ? `${Math.min(n + 1, tot)} of ${tot}` : `Question ${n + 1}`}</div>
      <div class="bar" id="bar">${bars}</div>
      <button class="small" data-act="open-fix">Fix</button>
      <button class="small" data-act="finish" aria-label="Stop the interview"><span class="stopsq"></span></button>
    </div>

    <div class="state" id="band" data-phase="${bandPhase()}">
      <div class="glyph" id="glyph">${t.glyph}</div>
      <div class="word" id="word">${esc(t.word)}</div>
      <div class="hint" id="hint">${esc(t.hint)}</div>
    </div>

    <div class="middle">
      ${S.correcting ? `
      <div class="notice" style="padding:10px 14px">
        <div style="display:flex;align-items:center;gap:10px"><div class="bang">!</div>
        <h2>Fixing one answer</h2></div>
        <p>Hold the button and say the right answer for: ${esc(S.correcting.label)}</p>
      </div>` : ''}
      <div>
        <div class="eyebrow" style="margin-bottom:6px">Question now</div>
        <div class="qnow" id="qnow">${esc(S.agentText || 'The phone is starting the interview…')}</div>
      </div>
      <div class="partial" id="partial" ${S.held && S.partial ? '' : 'hidden'}>“${esc(S.partial)}”</div>
      <div class="card" id="last" ${!S.held && lastName ? '' : 'hidden'}>
        <div class="k">Last answer · <span id="lastk">${esc(lastName ? questionText(lastName) : '')}</span></div>
        <div class="v" id="lastv">${esc(lastName ? S.display[lastName] : '')}</div>
      </div>
    </div>

    <div class="holdzone">
      <button class="hold" id="hold" data-live="${S.held ? 1 : 0}">
        ${S.held ? 'Listening' : 'Hold to talk'}
        <span>${S.held ? 'Let go when she stops' : 'Point the phone at her'}</span>
      </button>
    </div>
  </div>`;
}

function reviewView(): string {
  const names = S.order.length ? S.order : Object.keys(S.answers);
  return `
  <div class="screen">
    <div class="pad" style="border-bottom:2px solid var(--line2);padding-bottom:14px">
      ${finishing ? '' : '<button class="small" data-act="to-interview" style="margin-bottom:10px">&larr; Back to questions</button>'}
      <h1 style="font-size:30px">Please check these</h1>
      ${S.notice ? `<p class="restored">${esc(S.notice)}</p>` : ''}
      <p style="margin:4px 0 0;font-size:17px;color:var(--muted)">Tap anything that is wrong.</p>
    </div>
    <div class="scroll" style="gap:8px;padding-top:8px">
      ${names.map((nm) => `
      <button class="row" data-act="correct" data-val="${esc(nm)}">
        <div style="flex:1;min-width:0">
          <div class="q">${esc(questionText(nm))}</div>
          <div class="a${S.display[nm] ? '' : ' empty'}">${esc(S.display[nm] || 'Not answered')}</div>
        </div>
        <div class="tag">Fix</div>
      </button>`).join('')}
    </div>
    <div class="foot">
      <button class="big go" data-act="save">All correct · Save</button>
    </div>
  </div>`;
}

function doneView(): string {
  const remote = S.saved === 'remote';
  return `
  <div class="screen">
    <div class="done" data-saved="${S.saved}">
      <div class="tick"><i></i></div>
      <div class="word">${remote ? 'Saved' : 'Saved on this phone'}</div>
      <p>${remote
        ? 'Sent to your office. ' + S.order.length + ' answers.'
        : 'No connection to your office yet. Keep a copy to be safe.'}</p>
    </div>
    <div class="foot" style="border:none;display:flex;flex-direction:column;gap:12px">
      <button class="big" data-act="next">Next interview</button>
      <div style="display:flex;gap:12px">
        <button class="ghost" data-act="open-receipt">See the record</button>
        ${!remote ? '<button class="ghost" style="border-color:var(--amber);color:var(--amber-ink);background:var(--amber-bg)" data-act="download">Save a copy</button>' : ''}
      </div>
    </div>
  </div>`;
}

function uploadSheet(): string {
  const u = S.uploaded;
  let body = '';
  if (S.uploadStage === 'idle') {
    body = `<p>Pick the survey file your office sent you. It ends in <strong>.xlsx</strong>.</p>
            <button class="big" data-act="choose-file">Choose a file</button>`;
  } else if (S.uploadStage === 'busy') {
    body = `<div style="display:flex;align-items:center;gap:16px;min-height:84px">
              <div class="g-dots" style="gap:12px"><i style="width:20px;height:20px;background:var(--amber)"></i><i style="width:20px;height:20px;background:var(--amber)"></i><i style="width:20px;height:20px;background:var(--amber)"></i></div>
              <div style="font-size:20px;font-weight:700">Reading the survey…</div>
            </div>`;
  } else if (S.uploadStage === 'ok' && u) {
    body = `<div style="border:3px solid var(--green);border-radius:16px;background:#fff;padding:14px 16px">
              <div class="eyebrow" style="color:var(--green)">Ready to use</div>
              <div style="font-size:22px;font-weight:800;margin-top:3px">${esc(u.title)}</div>
              <div class="csub">${u.questions.length ? u.questions.length + ' questions · ' : ''}${esc(u.languages.map(langName).map((x) => x.split('  ')[0]).join(', '))}</div>
            </div>
            <button class="big go" data-act="accept-upload">Use this survey</button>`;
  } else {
    body = `<div style="border:3px solid var(--red);border-radius:16px;background:#fff;padding:14px 16px;display:flex;gap:12px;align-items:flex-start">
              <div class="bang" style="background:var(--red)">!</div>
              <div style="font-size:18px;font-weight:600;line-height:1.3">${esc(S.uploadError)}</div>
            </div>
            <button class="ghost" data-act="choose-file">Choose another file</button>`;
  }
  return `
  <div class="veil">
    <button class="tapaway" data-act="close-upload" aria-label="Close"></button>
    <div class="sheet">
      <h1>Add a survey</h1>
      ${body}
      <button class="quietbtn" data-act="close-upload">Not now</button>
    </div>
  </div>`;
}

function fixSheet(): string {
  const names = S.order.slice(-4).reverse();
  return `
  <div class="veil">
    <button class="tapaway" data-act="close-fix" aria-label="Close"></button>
    <div class="sheet">
      <h1>Which answer is wrong?</h1>
      <p>The phone will ask that question again.</p>
      <div class="sheetlist">
        ${names.length ? names.map((nm) => `
        <button class="pick" data-act="correct" data-val="${esc(nm)}">
          <div class="q">${esc(questionText(nm))}</div>
          <div class="a">${esc(S.display[nm])}</div>
        </button>`).join('') : '<p>Nothing has been written down yet.</p>'}
      </div>
      <button class="quietbtn" data-act="close-fix">Everything is fine</button>
    </div>
  </div>`;
}

function troubleView(): string {
  const t = S.trouble as Trouble;
  return `
  <div class="trouble" data-tone="${t.tone}" role="alert">
    <div class="mark">!</div>
    <div class="word">${esc(t.word)}</div>
    <p>${esc(t.body)}</p>
    <button class="big" data-act="${t.act}">${esc(t.action)}</button>
  </div>`;
}

function receiptView(): string {
  const r = S.receipt;
  const answered = r ? r.events.filter((e) => e.t === 'answer') : [];
  const rejected = r ? r.events.filter((e) => e.t === 'rejected') : [];
  const stats = r ? r.summary : { answered: S.order.length, skipped: 0, corrections: 0 };
  const when = r ? new Date(r.startedAt) : new Date();
  return `
  <div class="receipt">
    <div class="rhead">
      <h1>The record</h1>
      <button class="small" data-act="close-receipt">Close</button>
    </div>
    <div class="rbody">
      <div class="sheetpaper">
        <div>
          <h1>${esc(r ? r.form.title : form().title)}</h1>
          <div class="meta">${esc(langName(r ? r.language : S.lang).split('  ')[0])} · ${esc(when.toLocaleDateString())} ${esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>
        </div>
        <div class="stats">
          <div><b>${stats.answered}</b><span>Answered</span></div>
          <div><b>${stats.skipped}</b><span>Skipped</span></div>
          <div><b>${stats.corrections}</b><span>Fixed</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${answered.map((e) => `
          <div class="ev">
            <div class="q">${esc(e.question)}</div>
            <div class="a">${esc(e.display)}</div>
            ${e.heard ? `<div class="heard">heard: “${esc(e.heard)}”</div>` : ''}
            ${e.shownBecause ? `<div class="rule">${esc(e.shownBecause)}</div>` : ''}
            ${e.validatedBy ? `<div class="rule">${esc(e.validatedBy)}</div>` : ''}
          </div>`).join('')}
          ${rejected.map((e) => `
          <div class="ev bad">
            <div class="q">${esc(e.question)}</div>
            <div class="a">Not accepted: ${esc(e.attempted)}</div>
            ${e.heard ? `<div class="heard">heard: “${esc(e.heard)}”</div>` : ''}
            ${e.reason ? `<div class="rule">${esc(e.reason)}</div>` : ''}
          </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="foot">
      <button class="big" data-act="print" style="min-height:70px;font-size:21px">Print / save as PDF</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ render */

let lastKey = '';

function body(): string {
  if (S.screen === 'setup') return setupView();
  if (S.screen === 'interview') return interviewView();
  if (S.screen === 'review') return reviewView();
  return doneView();
}

function draw(): void {
  const key = [S.screen, S.uploadOpen ? 'u' + S.uploadStage : '', S.fixOpen ? 'f' : '',
    S.receiptOpen ? 'r' : '', S.trouble ? 't' + S.trouble.word : '',
    S.correcting ? 'c' : '', S.usingUpload ? 'up' : '', S.lang, S.order.length].join('|');
  if (key === lastKey && S.screen === 'interview') { paint(); return; }
  lastKey = key;
  app.innerHTML = body()
    + (S.uploadOpen ? uploadSheet() : '')
    + (S.fixOpen ? fixSheet() : '')
    + (S.receiptOpen ? receiptView() : '')
    + (S.trouble ? troubleView() : '');
  bindHold();
}

/** Live updates that must not blow away the DOM mid-hold. */
function paint(): void {
  if (S.screen !== 'interview') return;
  const t = STATE_TEXT[bandPhase()];
  const set = (id: string, html: string) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const band = document.getElementById('band');
  if (band && band.getAttribute('data-phase') !== bandPhase()) {
    band.setAttribute('data-phase', bandPhase());
    set('glyph', t.glyph);
  }
  set('word', esc(t.word)); set('hint', esc(t.hint));
  set('qnow', esc(S.agentText || 'The phone is starting the interview…'));

  const p = document.getElementById('partial');
  if (p) { p.hidden = !(S.held && S.partial); p.innerHTML = '“' + esc(S.partial) + '”'; }

  const lastName = S.order[S.order.length - 1];
  const card = document.getElementById('last');
  if (card) {
    card.hidden = !(!S.held && lastName);
    if (lastName) { set('lastk', esc(questionText(lastName))); set('lastv', esc(S.display[lastName])); }
  }
  const hold = document.getElementById('hold');
  if (hold) {
    hold.setAttribute('data-live', S.held ? '1' : '0');
    hold.innerHTML = (S.held ? 'Listening' : 'Hold to talk')
      + '<span>' + (S.held ? 'Let go when she stops' : 'Point the phone at her') + '</span>';
  }
  const tot = total(), n = S.order.length;
  const c = document.getElementById('count');
  if (c) c.textContent = tot ? `${Math.min(n + 1, tot)} of ${tot}` : `Question ${n + 1}`;
  const bar = document.getElementById('bar');
  if (bar && tot) bar.innerHTML = Array.from({ length: tot }, (_, i) =>
    `<i class="${i < n ? 'on' : i === n ? 'now' : ''}"></i>`).join('');
}

function bindHold(): void {
  const hold = document.getElementById('hold');
  if (!hold) return;
  hold.addEventListener('pointerdown', holdOn);
  hold.addEventListener('pointerup', holdOff);
  hold.addEventListener('pointercancel', holdOff);
  hold.addEventListener('pointerleave', holdOff);
  hold.addEventListener('contextmenu', (e) => e.preventDefault());
  hold.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
}

/* ------------------------------------------------------------------ input */

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el) return;
  const act = el.getAttribute('data-act');
  const val = el.getAttribute('data-val') || '';
  switch (act) {
    case 'use-demo': S.usingUpload = false; S.lang = DEMO.languages[0]; break;
    case 'use-upload': S.usingUpload = true; if (S.uploaded) S.lang = S.uploaded.languages[0]; break;
    case 'open-upload': S.uploadOpen = true; S.uploadStage = 'idle'; break;
    case 'close-upload': S.uploadOpen = false; break;
    case 'choose-file': fileInput.click(); return;
    case 'accept-upload': S.uploadOpen = false; S.usingUpload = true; if (S.uploaded) S.lang = S.uploaded.languages[0]; break;
    case 'lang': S.lang = val; break;
    case 'start': start(); return;
    case 'open-fix': S.fixOpen = true; break;
    case 'close-fix': S.fixOpen = false; break;
    case 'correct': correct(val); return;
    case 'finish': finish(); return;
    case 'save': saveAll(); return;
    case 'next': nextInterview(); return;
    case 'open-receipt': S.receiptOpen = true; break;
    case 'close-receipt': S.receiptOpen = false; break;
    case 'print': window.print(); return;
    case 'download': downloadRecord(); return;
    case 'nudge': S.trouble = null; send({ type: 'nudge' }); break;
    case 'reconnect': S.trouble = null; connect(); break;
    case 'mic-retry': S.trouble = null; openAudio().catch(() => setTrouble(TROUBLE.mic)); break;
    case 'to-review': S.trouble = null; finish(); return;
    case 'to-interview': go('interview'); S.fixOpen = false; draw(); return;
    default: return;
  }
  draw();
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (f) upload(f);
});

window.addEventListener('offline', () => { if (S.screen === 'interview') setTrouble(TROUBLE.net); });
/** True while answers exist that have not been saved yet. */
function interviewInProgress(): boolean {
  if (finishing || S.screen === 'setup' || S.screen === 'done') return false;
  return S.screen === 'interview' || Object.keys(S.answers).length > 0;
}

// Warn before the tab is closed or navigated away mid-interview.
window.addEventListener('beforeunload', (e) => {
  if (!interviewInProgress()) { send({ type: 'end' }); return; }
  e.preventDefault();
  e.returnValue = '';          // required for the browser to show its own confirm dialog
  return '';
});
// Actually ending: release the agent session (and stop billing) on real unload.
window.addEventListener('pagehide', () => { send({ type: 'end' }); });

// Browser / Android back: sheets close first, then follow the URL. Backing out of
// an interview that has answers goes to the check screen, never silently to setup.
window.addEventListener('popstate', () => {
  if (S.receiptOpen) { S.receiptOpen = false; draw(); return; }
  if (S.fixOpen) { S.fixOpen = false; draw(); return; }
  if (S.uploadOpen) { S.uploadOpen = false; draw(); return; }

  const target = screenFromUrl() || 'setup';
  const answered = Object.keys(S.answers).length > 0;

  if (target === 'setup' && answered && !finishing) { dropQueue(); go('review', true); draw(); return; }
  if (target !== 'interview') dropQueue();   // the agent must not keep talking off-screen
  S.screen = target;
  persist();
  draw();
});

fetch('/health').then((r) => r.json()).then((h) => { S.hasKey = !!h.hasKey; draw(); }).catch(() => draw());

restore();
draw();
