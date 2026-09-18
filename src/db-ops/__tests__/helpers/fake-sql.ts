/**
 * A postgres.js look-alike for db-ops unit tests: renders every tagged call
 * (nested fragments inlined, `sql('ident')` as a quoted identifier, values as
 * $n placeholders) into text + params, hands the rendered query to a
 * `respond` callback for canned rows, and logs every rendered query so a
 * test can assert on the predicate SQL a db-op actually emits. No socket.
 */

export interface RenderedQuery {
  text: string;
  params: unknown[];
}

interface Fragment extends RenderedQuery {
  __frag: true;
}

type Responder = (q: RenderedQuery) => unknown[];

function isFragment(v: unknown): v is Fragment {
  return typeof v === 'object' && v !== null && (v as { __frag?: boolean }).__frag === true;
}

function render(strings: TemplateStringsArray, values: unknown[]): RenderedQuery {
  let text = '';
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i >= values.length) continue;
    const v = values[i];
    if (isFragment(v)) {
      // Re-number the nested fragment's params into ours.
      let t = v.text;
      const offset = params.length;
      t = t.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + offset}`);
      params.push(...v.params);
      text += t;
    } else {
      text += push(v);
    }
  }
  // Drop `-- …` line comments BEFORE collapsing whitespace — otherwise the
  // first comment would swallow the rest of the (now single-line) query.
  return { text: text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim(), params };
}

export interface FakeSql {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray | string, ...values: unknown[]): any;
  json: (v: unknown) => Fragment;
  begin: <T>(fn: (tx: FakeSql) => Promise<T>) => Promise<T>;
  /** Every query rendered so far (fragments included), in creation order. */
  log: RenderedQuery[];
  /** Queries that were actually awaited. */
  executed: RenderedQuery[];
}

export function createFakeSql(respond: Responder): FakeSql {
  const log: RenderedQuery[] = [];
  const executed: RenderedQuery[] = [];
  const fake = ((strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === 'string') {
      const frag: Fragment = { __frag: true, text: `"${strings}"`, params: [] };
      return frag;
    }
    const q = render(strings, values);
    log.push(q);
    // Lazy thenable: a fragment that is only ever nested is never executed.
    const thenable = {
      __frag: true as const,
      text: q.text,
      params: q.params,
      then<R>(onOk: (rows: unknown[]) => R, onErr?: (e: unknown) => R) {
        executed.push(q);
        let rows: unknown[];
        try {
          rows = respond(q);
        } catch (e) {
          return Promise.reject(e).then(onOk, onErr);
        }
        return Promise.resolve(rows).then(onOk, onErr);
      },
      catch() {
        return Promise.resolve([]);
      },
    };
    return thenable;
  }) as FakeSql;
  fake.json = (v) => ({ __frag: true, text: '$json', params: [v] });
  fake.begin = (fn) => fn(fake);
  fake.log = log;
  fake.executed = executed;
  return fake;
}
