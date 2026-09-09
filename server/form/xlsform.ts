// Parse an uploaded XLSForm (.xlsx) into the FormDefinition the interview engine
// runs. Supports the common question types and the relevant/constraint subset in
// xpath.ts. Unsupported types load with a manual-entry marker; unsupported
// expressions are dropped and listed in `limitations` so we can be honest.
import * as XLSX from 'xlsx';
import type { Choice, FormDefinition, Labels, Question } from './definition.js';
import { compile } from './xpath.js';

const SUPPORTED = new Set(['text', 'integer', 'decimal', 'date', 'select_one', 'select_multiple', 'note', 'acknowledge']);

type Row = Record<string, any>;

function labelsFrom(row: Row, prefix: string): Labels {
  const out: Labels = {};
  for (const key of Object.keys(row)) {
    // "label", "label::English (en)", "label::Hindi (hi)"
    if (key === prefix) out.en = String(row[key]);
    else if (key.startsWith(prefix + '::')) {
      const m = /\(([a-zA-Z-]+)\)\s*$/.exec(key);         // pull the (en)/(hi) code
      const code = m ? m[1] : key.slice(prefix.length + 2).trim();
      out[code] = String(row[key]);
    }
  }
  return out;
}

export type ParseResult = { form: FormDefinition; languages: string[]; limitations: string[] };

export function parseXlsform(buf: Buffer | ArrayBuffer): ParseResult {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = (n: string) => (wb.Sheets[n] ? XLSX.utils.sheet_to_json<Row>(wb.Sheets[n], { defval: '' }) : []);
  const survey = sheet('survey');
  const choicesRows = sheet('choices');
  const settings = sheet('settings')[0] ?? {};
  if (!survey.length) throw new Error('No "survey" sheet found in this XLSForm.');

  const limitations: string[] = [];
  const langs = new Set<string>();

  // choices grouped by list_name
  const choiceLists = new Map<string, Choice[]>();
  for (const r of choicesRows) {
    const list = String(r.list_name ?? r['list name'] ?? '').trim();
    if (!list) continue;
    const label = labelsFrom(r, 'label');
    Object.keys(label).forEach((l) => langs.add(l));
    const arr = choiceLists.get(list) ?? [];
    arr.push({ name: String(r.name).trim(), label });
    choiceLists.set(list, arr);
  }

  const questions: Question[] = [];
  for (const r of survey) {
    const rawType = String(r.type ?? '').trim();
    if (!rawType || rawType === 'begin_group' || rawType === 'end_group' || rawType === 'start' || rawType === 'end' || rawType === 'today' || rawType === 'calculate' || rawType === 'hidden') continue;

    const [kind, listName] = rawType.split(/\s+/);
    const name = String(r.name ?? '').trim();
    if (!name) continue;
    const label = labelsFrom(r, 'label');
    Object.keys(label).forEach((l) => langs.add(l));

    if (rawType.startsWith('begin_repeat') || rawType.startsWith('end_repeat')) { limitations.push(`Repeat group "${name}" is not supported (asked as a single pass).`); continue; }

    const supported = SUPPORTED.has(kind);
    const q: Question = {
      name,
      type: (supported ? (kind === 'acknowledge' ? 'note' : kind) : 'text') as Question['type'],
      label,
      required: String(r.required ?? '').toLowerCase() === 'yes' || r.required === true,
      choices: (kind === 'select_one' || kind === 'select_multiple') ? choiceLists.get(listName) : undefined,
    };
    if (!supported) { q.unsupported = rawType; limitations.push(`Question "${name}" has unsupported type "${rawType}" — marked for manual entry.`); }

    const rel = String(r.relevant ?? '').trim();
    if (rel) {
      try { const f = compile(rel); q.relevant = (a) => f(a); }
      catch (e) { limitations.push(`Skip logic on "${name}" not supported (${(e as Error).message}); question always shown.`); }
    }
    const con = String(r.constraint ?? '').trim();
    if (con) {
      try {
        const f = compile(con);
        const msg = labelsFrom(r, 'constraint_message');
        q.constraint = { check: (v) => f({}, v), message: Object.keys(msg).length ? msg : { en: 'That value is not allowed.' } };
      } catch (e) { limitations.push(`Constraint on "${name}" not supported (${(e as Error).message}); not enforced.`); }
    }
    questions.push(q);
  }

  const languages = langs.size ? [...langs] : ['en'];
  const form: FormDefinition = {
    id: String(settings.form_id ?? settings.id_string ?? 'uploaded_form'),
    title: labelsFrom(settings, 'form_title').en ? labelsFrom(settings, 'form_title') : { en: String(settings.form_title ?? 'Survey') },
    questions,
  };
  return { form, languages, limitations };
}
