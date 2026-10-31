// In-memory stand-ins for Workers KV and the Gmail mailer.
export function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store, writes: 0,
    async get(k, type) { const v = store.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { this.writes++; store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}
export function fakeMailer({ fails = false } = {}) {
  const sent = [];
  const mailer = async (msg) => { if (fails) throw new Error('mail server rejected login: 535'); sent.push(msg); return { id: `m${sent.length}` }; };
  return { mailer, sent };
}
