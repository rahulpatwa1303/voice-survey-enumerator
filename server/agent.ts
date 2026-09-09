// Inline Voice Agent session config. The agent conducts the survey ONLY through
// these tools and never invents questions. record_answer and skip_question return
// the next question inline, so the agent needs one tool call per turn (lower latency).
import type { Interview } from './form/interview.js';
import { langName, type Lang } from './form/definition.js';

export const tools = [
  {
    type: 'function',
    name: 'get_next_question',
    description: 'Return the first survey question. Call this once at the very start, right after consent is not needed. Returns the question, its choices, or done.',
    parameters: { type: 'object', properties: {}, required: [] },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'record_answer',
    description: "Record the respondent's answer to the CURRENT question. Returns whether it was accepted and, if so, the NEXT question to ask (or done). For choices pass the choice value or the words said; for numbers pass a number.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The question name you are answering.' },
        value: { description: 'The answer: string, number, or array of choice values.' },
      },
      required: ['name', 'value'],
    },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'skip_question',
    description: 'Skip the current question when it is optional and the respondent does not want to answer. Returns the next question (or done). Only works on optional questions.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The question name to skip.' } },
      required: ['name'],
    },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'finish',
    description: 'Call ONLY after get_next_question/record_answer reported done, you read the whole summary back, and the respondent confirmed it is correct.',
    parameters: { type: 'object', properties: {}, required: [] },
    execution_mode: 'interactive',
  },
] as const;

export function systemPrompt(lang: Lang): string {
  return [
    `You are a careful, warm health-survey interviewer. Speak ${langName[lang]}.`,
    `The respondent may reply in another language; understand them, but keep asking in ${langName[lang]} unless they ask you to switch.`,
    ``,
    `ABSOLUTE RULE: only ever ask questions that a tool gives you. Never invent, guess, reorder, or add a question. If you are unsure what to ask next, call get_next_question.`,
    ``,
    `Flow:`,
    `1. Call get_next_question. Ask exactly that question in simple, natural words; if it has choices, offer them.`,
    `2. When the respondent answers, call record_answer. Its result contains the NEXT question — ask that next. Do not call get_next_question again.`,
    `3. If record_answer returns ok=false, gently tell the respondent the reason and ask the SAME question again.`,
    `4. If a question is optional and the respondent wants to skip it, call skip_question; ask the next question it returns.`,
    `5. When a tool result says done=true, read the whole summary back slowly and ask "is everything correct?". If they fix something, call record_answer again. Only when they confirm, call finish.`,
    ``,
    `Ask one question at a time. Be brief. Give no medical advice. The first question is consent; if they decline, thank them warmly and stop.`,
  ].join('\n');
}

export function sessionUpdate(lang: Lang, greeting: string) {
  const voice = lang === 'es' ? 'anna' : 'anna'; // TODO day-14: per-language voice; test Hindi quality
  return {
    type: 'session.update',
    session: {
      system_prompt: systemPrompt(lang),
      greeting,
      input: { format: { encoding: 'audio/pcm' }, turn_detection: { interrupt_response: true } },
      output: { voice, format: { encoding: 'audio/pcm' } },
      tools,
    },
  };
}
