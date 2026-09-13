import { existsSync } from 'node:fs';
// Load .env before reading any config (Node 22+). No dependency needed.
if (existsSync(new URL('../.env', import.meta.url))) process.loadEnvFile(new URL('../.env', import.meta.url));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { demoForm, ensureConsent, pickLabel, type FormDefinition, type Lang } from './form/definition.js';
import { Interview } from './form/interview.js';
import { sessionUpdate } from './agent.js';
import { submitToKobo } from './kobo.js';
import { parseXlsform } from './form/xlsform.js';
import { Receipt } from './form/receipt.js';
import { randomUUID } from 'node:crypto';

// Uploaded forms live here between the HTTP upload and the WS session picking them up.
const uploads = new Map<string, { form: FormDefinition; languages: string[]; limitations: string[] }>();

const PORT = Number(process.env.PORT ?? 8787);
const AAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const AAI_WS = 'wss://agents.assemblyai.com/v1/ws';

const pretty = process.env.NODE_ENV !== 'production';
const app = Fastify({ logger: pretty ? { transport: { target: 'pino-pretty' } } : true });
await app.register(websocket);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

// In production one process serves the built front end and the WebSocket on the
// same origin, so the platform only has to expose a single port.
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir, index: ['index.html'] });
  // client-side routing: anything that is not a file or an API path gets the app
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url && (req.raw.url.startsWith('/ws') || req.raw.url.startsWith('/upload') || req.raw.url.startsWith('/health'))) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
  app.log.info('serving built client from ' + distDir);
}

app.get('/health', async () => ({ ok: true, hasKey: !!AAI_KEY }));

