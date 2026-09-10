// A form definition the interview runs over. Hand-built from forms/maternal_followup_v1.xlsx
// for week 1; week 2 replaces this with a parser so any XLSForm produces the same shape.

export type Lang = string;               // ISO-ish code; form decides which exist
export type Labels = Record<string, string>;

/** Pick a label in the requested language, falling back to en, then any. */
export function pickLabel(labels: Labels, lang: string): string {
  return labels[lang] ?? labels.en ?? labels[Object.keys(labels)[0]] ?? '';
}
export type Answers = Record<string, unknown>;

export type Choice = { name: string; label: Labels };

export type Question = {
  name: string;
  type: 'text' | 'integer' | 'decimal' | 'date' | 'select_one' | 'select_multiple' | 'note';
  label: Labels;
  required?: boolean;
  choices?: Choice[];
  /** XLSForm `relevant`: ask only when this returns true. */
  relevant?: (a: Answers) => boolean;
  /** Raw `relevant` expression, cited in the receipt. */
  relevantSrc?: string;
  /** XLSForm `constraint` + `constraint_message`. */
  constraint?: { check: (v: unknown) => boolean; message: Labels };
  /** Raw `constraint` expression, cited in the receipt. */
  constraintSrc?: string;
  /** Not sent to Kobo (e.g. consent). */
  local?: boolean;
  /** Set when the XLSForm type isn't voice-supported; enumerator fills manually. */
  unsupported?: string;
};

export type FormDefinition = {
  id: string;
  title: Labels;
  questions: Question[];
};

const yesNo: Choice[] = [
  { name: 'yes', label: { en: 'Yes', hi: 'हाँ', es: 'Sí' } },
  { name: 'no', label: { en: 'No', hi: 'नहीं', es: 'No' } },
];

const between = (lo: number, hi: number) => (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export const demoForm: FormDefinition = {
  id: 'maternal_followup_v1',
  title: { en: 'Maternal Health Follow-up', hi: 'मातृ स्वास्थ्य फ़ॉलो-अप', es: 'Seguimiento de salud materna' },
  questions: [
    {
      name: 'consent', type: 'select_one', required: true, local: true, choices: yesNo,
      label: {
        en: 'This conversation is recorded and written down for the health survey. Is that okay with you?',
        hi: 'यह बातचीत स्वास्थ्य सर्वे के लिए रिकॉर्ड और लिखी जाएगी। क्या आप इसके लिए सहमत हैं?',
        es: 'Esta conversación se graba y se anota para la encuesta de salud. ¿Está de acuerdo?',
      },
    },
    {
      name: 'respondent_name', type: 'text', required: true,
      label: { en: 'What is your full name?', hi: 'आपका पूरा नाम क्या है?', es: '¿Cuál es su nombre completo?' },
    },
    {
      name: 'age', type: 'integer', required: true,
      label: { en: 'How old are you?', hi: 'आपकी उम्र क्या है?', es: '¿Cuántos años tiene?' },
      constraintSrc: '. >= 15 and . <= 60', constraint: { check: between(15, 60), message: { en: 'Age must be between 15 and 60', hi: 'उम्र 15 और 60 के बीच होनी चाहिए', es: 'La edad debe estar entre 15 y 60' } },
    },
    {
      name: 'pregnant', type: 'select_one', required: true, choices: yesNo,
      label: { en: 'Are you currently pregnant?', hi: 'क्या आप अभी गर्भवती हैं?', es: '¿Está embarazada actualmente?' },
    },
    {
      name: 'months_pregnant', type: 'integer', required: true,
      relevant: (a) => a.pregnant === 'yes', relevantSrc: "${pregnant} = 'yes'",
      label: { en: 'How many months pregnant are you?', hi: 'आप कितने महीने की गर्भवती हैं?', es: '¿Cuántos meses de embarazo tiene?' },
      constraintSrc: '. >= 1 and . <= 9', constraint: { check: between(1, 9), message: { en: 'Months must be between 1 and 9', hi: 'महीने 1 और 9 के बीच होने चाहिए', es: 'Los meses deben estar entre 1 y 9' } },
    },
    {
      name: 'anc_visits', type: 'select_one', required: true,
      relevant: (a) => a.pregnant === 'yes', relevantSrc: "${pregnant} = 'yes'",
      label: { en: 'How many antenatal check-ups have you had?', hi: 'आपने कितनी प्रसव-पूर्व जाँचें कराई हैं?', es: '¿Cuántos controles prenatales ha tenido?' },
      choices: [
        { name: 'none', label: { en: 'None', hi: 'कोई नहीं', es: 'Ninguno' } },
        { name: 'one_to_three', label: { en: '1 to 3', hi: '1 से 3', es: '1 a 3' } },
        { name: 'four_plus', label: { en: '4 or more', hi: '4 या अधिक', es: '4 o más' } },
      ],
    },
    {
      name: 'children_under5', type: 'integer', required: true,
      label: { en: 'How many children under five live with you?', hi: 'आपके साथ पाँच साल से कम उम्र के कितने बच्चे रहते हैं?', es: '¿Cuántos niños menores de cinco años viven con usted?' },
      constraintSrc: '. >= 0 and . <= 15', constraint: { check: between(0, 15), message: { en: 'Please give a number between 0 and 15', hi: 'कृपया 0 और 15 के बीच की संख्या बताएं', es: 'Indique un número entre 0 y 15' } },
    },
    {
      name: 'symptoms', type: 'select_multiple', required: true,
      label: { en: 'Have you had any of these in the last two weeks?', hi: 'पिछले दो हफ्तों में क्या आपको इनमें से कुछ हुआ?', es: '¿Ha tenido alguno de estos en las últimas dos semanas?' },
      choices: [
        { name: 'fever', label: { en: 'Fever', hi: 'बुखार', es: 'Fiebre' } },
        { name: 'bleeding', label: { en: 'Bleeding', hi: 'रक्तस्राव', es: 'Sangrado' } },
        { name: 'headache', label: { en: 'Severe headache', hi: 'तेज़ सिरदर्द', es: 'Dolor de cabeza fuerte' } },
        { name: 'none', label: { en: 'None of these', hi: 'इनमें से कोई नहीं', es: 'Ninguno de estos' } },
      ],
    },
    {
      name: 'next_visit', type: 'date', required: false,
      label: { en: 'When is your next health visit?', hi: 'आपकी अगली स्वास्थ्य जाँच कब है?', es: '¿Cuándo es su próxima visita de salud?' },
    },
  ],
};

export const langName: Record<Lang, string> = { en: 'English', hi: 'Hindi', es: 'Spanish' };


/** A recording-consent question in whatever of our known languages apply. Always
 *  local (never submitted). Prepended to any form that doesn't already start with it. */
export function consentQuestion(): Question {
  return {
    name: 'consent', type: 'select_one', required: true, local: true,
    choices: [
      { name: 'yes', label: { en: 'Yes', hi: 'हाँ', es: 'Sí' } },
      { name: 'no', label: { en: 'No', hi: 'नहीं', es: 'No' } },
    ],
    label: {
      en: 'This conversation is recorded and written down for the survey. Is that okay with you?',
      hi: 'यह बातचीत सर्वे के लिए रिकॉर्ड और लिखी जाएगी। क्या आप सहमत हैं?',
      es: 'Esta conversación se graba y se anota para la encuesta. ¿Está de acuerdo?',
    },
  };
}

export function ensureConsent(form: FormDefinition): FormDefinition {
  if (form.questions[0]?.name === 'consent') return form;
  return { ...form, questions: [consentQuestion(), ...form.questions] };
}
