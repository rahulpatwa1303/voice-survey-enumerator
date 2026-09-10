// An interview receipt: the verifiable record of HOW a submission came to be.
// Every question asked, what the respondent actually said (verbatim), what was
// recorded, what was rejected and why, what was skipped, and which XLSForm rule
// caused each of those. A supervisor can read this and check any single value.
//
// Note: the Voice Agent API does not expose a per-word confidence score, so we
// record the verbatim transcript rather than inventing a number.
import type { FormDefinition, Question } from './definition.js';
import { pickLabel } from './definition.js';

export type ReceiptEvent =
  | { t: 'agent'; at: string; text: string }
  | { t: 'respondent'; at: string; text: string }
  | { t: 'answer'; at: string; name: string; question: string; value: unknown; display: string; heard: string | null; shownBecause?: string; validatedBy?: string }
  | { t: 'rejected'; at: string; name: string; question: string; attempted: unknown; heard: string | null; reason: string; rule?: string }
  | { t: 'skipped'; at: string; name: string; question: string; heard: string | null }
  | { t: 'submitted'; at: string; ok: boolean; destination: string; instanceId?: string; message?: string };

export class Receipt {
  readonly startedAt = new Date().toISOString();
  readonly events: ReceiptEvent[] = [];
  /** Last thing the respondent was heard to say, attached to the next answer. */
  private lastHeard: string | null = null;

  constructor(private form: FormDefinition, private lang: string) {}

  private now() { return new Date().toISOString(); }
  private q(name: string): Question | undefined { return this.form.questions.find((x) => x.name === name); }
  private label(name: string) { const q = this.q(name); return q ? pickLabel(q.label, this.lang) : name; }

  agentSaid(text: string) { this.events.push({ t: 'agent', at: this.now(), text }); }
  respondentSaid(text: string) { this.lastHeard = text; this.events.push({ t: 'respondent', at: this.now(), text }); }

  answered(name: string, value: unknown, display: string) {
    const q = this.q(name);
    this.events.push({
      t: 'answer', at: this.now(), name, question: this.label(name), value, display,
      heard: this.lastHeard, shownBecause: q?.relevantSrc, validatedBy: q?.constraintSrc,
    });
    this.lastHeard = null;
  }
  rejected(name: string, attempted: unknown, reason: string) {
    this.events.push({ t: 'rejected', at: this.now(), name, question: this.label(name), attempted, heard: this.lastHeard, reason, rule: this.q(name)?.constraintSrc });
  }
  skippedQ(name: string) {
    this.events.push({ t: 'skipped', at: this.now(), name, question: this.label(name), heard: this.lastHeard });
    this.lastHeard = null;
  }
  submitted(ok: boolean, destination: string, instanceId?: string, message?: string) {
    this.events.push({ t: 'submitted', at: this.now(), ok, destination, instanceId, message });
  }

  /** Machine-readable receipt to store or attach to the record. */
  toJSON(answers: Record<string, unknown>) {
    const asked = this.events.filter((e) => e.t === 'answer').length;
    const retries = this.events.filter((e) => e.t === 'rejected').length;
    return {
      form: { id: this.form.id, title: pickLabel(this.form.title, this.lang) },
      language: this.lang,
      startedAt: this.startedAt,
      finishedAt: this.now(),
      summary: { answered: asked, skipped: this.events.filter((e) => e.t === 'skipped').length, corrections: retries },
      answers,
      events: this.events,
    };
  }

  /** Short human-readable version for the enumerator/supervisor. */
  toText(answers: Record<string, unknown>): string {
    const lines: string[] = [`Interview receipt — ${pickLabel(this.form.title, this.lang)} (${this.lang})`, `Started ${this.startedAt}`, ''];
    for (const e of this.events) {
      if (e.t === 'answer') {
        lines.push(`✓ ${e.question}`);
        lines.push(`    recorded: ${e.display}`);
        if (e.heard) lines.push(`    heard: "${e.heard}"`);
        if (e.shownBecause) lines.push(`    asked because: ${e.shownBecause}`);
        if (e.validatedBy) lines.push(`    checked against: ${e.validatedBy}`);
      } else if (e.t === 'rejected') {
        lines.push(`✗ ${e.question} — rejected "${String(e.attempted)}": ${e.reason}${e.rule ? ` (rule ${e.rule})` : ''}`);
      } else if (e.t === 'skipped') {
        lines.push(`– ${e.question} — skipped (optional)`);
      } else if (e.t === 'submitted') {
        lines.push('', e.ok ? `Submitted to ${e.destination}${e.instanceId ? ` as ${e.instanceId}` : ''}` : `Submission failed: ${e.message}`);
      }
    }
    return lines.join('\n');
  }
}
