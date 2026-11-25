import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
  allTags,
  backlinks,
  deletePage,
  getPage,
  graph,
  listPages,
  outlinks,
  search,
  slugify,
  stats,
  tagList,
  upsertPage,
  visible,
} from "./db.js";
import type { Scope } from "./db.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8080);
// Основной токен (rw): даёт и чтение, и запись. Им ходит агент (MCP) и подписывается UI.
// Если не задан — пишет кто угодно (удобно локально, не для интернета).
// WRITE_TOKEN — старое имя того же токена; поддержано для совместимости, можно убрать
// после того, как .env везде переведён на TOKEN.
const TOKEN = process.env.TOKEN ?? process.env.WRITE_TOKEN ?? "";
// Токен только на чтение (ro). Чтение закрывается, как только задан ЛЮБОЙ токен
// (TOKEN или READ_TOKEN); оба пусты — вики читает кто угодно. Основной TOKEN (rw)
// наследует чтение, поэтому READ_TOKEN нужен лишь чтобы выдать чтение без записи.
const READ_TOKEN = process.env.READ_TOKEN ?? "";
// Токены с областью: чтение и запись только страниц с заданным тегом.
// Записанная таким токеном страница всегда получает его тег.
// Формат: "тег=токен", несколько через пробел или «;» — например "work=abc123".
// Страница без нужного тега для такого токена не существует: её нет ни в списке,
// ни в поиске, ни в графе, ни в обратных ссылках, а прямое чтение отдаёт 404.
const SCOPED = new Map<string, string>(); // токен → тег
for (const pair of (process.env.SCOPED_TOKENS ?? "").split(/[\s;]+/).filter(Boolean)) {
  const i = pair.indexOf("=");
  const tag = pair.slice(0, i).trim();
  const tok = pair.slice(i + 1).trim();
  if (i <= 0 || !tag || !tok) throw new Error(`SCOPED_TOKENS: ожидается тег=токен, получено «${pair}»`);
  if (tok === TOKEN || tok === READ_TOKEN) throw new Error(`SCOPED_TOKENS: токен области «${tag}» совпадает с TOKEN/READ_TOKEN`);
  SCOPED.set(tok, tag);
}

app.use(express.json({ limit: "4mb" }));
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type, authorization");
  res.set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

const bearer = (req: Request) => (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

function requireWrite(req: Request, res: Response, next: NextFunction) {
  res.locals.scope = null;
  // Токен области пишет только внутри своего тега: чужие страницы ему не
  // перезаписать и не удалить, а новые получают тег области автоматически.
  const t = bearer(req);
  if (t && SCOPED.has(t)) {
    res.locals.scope = SCOPED.get(t)!;
    return next();
  }
  if (!TOKEN) return next();
  if (bearer(req) === TOKEN) return next();
  res.status(401).json({ error: "нужен Authorization: Bearer <TOKEN> (rw)" });
}

function requireRead(req: Request, res: Response, next: NextFunction) {
  const t = bearer(req);
  res.locals.scope = null;
  // Токен области проверяется первым и всегда — даже на открытой локальной вики
  // он не должен давать больше, чем свой тег.
  if (t && SCOPED.has(t)) {
    res.locals.scope = SCOPED.get(t)!;
    return next();
  }
  if (!READ_TOKEN && !TOKEN && SCOPED.size === 0) return next();
  // rw-токен наследует чтение; отдельный read-токен — только чтение.
  if ((TOKEN && t === TOKEN) || (READ_TOKEN && t === READ_TOKEN)) return next();
  res.status(401).json({ error: "вики закрыта: нужен Authorization: Bearer <токен>" });
}

const scopeOf = (res: Response): Scope => res.locals.scope ?? null;

// /health отвечает без токена — на него смотрят healthcheck и мониторинг.
app.get("/health", (_req, res) => res.json({ ok: true, ...stats() }));

// Всё под /api закрыто read-токеном, если он задан.
app.use("/api", requireRead);

app.get("/api/pages", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  const scope = scopeOf(res);
  if (q) return res.json({ results: search(q, limit, scope), query: q });
  res.json({
    results: listPages(limit, Number(req.query.offset ?? 0) || 0, scope).map((p) => ({
      slug: p.slug,
      title: p.title,
      tags: p.tags,
      updated_at: p.updated_at,
    })),
  });
});

app.get("/api/pages/:slug", (req, res) => {
  const slug = slugify(req.params.slug);
  const scope = scopeOf(res);
  const page = getPage(slug);
  // Скрытая страница неотличима от несуществующей — тот же 404.
  if (!page || !visible(page.tags, scope))
    return res.status(404).json({ error: "страница не найдена", slug });
  res.json({
    ...page,
    tags: page.tags ? page.tags.split(",") : [],
    links: outlinks(slug, scope),
    backlinks: backlinks(slug, scope),
  });
});

// Теги в любом виде, в котором их принимает upsertPage, — массивом.
function tagsOf(input: unknown, fallback: string): string[] {
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  return tagList(typeof input === "string" ? input : fallback);
}

app.put("/api/pages/:slug", requireWrite, (req, res) => {
  try {
    const scope = scopeOf(res);
    let tags = req.body?.tags;
    if (scope !== null) {
      const existing = getPage(slugify(req.params.slug));
      // Страница вне области: перезаписать её нельзя. Отвечаем «занято», не раскрывая
      // ни заголовка, ни содержимого — только то, что этот slug не свободен.
      if (existing && !visible(existing.tags, scope))
        return res.status(409).json({ error: "slug занят, выбери другой" });
      // Тег области ставится всегда: иначе страница пропала бы у автора из вида,
      // а снять его — значит увести страницу из рабочей части в личную.
      const list = tagsOf(tags, existing?.tags ?? "");
      tags = list.includes(scope) ? list : [...list, scope];
    }
    const page = upsertPage({
      slug: req.params.slug,
      title: req.body?.title,
      content: req.body?.content,
      tags,
    });
    res.json({ ...page, tags: page.tags ? page.tags.split(",") : [] });
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) });
  }
});

app.delete("/api/pages/:slug", requireWrite, (req, res) => {
  const slug = slugify(req.params.slug);
  const scope = scopeOf(res);
  if (scope !== null) {
    const page = getPage(slug);
    // Как и при чтении: страница вне области неотличима от несуществующей.
    if (!page || !visible(page.tags, scope))
      return res.status(404).json({ error: "страница не найдена" });
  }
  const ok = deletePage(slug);
  if (!ok) return res.status(404).json({ error: "страница не найдена" });
  res.json({ ok: true });
});

app.get("/api/graph", (_req, res) => res.json(graph(scopeOf(res))));
app.get("/api/tags", (_req, res) => res.json({ tags: allTags(scopeOf(res)) }));
app.get("/api/stats", (_req, res) => res.json(stats(scopeOf(res))));

app.listen(PORT, () => {
  console.log(
    `[api] слушает :${PORT}, запись ${TOKEN ? "по токену" : "открыта"}, ` +
      `чтение ${TOKEN || READ_TOKEN ? "по токену" : "открыто"}` +
      (SCOPED.size ? `, токенов области: ${SCOPED.size} (${[...new Set(SCOPED.values())].join(", ")})` : ""),
  );
});
