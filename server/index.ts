import { existsSync } from 'node:fs';
// Load .env before reading any config (Node 22+). No dependency needed.
if (existsSync(new URL('../.env', import.meta.url))) process.loadEnvFile(new URL('../.env', import.meta.url));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { demoForm, type Lang } from './form/definition.js';
import { Interview } from './form/interview.js';
import { sessionUpdate } from './agent.js';
import { submitToKobo } from './kobo.js';

const PORT = Number(process.env.PORT ?? 8787);
const AAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const AAI_WS = 'wss://agents.assemblyai.com/v1/ws';

const pretty = process.env.NODE_ENV !== 'production';
const app = Fastify({ logger: pretty ? { transport: { target: 'pino-pretty' } } : true });
await app.register(websocket);

app.get('/health', async () => ({ ok: true, hasKey: !!AAI_KEY }));

// One browser <-> one AssemblyAI session. The browser sends control JSON and base64
// mic audio; we forward audio to AAI, run tool calls against the Interview, and relay
// AAI's audio + transcripts + form updates back to the browser.
app.get('/ws', { websocket: true }, (browser /* WebSocket */) => {
  let lang: Lang = 'en';
  let iv = new Interview(demoForm, lang);
  let kobo: WebSocket | null = null;
  let submitted = false;
  // turn-latency instrumentation
  let userDoneAt = 0, toolCallAt = 0, toolResultAt = 0, replyStartedAt = 0, gotFirstAudio = true;
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
      case 'reply.started': replyStartedAt = Date.now(); break;
      case 'reply.done': if (ev.status === 'interrupted') toBrowser({ type: 'interrupted' }); break;
      case 'transcript.user.delta': toBrowser({ type: 'user_partial', text: ev.text }); break;
      case 'input.speech.stopped':
        userDoneAt = Date.now(); gotFirstAudio = false; toolCallAt = toolResultAt = replyStartedAt = 0;
        break;
      case 'transcript.user': toBrowser({ type: 'user', text: ev.text }); break;
      case 'transcript.agent': toBrowser({ type: 'agent', text: ev.text }); break;
      case 'session.error':
      case 'error': app.log.error(ev); toBrowser({ type: 'error', message: ev.message ?? 'agent error' }); break;
      case 'tool.call': await handleTool(ev); break;
    }
  });

  kobo!.on('close', () => toBrowser({ type: 'closed' }));
  kobo!.on('error', (e) => { app.log.error(e); toBrowser({ type: 'error', message: 'agent connection error' }); });
  }

  async function handleTool(ev: { call_id: string; name: string; arguments: any }) {
    toolCallAt = Date.now();
    let result: unknown;
    try {
      if (ev.name === 'get_next_question') {
        result = iv.next();
      } else if (ev.name === 'record_answer') {
        const r = iv.record(ev.arguments?.name, ev.arguments?.value);
        if (r.ok) { toBrowser({ type: 'answer', name: r.name, value: r.value, display: r.display, answers: iv.answers }); result = { ...r, next: iv.next() }; }
        else result = r;
      } else if (ev.name === 'skip_question') {
        const r = iv.skip(ev.arguments?.name);
        if (r.ok) { toBrowser({ type: 'answer', name: r.name, value: null, display: '(skipped)', answers: iv.answers }); result = { ...r, next: iv.next() }; }
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
    const uid = process.env.KOBO_ASSET_UID;
    if (!uid) { toBrowser({ type: 'submit', ok: false, message: 'KOBO_ASSET_UID not set' }); return; }
    try {
      const { instanceId } = await submitToKobo(uid, iv.submission());
      toBrowser({ type: 'submit', ok: true, instanceId });
    } catch (e) {
      toBrowser({ type: 'submit', ok: false, message: (e as Error).message });
    }
  }

  browser.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'start') {
      lang = (['en', 'hi', 'es'].includes(m.lang) ? m.lang : 'en') as Lang;
      iv = new Interview(demoForm, lang);
      openAgent();
    } else if (m.type === 'audio' && kobo?.readyState === 1) {
      kobo.send(JSON.stringify({ type: 'input.audio', audio: m.data }));
    } else if (m.type === 'end' && kobo?.readyState === 1) {
      kobo.send(JSON.stringify({ type: 'session.end' }));
    }
  });

  browser.on('close', () => { try { kobo?.close(); } catch {} });
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => app.log.info(`bridge on :${PORT}`));
