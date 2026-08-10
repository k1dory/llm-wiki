# LLM Wiki

Вики для агента: страницы в Markdown, связи через `[[вики-ссылки]]`, граф связей в UI и MCP-сервер, чтобы Claude Code читал и пополнял базу сам.

Три контейнера, ничего лишнего:

| Контейнер | Что делает | Порт | Домен |
|---|---|---|---|
| `wiki` | UI: список, редактор, интерактивный граф (nginx + статика) | 8080 | `wiki.<домен>` |
| `api` | REST + SQLite (FTS5), единственный владелец базы | 8081 → 8080 | `api.<домен>` |
| `mcp` | MCP поверх API, Streamable HTTP `POST /mcp` | 8082 → 8090 | `mcp.<домен>` |

База — SQLite в volume `wiki-data`. Внешних зависимостей и сетевых сервисов больше нет.

## Запуск

```bash
docker compose up -d --build
./seed.sh                      # демо-страницы, чтобы граф был не пустой
open http://localhost:8080
```

Порты меняются переменными `WEB_PORT` / `API_PORT` / `MCP_PORT`.
Запись можно закрыть токеном — задай `WRITE_TOKEN` (действует и на API, и на MCP; чтение всегда открыто).

Если `docker compose` недоступен, то же самое вручную:

```bash
docker network create wikinet
docker volume create wiki-data
docker build -t wiki-api ./api && docker build -t wiki-mcp ./mcp && docker build -t wiki-web ./web
docker run -d --name api  --network wikinet -v wiki-data:/data -p 8081:8080 wiki-api
docker run -d --name mcp  --network wikinet -e API_URL=http://api:8080 -p 8082:8090 wiki-mcp
docker run -d --name wiki --network wikinet -p 8080:80 wiki-web
```

## Подключение к Claude Code

```bash
claude mcp add --transport http llm-wiki http://localhost:8082/mcp
# в облаке:
claude mcp add --transport http llm-wiki https://mcp.<домен>/mcp
```

Инструменты, которые получает агент:

| Инструмент | Назначение |
|---|---|
| `wiki_search` | полнотекстовый поиск (префиксный, по словам) |
| `wiki_list` | последние страницы — обзор, когда неясно, что искать |
| `wiki_read` | страница целиком + исходящие и обратные ссылки |
| `wiki_write` | создать/перезаписать (Markdown, ссылки `[[...]]`) |
| `wiki_delete` | удалить страницу |
| `wiki_graph` | весь граф: узлы и рёбра |
| `wiki_neighbors` | окрестность одной страницы (дешевле полного графа) |
| `wiki_tags` | теги с количествами — оглавление тем |

Локально MCP можно поднять и без HTTP, процессом:

```bash
claude mcp add llm-wiki -- docker run -i --rm --network llm-wiki_default \
  -e MCP_MODE=stdio -e API_URL=http://api:8080 llm-wiki-mcp
```

## Связи и граф

Ребро появляется ровно там, где в тексте есть `[[цель]]` или `[[цель|подпись]]` — отдельного редактора связей нет и не нужно. Ссылка на несозданную страницу даёт пунктирный узел: видно, где в базе дыра. В графе: колесо — зум, перетаскивание — панорама, клик по узлу — переход, наведение подсвечивает соседей.

## API

```
GET    /api/pages?q=&limit=     список или поиск
GET    /api/pages/:slug         страница + links + backlinks
PUT    /api/pages/:slug         {title, content, tags[]} — создать/перезаписать
DELETE /api/pages/:slug
GET    /api/graph               {nodes:[{id,title,tags,exists,degree}], edges:[{source,target}]}
GET    /api/tags  /api/stats  /health
```

## Домены и деплой

`deploy/Caddyfile` разводит три поддомена по контейнерам и берёт на себя HTTPS. Ставится как edge-прокси рядом с compose (команда — в комментарии внутри файла), либо ту же маршрутизацию делает балансировщик облака.

Что учесть при выкатке:

- задать `WRITE_TOKEN`, иначе писать в вики сможет любой;
- `wiki-data` — единственное состояние, его и бэкапить (`docker run --rm -v wiki-data:/d -v $PWD:/b alpine tar czf /b/wiki.tgz /d`);
- SQLite не переживает несколько реплик `api` на одном файле — масштабировать этот контейнер горизонтально нельзя;
- UI ходит в API через свой origin (`/api` проксирует nginx), так что домен `api.` нужен только для внешних клиентов.
