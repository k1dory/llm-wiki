import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "/data/wiki.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',      -- через запятую
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Связи. dst может указывать на несуществующую страницу (висячая ссылка).
CREATE TABLE IF NOT EXISTS links (
  src   TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
  dst   TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  slug UNINDEXED, title, content, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
`);

/**
 * Область видимости: null — видно всё; строка — видны только страницы с этим тегом.
 * Нужна для токенов с ограниченным доступом (например, рабочая часть вики для коллег).
 */
export type Scope = string | null;

export function tagList(tags: string): string[] {
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

export function visible(tags: string, scope: Scope): boolean {
  return scope === null || tagList(tags).includes(scope);
}

// Та же проверка внутри SQL, чтобы LIMIT/OFFSET и поиск считались уже по видимым страницам.
db.function("visible", { deterministic: true }, (tags: unknown, scope: unknown) =>
  visible(String(tags ?? ""), scope == null ? null : String(scope)) ? 1 : 0,
);

export type Page = {
  slug: string;
  title: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
};

/** Приводит произвольную строку к slug: латиница/кириллица/цифры, дефисы. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\p{L}\p{N}\-_.]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/**
 * Достаёт [[ссылки]] и [[slug|подпись]] из текста.
 * Код игнорируется: примеры разметки внутри ``` и `…` не должны попадать в граф.
 */
export function extractLinks(content: string): { dst: string; label: string }[] {
  const prose = content.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const out = new Map<string, string>();
  for (const m of prose.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const target = slugify(m[1]);
    if (!target) continue;
    if (!out.has(target)) out.set(target, (m[2] ?? m[1]).trim());
  }
  return [...out].map(([dst, label]) => ({ dst, label }));
}

const reindexFts = db.transaction((p: Page) => {
  db.prepare("DELETE FROM pages_fts WHERE slug = ?").run(p.slug);
  db.prepare(
    "INSERT INTO pages_fts (slug, title, content, tags) VALUES (?, ?, ?, ?)",
  ).run(p.slug, p.title, p.content, p.tags);
});

const rewriteLinks = db.transaction((slug: string, content: string) => {
  db.prepare("DELETE FROM links WHERE src = ?").run(slug);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO links (src, dst, label) VALUES (?, ?, ?)",
  );
  for (const l of extractLinks(content)) {
    if (l.dst !== slug) ins.run(slug, l.dst, l.label);
  }
});

export function getPage(slug: string): Page | undefined {
  return db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as
    | Page
    | undefined;
}

export function listPages(limit = 200, offset = 0, scope: Scope = null): Page[] {
  return db
    .prepare(
      "SELECT * FROM pages WHERE visible(tags, ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    )
    .all(scope, limit, offset) as Page[];
}

export function upsertPage(input: {
  slug: string;
  title?: string;
  content?: string;
  tags?: string[] | string;
}): Page {
  const slug = slugify(input.slug);
  if (!slug) throw new Error("пустой slug");

  const existing = getPage(slug);
  const title = input.title ?? existing?.title ?? slug;
  const content = input.content ?? existing?.content ?? "";
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => t.trim()).filter(Boolean).join(",")
    : (input.tags ?? existing?.tags ?? "");

  db.prepare(
    `INSERT INTO pages (slug, title, content, tags)
     VALUES (@slug, @title, @content, @tags)
     ON CONFLICT(slug) DO UPDATE SET
       title = @title, content = @content, tags = @tags,
       updated_at = datetime('now')`,
  ).run({ slug, title, content, tags });

  const page = getPage(slug)!;
  reindexFts(page);
  rewriteLinks(slug, content);
  return page;
}

export function deletePage(slug: string): boolean {
  const res = db.prepare("DELETE FROM pages WHERE slug = ?").run(slug);
  db.prepare("DELETE FROM pages_fts WHERE slug = ?").run(slug);
  return res.changes > 0;
}

export type SearchHit = {
  slug: string;
  title: string;
  tags: string;
  snippet: string;
};