// Upload an XLSForm; returns an id the browser passes in its start message.
app.post('/upload', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
  try {
    const buf = req.body as Buffer;
    if (!buf || !buf.length) return reply.code(400).send({ error: 'empty body' });
    const parsed = parseXlsform(buf);
    parsed.form = ensureConsent(parsed.form);
    const id = randomUUID();
    uploads.set(id, parsed);
    const title = pickLabel(parsed.form.title, 'en');
    return { id, title, questions: parsed.form.questions.length, languages: parsed.languages, limitations: parsed.limitations };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

// One browser <-> one AssemblyAI session. The browser sends control JSON and base64
// mic audio; we forward audio to AAI, run tool calls against the Interview, and relay
// AAI's audio + transcripts + form updates back to the browser.
app.get('/ws', { websocket: true }, (browser /* WebSocket */) => {
  let lang: Lang = 'en';
  let activeForm: FormDefinition = demoForm;
  let iv = new Interview(activeForm, lang);
  let receipt = new Receipt(activeForm, lang);
  let kobo: WebSocket | null = null;
  let submitted = false;
  // turn-latency instrumentation
  let userDoneAt = 0, toolCallAt = 0, toolResultAt = 0, replyStartedAt = 0, gotFirstAudio = true;
  // conversation state so the UI can always say what is happening
  type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';
  let phase: Phase = 'idle';
  let stallTimer: NodeJS.Timeout | null = null;
  let nudged = false;
  const setPhase = (p: Phase) => { phase = p; toBrowser({ type: 'phase', phase: p }); };
  const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
  // If the agent goes quiet after the respondent's turn, nudge it once, then warn.
  function armStall() {
    clearStall();
    nudged = false;
    stallTimer = setTimeout(() => {
      if (phase !== 'thinking' || kobo?.readyState !== 1) return;
      nudged = true;
      toBrowser({ type: 'stalled', nudging: true });
      app.log.warn('agent stalled; nudging');
      kobo.send(JSON.stringify({ type: 'reply.create', instructions: 'Continue the interview: ask the current question again, briefly.' }));
      stallTimer = setTimeout(() => {
        if (phase === 'thinking') { toBrowser({ type: 'stalled', nudging: false }); app.log.error('agent still stalled after nudge'); }
      }, 8000);
    }, 6000);
  }
  const ms = (a: number, b: number) => (a && b ? `${b - a}ms` : '—');

  const toBrowser = (m: unknown) => { if (browser.readyState === 1) browser.send(JSON.stringify(m)); };

  if (!AAI_KEY) { toBrowser({ type: 'fatal', message: 'ASSEMBLYAI_API_KEY not set on server' }); return; }

  function openAgent() {
    kobo = new WebSocket(AAI_WS, { headers: { Authorization: `Bearer ${AAI_KEY}` } });
    kobo.on('open', () => kobo!.send(JSON.stringify(sessionUpdate(lang))));
    wireAgent();
  }

  function wireAgent() {
  kobo!.on('message', async (raw) => {
    const ev = JSON.parse(raw.toString());
    switch (ev.type) {
      case 'session.ready':
        toBrowser({ type: 'ready' });
        setPhase('thinking'); armStall();
        // Make the agent open the conversation itself (greet + first question),
        // instead of waiting for the respondent to speak first.
        kobo!.send(JSON.stringify({ type: 'reply.create', instructions: 'Begin the interview now: greet in one short sentence, then ask the first question.' }));
        break;
      case 'reply.audio':
        if (!gotFirstAudio && userDoneAt) {
          gotFirstAudio = true;
          const total = Date.now() - userDoneAt;
          const breakdown = {
            total,
            user_to_toolcall: toolCallAt ? toolCallAt - userDoneAt : null,
            tool_handling: toolCallAt && toolResultAt ? toolResultAt - toolCallAt : null,
            toolresult_to_reply: toolResultAt && replyStartedAt ? replyStartedAt - toolResultAt : null,
            reply_to_audio: replyStartedAt ? Date.now() - replyStartedAt : null,
          };
          app.log.info({ latency: breakdown }, 'turn latency');
          toBrowser({ type: 'latency', ...breakdown });
        }
        toBrowser({ type: 'audio', data: ev.data });
        break;
      case 'input.speech.started': setPhase('listening'); clearStall(); break;
      case 'reply.started': replyStartedAt = Date.now(); clearStall(); setPhase('speaking'); break;
      case 'reply.done': setPhase('idle'); if (ev.status === 'interrupted') toBrowser({ type: 'interrupted' }); break;
      case 'transcript.user.delta': toBrowser({ type: 'user_partial', text: ev.text }); break;
      case 'input.speech.stopped':
        setPhase('thinking'); armStall();
        userDoneAt = Date.now(); gotFirstAudio = false; toolCallAt = toolResultAt = replyStartedAt = 0;
        break;
      case 'transcript.user': receipt.respondentSaid(ev.text); toBrowser({ type: 'user', text: ev.text }); break;
      case 'transcript.agent': receipt.agentSaid(ev.text); toBrowser({ type: 'agent', text: ev.text }); break;
      case 'session.error':
      case 'error': app.log.error(ev); toBrowser({ type: 'error', message: ev.message ?? 'agent error' }); break;
      case 'tool.call': await handleTool(ev); break;
    }
  });

  kobo!.on('close', () => { clearStall(); setPhase('idle'); toBrowser({ type: 'closed' }); });
  kobo!.on('error', (e) => { app.log.error(e); toBrowser({ type: 'error', message: 'agent connection error' }); });
  }

  // The canonical question text from the form, so the UI never has to fall back to
  // the agent's chatty phrasing when showing an answer back to the enumerator.
  const questionLabel = (name: string) => {
    const q = activeForm.questions.find((x) => x.name === name);
    return q ? pickLabel(q.label, lang) : name;
  };

  async function handleTool(ev: { call_id: string; name: string; arguments: any }) {
    toolCallAt = Date.now();
    let result: unknown;
    try {
      if (ev.name === 'get_next_question') {
        result = iv.next();
      } else if (ev.name === 'record_answer') {
        const r = iv.record(ev.arguments?.name, ev.arguments?.value);
        if (r.ok) { receipt.answered(r.name, r.value, r.display); toBrowser({ type: 'answer', name: r.name, question: questionLabel(r.name), value: r.value, display: r.display, answers: iv.answers }); result = { ...r, next: iv.next() }; }
        else { receipt.rejected(ev.arguments?.name, ev.arguments?.value, r.message); result = r; }
      } else if (ev.name === 'skip_question') {
        const r = iv.skip(ev.arguments?.name);
        if (r.ok) { receipt.skippedQ(r.name); toBrowser({ type: 'answer', name: r.name, question: questionLabel(r.name), value: null, display: '(skipped)', answers: iv.answers }); result = { ...r, next: iv.next() }; }
        else result = r;
      } else if (ev.name === 'finish') {
        const f = iv.finish();
        result = f;
        if (f.ok && !submitted) { submitted = true; await submit(); }
      } else {
        result = { ok: false, message: `Unknown tool ${ev.name}` };
      }
    } catch (e) {
      result = { ok: false, message: (e as Error).message };
    }
    // tool.result must be a JSON-encoded string, sent after reply.done per the spec;
    // in practice replying immediately with the call_id works and keeps latency down.
    toolResultAt = Date.now();
    app.log.info({ tool: ev.name, handling_ms: toolResultAt - toolCallAt }, 'tool');
    kobo!.send(JSON.stringify({ type: 'tool.result', call_id: ev.call_id, result: JSON.stringify(result) }));
  }

  async function submit() {
    const record = iv.submission();
    const uid = process.env.KOBO_ASSET_UID;
    // Kobo submit only for the deployed demo form; uploaded forms aren't on Kobo yet
    // (that's week 3's token-connect), so hand the record back for download.
    if (activeForm === demoForm && uid) {
      try {
        const { instanceId } = await submitToKobo(uid, record);
        receipt.submitted(true, 'KoboToolbox', instanceId);
        toBrowser({ type: 'submit', ok: true, instanceId, record, receipt: receipt.toJSON(record), receiptText: receipt.toText(record) });
      } catch (e) {
        receipt.submitted(false, 'KoboToolbox', undefined, (e as Error).message);
        toBrowser({ type: 'submit', ok: false, message: (e as Error).message, record, receipt: receipt.toJSON(record), receiptText: receipt.toText(record) });
      }
    } else {
      receipt.submitted(true, 'download');
      toBrowser({ type: 'submit', ok: true, record, note: 'Downloaded (this form is not connected to Kobo yet).', receipt: receipt.toJSON(record), receiptText: receipt.toText(record) });
    }
  }

  browser.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'start') {
      const up = m.formId ? uploads.get(m.formId) : undefined;
      activeForm = up ? up.form : demoForm;
      lang = m.lang || (up?.languages?.[0]) || 'en';
      iv = new Interview(activeForm, lang);
      receipt = new Receipt(activeForm, lang);
      openAgent();
    } else if (m.type === 'audio' && kobo?.readyState === 1) {
      kobo.send(JSON.stringify({ type: 'input.audio', audio: m.data }));
    } else if (m.type === 'nudge' && kobo?.readyState === 1) {
      kobo.send(JSON.stringify({ type: 'reply.create', instructions: 'Continue the interview: ask the current question again, briefly.' }));
      setPhase('thinking'); armStall();
    } else if (m.type === 'end' && kobo?.readyState === 1) {
      kobo.send(JSON.stringify({ type: 'session.end' }));
    }
  });

  browser.on('close', () => { clearStall(); try { kobo?.close(); } catch {} });
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => app.log.info(`bridge on :${PORT}`));
