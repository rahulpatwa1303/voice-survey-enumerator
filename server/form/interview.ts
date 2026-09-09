import type { Answers, FormDefinition, Lang, Question } from './definition.js';

export type RecordResult =
  | { ok: true; name: string; value: unknown; display: string }
  | { ok: false; name: string; message: string };

export type NextQuestion =
  | { done: false; name: string; type: Question['type']; question: string; choices?: { value: string; label: string }[]; required: boolean }
  | { done: true; summary: string };

/** One respondent's pass through a form: answers, skip logic, validation, read-back. */
export class Interview {
  readonly answers: Answers = {};
  private confirmed = false;

  constructor(readonly form: FormDefinition, readonly lang: Lang) {}

  isRelevant(q: Question) {
    return q.relevant ? q.relevant(this.answers) : true;
  }

  /** First relevant, unanswered question, or the read-back once everything is answered. */
  next(): NextQuestion {
    for (const q of this.form.questions) {
      if (!this.isRelevant(q)) continue;
      if (q.name in this.answers) continue;
      return {
        done: false,
        name: q.name,
        type: q.type,
        question: q.label[this.lang],
        required: q.required !== false,
        choices: q.choices?.map((c) => ({ value: c.name, label: c.label[this.lang] })),
      };
    }
    return { done: true, summary: this.summary() };
  }

  record(name: string, raw: unknown): RecordResult {
    const q = this.form.questions.find((x) => x.name === name);
    if (!q) return { ok: false, name, message: `Unknown question "${name}". Call get_next_question.` };
    if (!this.isRelevant(q)) return { ok: false, name, message: `"${name}" is not asked for this respondent.` };

    const parsed = this.parse(q, raw);
    if (!parsed.ok) return { ok: false, name, message: parsed.message };
    if (q.constraint && !q.constraint.check(parsed.value)) {
      return { ok: false, name, message: q.constraint.message[this.lang] };
    }

    this.answers[name] = parsed.value;
    // A changed answer can change what is relevant; drop answers to questions that no longer apply.
    for (const other of this.form.questions) {
      if (other.name in this.answers && !this.isRelevant(other)) delete this.answers[other.name];
    }
    this.confirmed = false;
    return { ok: true, name, value: parsed.value, display: this.display(q, parsed.value) };
  }

  /** Called from the `finish` tool after the respondent confirms the read-back. */
  finish(): { ok: boolean; message: string } {
    const pending = this.next();
    if (!pending.done) return { ok: false, message: `Not finished: "${pending.name}" is still unanswered.` };
    this.confirmed = true;
    return { ok: true, message: 'Interview complete.' };
  }

  get isConfirmed() { return this.confirmed; }

  /** Answers destined for Kobo (drops local-only questions like consent). */
  submission(): Answers {
    const out: Answers = {};
    for (const q of this.form.questions) {
      if (q.local || !(q.name in this.answers)) continue;
      const v = this.answers[q.name];
      out[q.name] = Array.isArray(v) ? v.join(' ') : v;
    }
    return out;
  }

  summary(): string {
    const lines: string[] = [];
    for (const q of this.form.questions) {
      if (q.local || !(q.name in this.answers)) continue;
      lines.push(`${q.label[this.lang]} ${this.display(q, this.answers[q.name])}`);
    }
    return lines.join('\n');
  }

  private display(q: Question, v: unknown): string {
    const labelOf = (name: string) => q.choices?.find((c) => c.name === name)?.label[this.lang] ?? name;
    if (Array.isArray(v)) return v.map((x) => labelOf(String(x))).join(', ');
    if (q.type === 'select_one') return labelOf(String(v));
    return String(v);
  }

  private parse(q: Question, raw: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
    const s = String(raw ?? '').trim();
    switch (q.type) {
      case 'text':
        return s ? { ok: true, value: s } : { ok: false, message: 'Empty answer.' };
      case 'integer': {
        const n = typeof raw === 'number' ? raw : Number(s.replace(/[^\d-]/g, ''));
        return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, message: 'Please give a whole number.' };
      }
      case 'decimal': {
        const n = typeof raw === 'number' ? raw : Number(s);
        return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: 'Please give a number.' };
      }
      case 'date':
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { ok: true, value: s } : { ok: false, message: 'Give the date as YYYY-MM-DD.' };
      case 'select_one': {
        const m = this.matchChoice(q, s);
        return m ? { ok: true, value: m } : { ok: false, message: `Answer must be one of: ${q.choices!.map((c) => c.label[this.lang]).join(', ')}.` };
      }
      case 'select_multiple': {
        const parts = Array.isArray(raw) ? raw.map(String) : s.split(/[,;]|\s+and\s+|\s+/).filter(Boolean);
        const matched = [...new Set(parts.map((p) => this.matchChoice(q, p)).filter((x): x is string => !!x))];
        if (!matched.length) return { ok: false, message: `Answer must be from: ${q.choices!.map((c) => c.label[this.lang]).join(', ')}.` };
        return { ok: true, value: matched.includes('none') ? ['none'] : matched };
      }
      case 'note':
        return { ok: true, value: true };
    }
  }

  /** Accept the choice name or its label in any language, case-insensitively. */
  private matchChoice(q: Question, s: string): string | undefined {
    const t = s.trim().toLowerCase();
    if (!t) return undefined;
    for (const c of q.choices ?? []) {
      if (c.name.toLowerCase() === t) return c.name;
      for (const l of Object.values(c.label)) if (l.toLowerCase() === t) return c.name;
    }
    return undefined;
  }
}