export function search(query: string, limit = 30, scope: Scope = null): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  // Префиксный поиск по каждому слову: "граф свя" -> "граф*" AND "свя*"
  const fts = q
    .split(/\s+/)
    .map((w) => w.replace(/["*]/g, ""))
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(" AND ");
  if (!fts) return [];
  try {
    return db
      .prepare(
        // Маркеры подсветки — редкие символы, чтобы не путались с разметкой [[...]]
        `SELECT f.slug, p.title, p.tags,
                snippet(pages_fts, 2, char(2), char(3), '…', 12) AS snippet
         FROM pages_fts f JOIN pages p ON p.slug = f.slug
         WHERE pages_fts MATCH ? AND visible(p.tags, ?)
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, scope, limit) as SearchHit[];
  } catch {
    return [];
  }
}

export function backlinks(slug: string, scope: Scope = null) {
  return db
    .prepare(
      `SELECT l.src AS slug, p.title
       FROM links l JOIN pages p ON p.slug = l.src
       WHERE l.dst = ? AND visible(p.tags, ?) ORDER BY p.title`,
    )
    .all(slug, scope) as { slug: string; title: string }[];
}

/**
 * Исходящие ссылки. Ссылка на существующую, но невидимую в области страницу
 * выкидывается целиком — иначе её заголовок утёк бы через JOIN.
 * Висячие ссылки (страницы нет) остаются: их slug и так виден в тексте.
 */
export function outlinks(slug: string, scope: Scope = null) {
  return db
    .prepare(
      `SELECT l.dst AS slug, l.label, p.title AS title
       FROM links l LEFT JOIN pages p ON p.slug = l.dst
       WHERE l.src = ? AND (p.slug IS NULL OR visible(p.tags, ?))
       ORDER BY l.dst`,
    )
    .all(slug, scope) as { slug: string; label: string; title: string | null }[];
}

export type Graph = {
  nodes: {
    id: string;
    title: string;
    tags: string[];
    exists: boolean;
    degree: number;
  }[];
  edges: { source: string; target: string; label: string }[];
};

export function graph(scope: Scope = null): Graph {
  const all = db
    .prepare("SELECT slug, title, tags FROM pages")
    .all() as { slug: string; title: string; tags: string }[];
  const pages = all.filter((p) => visible(p.tags, scope));
  const shown = new Set(pages.map((p) => p.slug));
  const hidden = new Set(all.filter((p) => !shown.has(p.slug)).map((p) => p.slug));
  // Ребро остаётся, только если источник видим, а цель видима или не существует:
  // скрытая страница не должна проявиться ни узлом, ни «призраком».
  const edges = (
    db
      .prepare("SELECT src AS source, dst AS target, label FROM links")
      .all() as { source: string; target: string; label: string }[]
  ).filter((e) => shown.has(e.source) && !hidden.has(e.target));

  const nodes = new Map<string, Graph["nodes"][number]>();
  for (const p of pages) {
    nodes.set(p.slug, {
      id: p.slug,
      title: p.title,
      tags: p.tags ? p.tags.split(",").filter(Boolean) : [],
      exists: true,
      degree: 0,
    });
  }
  for (const e of edges) {
    // Висячая ссылка — «призрачный» узел, его видно в графе как пунктир.
    if (!nodes.has(e.target)) {
      nodes.set(e.target, {
        id: e.target,
        title: e.target,
        tags: [],
        exists: false,
        degree: 0,
      });
    }
    nodes.get(e.source)!.degree++;
    nodes.get(e.target)!.degree++;
  }
  return { nodes: [...nodes.values()], edges };
}

export function allTags(scope: Scope = null): { tag: string; count: number }[] {
  const rows = db
    .prepare("SELECT tags FROM pages WHERE tags != '' AND visible(tags, ?)")
    .all(scope) as {
    tags: string;
  }[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags.split(",").map((s) => s.trim()).filter(Boolean)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function stats(scope: Scope = null) {
  if (scope !== null) {
    // Для области — только размер видимой части, без сирот по всей базе.
    const g = graph(scope);
    return { pages: g.nodes.filter((n) => n.exists).length, links: g.edges.length };
  }
  const pages = (db.prepare("SELECT count(*) c FROM pages").get() as any).c;
  const links = (db.prepare("SELECT count(*) c FROM links").get() as any).c;
  const orphans = (
    db
      .prepare(
        `SELECT count(*) c FROM pages p
         WHERE NOT EXISTS (SELECT 1 FROM links WHERE src = p.slug)
           AND NOT EXISTS (SELECT 1 FROM links WHERE dst = p.slug)`,
      )
      .get() as any
  ).c;
  return { pages, links, orphans };
}
