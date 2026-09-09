// Drives the Interview state machine as the agent would, no audio, no network.
// Verifies skip logic, constraint rejection+retry, and the Kobo submission shape.
import { demoForm } from '../server/form/definition.js';
import { Interview } from '../server/form/interview.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log((c ? '✓' : '✗') + ' ' + m); };

const iv = new Interview(demoForm, 'en');

const q0 = iv.next(); ok(!q0.done && q0.name === 'consent', 'first question is consent');
iv.record('consent', 'yes');
const q1 = iv.next(); ok(!q1.done && q1.name === 'respondent_name', 'then name');
iv.record('respondent_name', 'Meera');
ok(iv.record('age', 12).ok === false, 'age 12 rejected by constraint');
ok(iv.record('age', 'twenty eight').ok === false, 'non-numeric age rejected');
ok(iv.record('age', 28).ok === true, 'age 28 accepted');

// not pregnant -> pregnancy questions skipped
iv.record('pregnant', 'no');
const q2 = iv.next(); ok(!q2.done && q2.name === 'children_under5', 'pregnancy questions skipped when not pregnant');

// change answer -> relevance re-opens skipped questions
iv.record('pregnant', 'yes');
const q3 = iv.next(); ok(!q3.done && q3.name === 'months_pregnant', 'changing to pregnant re-opens months');
ok(iv.record('months_pregnant', 10).ok === false, 'months 10 rejected');
iv.record('months_pregnant', 5);
iv.record('anc_visits', '1 to 3');            // label match
ok(iv.answers.anc_visits === 'one_to_three', 'choice matched by label');
iv.record('children_under5', 1);
iv.record('symptoms', 'fever and headache');  // multi
ok(Array.isArray(iv.answers.symptoms) && (iv.answers.symptoms as string[]).length === 2, 'select_multiple parsed two');
iv.record('next_visit', '2026-10-15');

ok(iv.next().done === true, 'interview reports done');
ok(iv.finish().ok === true, 'finish succeeds when complete');

const sub = iv.submission();
ok(!('consent' in sub), 'consent excluded from submission');
ok(sub.symptoms === 'fever headache', 'multi joined for Kobo');
ok(sub.pregnant === 'yes' && sub.months_pregnant === 5, 'submission carries answers');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
