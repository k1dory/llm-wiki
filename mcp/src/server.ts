import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createWiki } from "./wiki.js";

const TOOLS: Tool[] = [
  {
    name: "wiki_search",
    description:
      "Полнотекстовый поиск по вики (FTS5, префиксный по каждому слову). " +
      "Возвращает slug, заголовок, теги и фрагмент с подсветкой. " +
      "Используй, чтобы найти нужную страницу перед чтением.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "поисковый запрос" },
        limit: { type: "integer", description: "сколько результатов, по умолчанию 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "wiki_list",
    description:
      "Список страниц, самые свежие сверху. Полезно для обзора вики, когда не знаешь, что искать.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "сколько страниц, по умолчанию 50" },
      },
    },
  },
  {
    name: "wiki_read",
    description:
      "Читает страницу целиком по slug: содержимое, теги, исходящие ссылки и обратные ссылки (backlinks). " +
      "Вызывай перед правкой страницы, чтобы не затереть чужой текст.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "идентификатор страницы" } },
      required: ["slug"],
    },
  },
  {
    name: "wiki_write",
    description:
      "Создаёт или полностью перезаписывает страницу. Содержимое — Markdown; " +
      "связи задаются вики-ссылками вида [[другая-страница]] или [[slug|подпись]] прямо в тексте, " +
      "граф строится из них автоматически. Не передавай content, если хочешь поменять только заголовок или теги.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "идентификатор страницы" },
        title: { type: "string", description: "заголовок" },
        content: { type: "string", description: "Markdown-текст со ссылками [[...]]" },
        tags: { type: "array", items: { type: "string" }, description: "теги" },
      },
      required: ["slug"],
    },
  },
  {
    name: "wiki_delete",
    description: "Удаляет страницу. Ссылки на неё остаются висячими узлами графа.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "wiki_graph",
    description:
      "Граф связей целиком: узлы (страницы, exists=false — упомянутые, но не созданные) и рёбра. " +
      "Используй, чтобы понять структуру знаний: что с чем связано, что осталось незаполненным.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wiki_neighbors",
    description:
      "Соседи страницы в графе: куда она ссылается и кто ссылается на неё. " +
      "Дешевле, чем тянуть весь граф, когда нужен контекст вокруг одной темы.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "wiki_tags",
    description: "Все теги с количеством страниц. Полезно как оглавление тем.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function createServer(authorization?: string): Server {
  // Токен клиента живёт ровно в этом соединении: сервер создаётся на каждый запрос.
  const wiki = createWiki(authorization);
  const server = new Server(
    { name: "llm-wiki", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    try {
      switch (req.params.name) {
        case "wiki_search":
          return text(await wiki.search(String(args.query ?? ""), args.limit ?? 20));
        case "wiki_list":
          return text(await wiki.list(args.limit ?? 50));
        case "wiki_read":
          return text(await wiki.read(String(args.slug)));
        case "wiki_write":
          return text(
            await wiki.write(String(args.slug), {
              title: args.title,
              content: args.content,
              tags: args.tags,
            }),
          );
        case "wiki_delete":
          return text(await wiki.remove(String(args.slug)));
        case "wiki_graph":
          return text(await wiki.graph());
        case "wiki_neighbors": {
          const page = await wiki.read(String(args.slug));
          return text({
            slug: page.slug,
            title: page.title,
            links: page.links,
            backlinks: page.backlinks,
          });
        }
        case "wiki_tags":
          return text(await wiki.tags());
        default:
          throw new Error(`неизвестный инструмент: ${req.params.name}`);
      }
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Ошибка: ${(e as Error).message}` }],
      };
    }
  });

  return server;
}
