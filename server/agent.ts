// Inline Voice Agent session config. The agent conducts the survey ONLY through
// these tools and never invents questions. record_answer/skip_question return the
// next question inline (one tool call per turn -> lower latency).
//
// TTS reality: the Voice Agent API SPEAKS 6 languages (en, es, fr, de, it, pt) but
// UNDERSTANDS 18. Hindi has no voice, so for 'hi' we understand Hindi input and
// reply in clear, simple English rather than mispronouncing Devanagari.
import type { Lang } from './form/definition.js';

type Spoken = { say: string; voice: string; understand?: string };
const NAMES: Record<string, string> = { hi: 'Hindi', ar: 'Arabic', ja: 'Japanese', zh: 'Mandarin', vi: 'Vietnamese', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese' };
const SPOKEN: Record<string, Spoken> = {
  en: { say: 'English', voice: 'mary' },
  es: { say: 'Spanish', voice: 'lola' },
  fr: { say: 'French', voice: 'estelle' },
  de: { say: 'German', voice: 'juergen' },
  it: { say: 'Italian', voice: 'giovanni' },
  pt: { say: 'Portuguese', voice: 'rafael' },
};
// The Voice Agent API SPEAKS these 6. For any other language, understand it but reply in English.
function profile(lang: Lang): Spoken {
  if (SPOKEN[lang]) return SPOKEN[lang];
  return { say: 'simple, clear English', voice: 'mary', understand: NAMES[lang] ?? 'their language' };
}

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

export function systemPrompt(lang: Lang, today: string): string {
  const p = profile(lang);
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
    `- Hold ONE consistent voice for the whole interview. Form questions are written to be read on a screen, so say them the way a person would say them out loud — but never change what is being asked: keep the exact meaning, every condition, and every answer choice. Do not weld a casual greeting onto a stiff written sentence; make the whole turn sound like one person talking.`,
    `- Never give medical advice.`,
    `- Today is ${today}. For any date question, work out the actual calendar date the respondent means ("tomorrow", "next Monday", "in two weeks", "the 3rd") and pass it to record_answer as YYYY-MM-DD. Do not ask them to say the date digit by digit.`,
    ``,
    `Flow:`,
    `1. To begin: introduce yourself in ONE short, warm sentence (who you are and why you are here), take a beat, then call get_next_question and ask that first question in your own natural spoken words. Do not wait for the respondent to speak first.`,
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
      system_prompt: systemPrompt(lang, new Date().toISOString().slice(0, 10)),
      input: {
        format: { encoding: 'audio/pcm' },
        // snappier turns: react to speech sooner, need less trailing silence
        // Push-to-talk means the respondent's release already signals turn end, so we
        // need only a short silence confirmation. This is the main felt-latency lever.
        turn_detection: { vad_threshold: 0.3, min_silence: 200, max_silence: 1000, interrupt_response: true },
      },
      output: { voice: profile(lang).voice, format: { encoding: 'audio/pcm' } },
      tools,
    },
  };
}
