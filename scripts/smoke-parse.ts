// Parser + xpath-subset checks against a real XLSForm.
import { readFileSync } from 'node:fs';
import { parseXlsform } from '../server/form/xlsform.js';
import { ensureConsent } from '../server/form/definition.js';
import { Interview } from '../server/form/interview.js';
import { compile } from '../server/form/xpath.js';

let pass=0, fail=0; const ok=(c:boolean,m:string)=>{c?pass++:fail++;console.log((c?'✓':'✗')+' '+m);};

// xpath subset
ok(compile("${p} = 'yes'")({p:'yes'}) === true, "equality on choice");
ok(compile(". >= 15 and . <= 60")({}, 28) === true && compile(". >= 15 and . <= 60")({}, 12) === false, "range constraint");
ok(compile("selected(${s}, 'fever')")({s:['fever','headache']}) === true, "selected() on multi");
ok(compile("${a} = 'x' or ${b} = 'y'")({b:'y'}) === true, "or");
let threw=false; try { compile("count(${x}) > 2"); } catch { threw=true; } ok(threw, "unsupported expr throws (so parser can drop+report)");

// parse the maternal form + run it
const { form, languages, limitations } = parseXlsform(readFileSync('forms/maternal_followup_v1.xlsx'));
ok(limitations.length === 0, "maternal form: no limitations");
ok(languages.join(',') === 'en,hi,es', "maternal form: en,hi,es");
const withC = ensureConsent(form);
ok(withC.questions[0].name === 'consent', "consent injected first");
const iv = new Interview(withC, 'es');
iv.record('consent','yes'); iv.record('respondent_name','Ana'); iv.record('age',30); iv.record('pregnant','no');
ok(!iv.next().done && (iv.next() as any).name === 'children_under5', "es run: skip logic works");

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
