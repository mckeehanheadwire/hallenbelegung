// Minimal WREN REST client for the Worker (private API with the secret key, public API without).

export class WrenError extends Error {
  constructor(status, body, path) {
    super(`WREN ${status} on ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export function wren(env) {
  const base = `${env.WREN_BASE}/api/v1`;
  const publicBase = `${base}/orgs/${env.WREN_ORG}`;

  async function call(method, url, body, auth = true) {
    const headers = { "User-Agent": "hallenbelegung-worker/1.0" };
    if (auth) headers.Authorization = `Bearer ${env.WREN_API_KEY}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new WrenError(res.status, data, url.replace(env.WREN_BASE, ""));
    return data;
  }

  // Lists return at most 200 items per call; page through with offset.
  async function listAll(urlBase, params = {}, auth = true) {
    const items = [];
    for (let offset = 0; ; offset += 200) {
      const q = new URLSearchParams({ ...params, limit: "200", offset: String(offset) });
      const page = await call("GET", `${urlBase}?${q}`, undefined, auth);
      items.push(...page.items);
      if (items.length >= page.total || page.items.length === 0) return items;
    }
  }

  return {
    get: path => call("GET", base + path),
    put: (path, body) => call("PUT", base + path, body),
    post: (path, body) => call("POST", base + path, body),
    del: path => call("DELETE", base + path),
    list: (collection, params) => listAll(`${base}/${collection}`, params),
    listPublic: (collection, params) => listAll(`${publicBase}/${collection}`, params, false),
  };
}
