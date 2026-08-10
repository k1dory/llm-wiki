const API_URL = (process.env.API_URL ?? "http://api:8080").replace(/\/+$/, "");
const WRITE_TOKEN = process.env.WRITE_TOKEN ?? "";

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (WRITE_TOKEN) headers.authorization = `Bearer ${WRITE_TOKEN}`;

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${res.status}: ${body?.error ?? text}`,
    );
  }
  return body;
}

export const wiki = {
  list: (limit = 100) => call(`/api/pages?limit=${limit}`),
  search: (q: string, limit = 30) =>
    call(`/api/pages?q=${encodeURIComponent(q)}&limit=${limit}`),
  read: (slug: string) => call(`/api/pages/${encodeURIComponent(slug)}`),
  write: (slug: string, body: { title?: string; content?: string; tags?: string[] }) =>
    call(`/api/pages/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  remove: (slug: string) =>
    call(`/api/pages/${encodeURIComponent(slug)}`, { method: "DELETE" }),
  graph: () => call(`/api/graph`),
  tags: () => call(`/api/tags`),
  stats: () => call(`/api/stats`),
};
