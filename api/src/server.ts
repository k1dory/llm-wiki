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
  upsertPage,
} from "./db.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8080);
// Токен на запись. Если не задан — пишет кто угодно (удобно локально, не для интернета).
const WRITE_TOKEN = process.env.WRITE_TOKEN ?? "";
// Токен на чтение. Пока не задан, вики читает кто угодно; задан — закрыта целиком.
// Токен записи всегда даёт и чтение, отдельный read-токен нужен для клиентов «только смотреть».
const READ_TOKEN = process.env.READ_TOKEN ?? "";

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
  if (!WRITE_TOKEN) return next();
  if (bearer(req) === WRITE_TOKEN) return next();
  res.status(401).json({ error: "нужен Authorization: Bearer <WRITE_TOKEN>" });
}

function requireRead(req: Request, res: Response, next: NextFunction) {
  if (!READ_TOKEN) return next();
  const t = bearer(req);
  if (t === READ_TOKEN || (WRITE_TOKEN && t === WRITE_TOKEN)) return next();
  res.status(401).json({ error: "вики закрыта: нужен Authorization: Bearer <токен>" });
}

// /health отвечает без токена — на него смотрят healthcheck и мониторинг.
app.get("/health", (_req, res) => res.json({ ok: true, ...stats() }));

// Всё под /api закрыто read-токеном, если он задан.
app.use("/api", requireRead);

app.get("/api/pages", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  if (q) return res.json({ results: search(q, limit), query: q });
  res.json({
    results: listPages(limit, Number(req.query.offset ?? 0) || 0).map((p) => ({
      slug: p.slug,
      title: p.title,
      tags: p.tags,
      updated_at: p.updated_at,
    })),
  });
});

app.get("/api/pages/:slug", (req, res) => {
  const slug = slugify(req.params.slug);
  const page = getPage(slug);
  if (!page) return res.status(404).json({ error: "страница не найдена", slug });
  res.json({
    ...page,
    tags: page.tags ? page.tags.split(",") : [],
    links: outlinks(slug),
    backlinks: backlinks(slug),
  });
});

app.put("/api/pages/:slug", requireWrite, (req, res) => {
  try {
    const page = upsertPage({
      slug: req.params.slug,
      title: req.body?.title,
      content: req.body?.content,
      tags: req.body?.tags,
    });
    res.json({ ...page, tags: page.tags ? page.tags.split(",") : [] });
  } catch (e) {
    res.status(400).json({ error: String((e as Error).message) });
  }
});

app.delete("/api/pages/:slug", requireWrite, (req, res) => {
  const ok = deletePage(slugify(req.params.slug));
  if (!ok) return res.status(404).json({ error: "страница не найдена" });
  res.json({ ok: true });
});

app.get("/api/graph", (_req, res) => res.json(graph()));
app.get("/api/tags", (_req, res) => res.json({ tags: allTags() }));
app.get("/api/stats", (_req, res) => res.json(stats()));

app.listen(PORT, () => {
  console.log(`[api] слушает :${PORT}, запись ${WRITE_TOKEN ? "по токену" : "открыта"}`);
});
