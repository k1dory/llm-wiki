const API_URL = (process.env.API_URL ?? "http://api:8080").replace(/\/+$/, "");
// Запасной токен из окружения. Нужен для stdio-режима, где заголовков нет.
// В HTTP-режиме задавать его не стоит: тогда MCP пишет в вики без токена клиента.
const FALLBACK_TOKEN = process.env.TOKEN ?? process.env.WRITE_TOKEN ?? "";

export type Wiki = ReturnType<typeof createWiki>;

/**
 * Клиент API. Токен берётся из заголовка запроса клиента и пробрасывается в API
 * как есть — MCP не хранит доступов и ничего не решает за пользователя.
 */
export function createWiki(authorization?: string) {
  const auth = authorization?.trim()
    ? authorization
    : FALLBACK_TOKEN
      ? `Bearer ${FALLBACK_TOKEN}`
      : "";

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (auth) headers.authorization = auth;

    const res = await fetch(`${API_URL}${path}`, { ...init, headers });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const hint =
        res.status === 401
          ? " (вики требует токен: передай Authorization в конфиге MCP-клиента)"
          : "";
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${res.status}: ${body?.error ?? text}${hint}`,
      );
    }
    return body;
  }

  return {
    list: (limit = 100) => call(`/api/pages?limit=${limit}`),
    search: (q: string, limit = 30) =>
      call(`/api/pages?q=${encodeURIComponent(q)}&limit=${limit}`),
    read: (slug: string) => call(`/api/pages/${encodeURIComponent(slug)}`),
    write: (
      slug: string,
      body: { title?: string; content?: string; tags?: string[] },
    ) =>
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
}
