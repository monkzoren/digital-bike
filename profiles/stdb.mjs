// Thin client for SpacetimeDB's HTTP API. Deliberately not the websocket SDK:
// this service only needs to read one table and call one reducer, and polling
// over HTTP has no generated bindings to keep in sync with the module.
export class Stdb {
  constructor({ url, dbName, token }) {
    this.url = url.replace(/\/+$/, '');
    this.dbName = dbName;
    this.token = token;
  }

  async #post(path, body, contentType) {
    const res = await fetch(`${this.url}/v1/database/${this.dbName}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': contentType },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }

  /** Run SQL and return rows as plain objects keyed by column name. */
  async sql(query) {
    const text = await this.#post('/sql', query, 'text/plain');
    const results = JSON.parse(text);
    const out = [];
    for (const r of results) {
      // Rows come back POSITIONALLY, described by schema.elements — so the
      // column order is authoritative, not the object keys. The names are
      // snake_case over the wire even though the module declares them
      // camelCase, so map them back or every multi-word column reads as
      // undefined.
      const cols = r.schema.elements.map(e => camel(e.name?.some ?? e.name));
      for (const row of r.rows) {
        const obj = {};
        cols.forEach((c, i) => { obj[c] = unwrap(row[i]); });
        out.push(obj);
      }
    }
    return out;
  }

  async call(reducer, args) {
    await this.#post(`/call/${reducer}`, JSON.stringify(args), 'application/json');
  }
}

const camel = name => String(name).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Identity and Timestamp arrive as single-element products (`["0x…"]`,
 *  `[micros]`); everything else is already a scalar. */
function unwrap(v) {
  if (Array.isArray(v) && v.length === 1) return v[0];
  return v;
}
