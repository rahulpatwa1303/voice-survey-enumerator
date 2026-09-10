// The receipt must be a verifiable trail: verbatim speech, the recorded value,
// the rule that caused a question to be asked, the rule that rejected a value.
import { demoForm } from '../server/form/definition.js';
import { Interview } from '../server/form/interview.js';
import { Receipt } from '../server/form/receipt.js';

let pass=0, fail=0; const ok=(c:boolean,m:string)=>{c?pass++:fail++;console.log((c?'✓':'✗')+' '+m);};

const iv = new Interview(demoForm, 'en');
const r = new Receipt(demoForm, 'en');
const answer = (n: string, v: unknown) => { const res = iv.record(n, v); res.ok ? r.answered(res.name, res.value, res.display) : r.rejected(n, v, res.message); return res; };

r.respondentSaid('Yes that is fine'); answer('consent','yes');
r.respondentSaid('Meera Devi'); answer('respondent_name','Meera Devi');
r.respondentSaid('I am twelve'); answer('age',12);
r.respondentSaid('Sorry, twenty eight'); answer('age',28);
r.respondentSaid('Yes'); answer('pregnant','yes');
r.respondentSaid('Five months'); answer('months_pregnant',5);
r.respondentSaid('About two'); answer('anc_visits','1 to 3');
r.respondentSaid('Just one'); answer('children_under5',1);
r.respondentSaid('Fever and headache'); answer('symptoms','fever and headache');
r.respondentSaid('I would rather not say'); if (iv.skip('next_visit').ok) r.skippedQ('next_visit');
r.submitted(true,'KoboToolbox','uuid:demo-1234');

const j = r.toJSON(iv.submission()) as any;
const text = r.toText(iv.submission());
const ev = j.events;

ok(j.summary.answered === 8 && j.summary.skipped === 1 && j.summary.corrections === 1, 'summary counts answered/skipped/corrections');
const rej = ev.find((e: any) => e.t === 'rejected');
ok(rej?.reason?.includes('between 15 and 60') && rej.rule === '. >= 15 and . <= 60', 'rejection cites the constraint rule');
const months = ev.find((e: any) => e.t === 'answer' && e.name === 'months_pregnant');
ok(months?.shownBecause === "${pregnant} = 'yes'", 'answer cites why the question was asked');
ok(months?.validatedBy === '. >= 1 and . <= 9', 'answer cites the constraint it passed');
const anc = ev.find((e: any) => e.t === 'answer' && e.name === 'anc_visits');
ok(anc?.heard === 'About two' && anc?.display === '1 to 3', 'verbatim speech kept beside the interpreted choice');
ok(ev.some((e: any) => e.t === 'skipped' && e.name === 'next_visit'), 'skip recorded');
ok(ev.some((e: any) => e.t === 'submitted' && e.instanceId === 'uuid:demo-1234'), 'submission recorded');
ok(text.includes('asked because:') && text.includes('checked against:'), 'text receipt cites rules');
ok(!('consent' in j.answers), 'consent stays out of the submitted answers');

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
