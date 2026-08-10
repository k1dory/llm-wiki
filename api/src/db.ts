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

export function listPages(limit = 200, offset = 0): Page[] {
  return db
    .prepare(
      "SELECT * FROM pages ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as Page[];
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

export function search(query: string, limit = 30): SearchHit[] {
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
         WHERE pages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, limit) as SearchHit[];
  } catch {
    return [];
  }
}

export function backlinks(slug: string) {
  return db
    .prepare(
      `SELECT l.src AS slug, p.title
       FROM links l JOIN pages p ON p.slug = l.src
       WHERE l.dst = ? ORDER BY p.title`,
    )
    .all(slug) as { slug: string; title: string }[];
}

export function outlinks(slug: string) {
  return db
    .prepare(
      `SELECT l.dst AS slug, l.label, p.title AS title
       FROM links l LEFT JOIN pages p ON p.slug = l.dst
       WHERE l.src = ? ORDER BY l.dst`,
    )
    .all(slug) as { slug: string; label: string; title: string | null }[];
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

export function graph(): Graph {
  const pages = db
    .prepare("SELECT slug, title, tags FROM pages")
    .all() as { slug: string; title: string; tags: string }[];
  const edges = db
    .prepare("SELECT src AS source, dst AS target, label FROM links")
    .all() as { source: string; target: string; label: string }[];

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

export function allTags(): { tag: string; count: number }[] {
  const rows = db.prepare("SELECT tags FROM pages WHERE tags != ''").all() as {
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

export function stats() {
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
