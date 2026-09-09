// Inline Voice Agent session config: the tools the agent may call and the prompt
// that makes it conduct the survey one field at a time. The agent NEVER invents
// questions; it asks whatever get_next_question returns.
import type { Interview } from './form/interview.js';
import { langName, type Lang } from './form/definition.js';

export const tools = [
  {
    type: 'function',
    name: 'get_next_question',
    description: 'Return the next survey question to ask, its answer choices, or that the interview is complete. Call this before every question and after every record_answer.',
    parameters: { type: 'object', properties: {}, required: [] },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'record_answer',
    description: "Record the respondent's answer to the current question. For choice questions pass the choice value or the words the respondent said; for numbers pass a number.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The question name from get_next_question.' },
        value: { description: 'The answer: a string, number, or array of choice values.' },
      },
      required: ['name', 'value'],
    },
    execution_mode: 'interactive',
  },
  {
    type: 'function',
    name: 'finish',
    description: 'Call after you have read back all answers and the respondent confirmed they are correct.',
    parameters: { type: 'object', properties: {}, required: [] },
    execution_mode: 'interactive',
  },
] as const;

export function systemPrompt(iv: Interview, lang: Lang): string {
  return [
    `You are a careful, warm health-survey interviewer. Speak ${langName[lang]} by default.`,
    `The respondent may answer in another language; understand them, but ask questions in ${langName[lang]} unless they ask you to switch.`,
    `Conduct the survey strictly through the tools. Never invent, reorder, or skip questions yourself.`,
    ``,
    `Loop: call get_next_question. Ask exactly that question in your own natural, simple words; if it has choices, offer them. Wait for the answer. Call record_answer with it.`,
    `If record_answer returns ok=false, tell the respondent the reason gently and ask again. Do not move on until it returns ok=true.`,
    `When get_next_question says done, read the whole summary back slowly and ask "is everything correct?". If they correct something, call record_answer again. Only when they confirm, call finish.`,
    `Ask one question at a time. Keep it brief. Do not give medical advice.`,
    `The first question is a consent question; if they decline, thank them and stop.`,
  ].join('\n');
}

export function sessionUpdate(iv: Interview, lang: Lang, greeting: string) {
  return {
    type: 'session.update',
    session: {
      system_prompt: systemPrompt(iv, lang),
      greeting,
      input: { format: { encoding: 'audio/pcm' }, turn_detection: { interrupt_response: true } },
      output: { voice: 'anna', format: { encoding: 'audio/pcm' } },
      tools,
    },
  };
}
