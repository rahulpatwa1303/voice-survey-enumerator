// Inline Voice Agent session config. The agent conducts the survey ONLY through
// these tools and never invents questions. record_answer/skip_question return the
// next question inline (one tool call per turn -> lower latency).
//
// TTS reality: the Voice Agent API SPEAKS 6 languages (en, es, fr, de, it, pt) but
// UNDERSTANDS 18. Hindi has no voice, so for 'hi' we understand Hindi input and
// reply in clear, simple English rather than mispronouncing Devanagari.
import type { Lang } from './form/definition.js';

type Spoken = { say: string; voice: string; understand?: string };
const PROFILE: Record<Lang, Spoken> = {
  en: { say: 'English', voice: 'mary' },
  es: { say: 'Spanish', voice: 'lola' },
  hi: { say: 'simple, clear English', voice: 'mary', understand: 'Hindi' },
};

export const tools = [
  {
    type: 'function', name: 'get_next_question',
    description: 'Return the first survey question. Call once at the very start. Returns the question, its choices, or done.',
    parameters: { type: 'object', properties: {}, required: [] }, execution_mode: 'interactive',
  },
  {
    type: 'function', name: 'record_answer',
    description: "Record the respondent's answer to the CURRENT question. Returns whether it was accepted and, if so, the NEXT question (or done). For choices pass the choice value or the words said; for numbers pass a number.",
    parameters: { type: 'object', properties: { name: { type: 'string' }, value: {} }, required: ['name', 'value'] },
    execution_mode: 'interactive',
  },
  {
    type: 'function', name: 'skip_question',
    description: 'Skip the CURRENT question when it is optional and the respondent does not want to answer. Returns the next question (or done). Only works on optional questions.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    execution_mode: 'interactive',
  },
  {
    type: 'function', name: 'finish',
    description: 'Call ONLY after a tool reported done, you read the summary back, and the respondent confirmed it is correct.',
    parameters: { type: 'object', properties: {}, required: [] }, execution_mode: 'interactive',
  },
] as const;

export function systemPrompt(lang: Lang): string {
  const p = PROFILE[lang];
  return [
    `You are a warm, patient community health worker running a short survey. You sound like a real person, not a form. Speak ${p.say}.`,
    p.understand ? `The respondent speaks ${p.understand}. Understand them fully, but always reply in ${p.say}.`
                 : `The respondent may slip into another language; understand them, but keep speaking ${p.say}.`,
    ``,
    `ABSOLUTE RULE: only ask questions a tool gives you. Never invent, guess, reorder, or add a question. If unsure what is next, call get_next_question.`,
    ``,
    `How to talk:`,
    `- Use short, natural sentences and contractions. A brief acknowledgement ("okay", "got it", "thank you") before the next question feels human. Do not over-apologise.`,
    `- Ask ONE question at a time. Offer the choices plainly when a question has them.`,
    `- Never give medical advice.`,
    ``,
    `Flow:`,
    `1. Call get_next_question and ask it.`,
    `2. On each answer, call record_answer; its result holds the NEXT question — ask that. Do NOT call get_next_question again.`,
    `3. If record_answer returns ok=false, warmly say why and ask the same question again.`,
    `4. If a question is optional and they want to skip, call skip_question and ask what it returns.`,
    `5. When a tool says done=true, briefly read the answers back and ask if everything's right. Fix with record_answer if needed. Only when they confirm, call finish.`,
    ``,
    `The first question is consent. If they decline, thank them warmly and stop.`,
  ].join('\n');
}

export function greetingFor(lang: Lang): string {
  return lang === 'es' ? 'Hola, soy del centro de salud. Le haré unas preguntas rápidas, ¿de acuerdo?'
    : lang === 'hi' ? 'Namaste. I am from the health centre and I will ask you a few quick questions. You can answer in Hindi.'
    : "Hi there, I'm from the health centre. I'd like to ask you a few quick questions, is that alright?";
}

export function sessionUpdate(lang: Lang) {
  return {
    type: 'session.update',
    session: {
      system_prompt: systemPrompt(lang),
      greeting: greetingFor(lang),
      input: {
        format: { encoding: 'audio/pcm' },
        // snappier turns: react to speech sooner, need less trailing silence
        turn_detection: { vad_threshold: 0.35, min_silence: 500, max_silence: 1500, interrupt_response: true },
      },
      output: { voice: PROFILE[lang].voice, format: { encoding: 'audio/pcm' } },
      tools,
    },
  };
}
