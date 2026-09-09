// A small evaluator for the XLSForm expression subset we support in relevant/
// constraint columns. Documented and deliberately partial:
//   ${field}                 -> the answer for that field
//   .                        -> the current answer (constraint context)
//   = != < <= > >=           -> comparison (XLSForm uses single '=')
//   and / or                 -> boolean
//   ( )                      -> grouping
//   selected(${f}, 'x')      -> is 'x' among a select_multiple answer
//   numbers, 'strings'       -> literals
// Anything outside this subset throws Unsupported; the parser then drops the
// rule and records it as a limitation rather than silently misbehaving.

export type Answers = Record<string, unknown>;
type Tok = { t: string; v?: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(\$\{[^}]+\}|selected|>=|<=|!=|=|<|>|\(|\)|,|and\b|or\b|'[^']*'|"[^"]*"|-?\d+\.?\d*|\.)/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { if (src.slice(i).trim() === '') break; throw new Error(`Unsupported token near "${src.slice(i, i + 12)}"`); }
    i = re.lastIndex;
    const raw = m[1];
    if (raw === 'and' || raw === 'or') out.push({ t: raw });
    else if (raw === 'selected') out.push({ t: 'fn', v: 'selected' });
    else if (/^\$\{/.test(raw)) out.push({ t: 'field', v: raw.slice(2, -1) });
    else if (/^['"]/.test(raw)) out.push({ t: 'str', v: raw.slice(1, -1) });
    else if (raw === '.') out.push({ t: 'dot' });
    else if (/^-?\d/.test(raw)) out.push({ t: 'num', v: raw });
    else out.push({ t: raw });
  }
  return out;
}

// Recursive-descent: or > and > comparison > primary
export function compile(expr: string): (a: Answers, current?: unknown) => boolean {
  const toks = lex(expr);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t?: string) => { const x = toks[p++]; if (t && (!x || x.t !== t)) throw new Error(`Expected ${t}`); return x; };

  type N = (a: Answers, c?: unknown) => unknown;

  function primary(): N {
    const x = peek();
    if (!x) throw new Error('Unexpected end');
    if (x.t === '(') { eat('('); const e = orExpr(); eat(')'); return e; }
    if (x.t === 'fn') { // selected(${f}, 'v')
      eat('fn'); eat('('); const f = eat('field').v!; eat(','); const v = eat('str').v!; eat(')');
      return (a) => { const val = a[f]; return Array.isArray(val) ? val.map(String).includes(v) : String(val) === v; };
    }
    if (x.t === 'field') { eat('field'); return (a) => a[x.v!]; }
    if (x.t === 'dot') { eat('dot'); return (_a, c) => c; }
    if (x.t === 'num') { eat('num'); return () => Number(x.v); }
    if (x.t === 'str') { eat('str'); return () => x.v; }
    throw new Error(`Unsupported "${x.t}"`);
  }

  function cmp(): N {
    const l = primary();
    const op = peek();
    if (op && ['=', '!=', '<', '<=', '>', '>='].includes(op.t)) {
      eat(op.t); const r = primary();
      return (a, c) => {
        const lv = l(a, c), rv = r(a, c);
        const ln = Number(lv), rn = Number(rv);
        const numeric = !Number.isNaN(ln) && !Number.isNaN(rn) && lv !== '' && rv !== '';
        switch (op.t) {
          case '=': return numeric ? ln === rn : String(lv) === String(rv);
          case '!=': return numeric ? ln !== rn : String(lv) !== String(rv);
          case '<': return ln < rn; case '<=': return ln <= rn;
          case '>': return ln > rn; case '>=': return ln >= rn;
        }
      };
    }
    return l;
  }

  function andExpr(): N {
    let l = cmp();
    while (peek()?.t === 'and') { eat('and'); const r = cmp(); const ll = l; l = (a, c) => !!ll(a, c) && !!r(a, c); }
    return l;
  }
  function orExpr(): N {
    let l = andExpr();
    while (peek()?.t === 'or') { eat('or'); const r = andExpr(); const ll = l; l = (a, c) => !!ll(a, c) || !!r(a, c); }
    return l;
  }

  const root = orExpr();
  if (p !== toks.length) throw new Error('Trailing tokens');
  return (a, c) => !!root(a, c);
}
