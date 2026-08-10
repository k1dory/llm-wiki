#!/usr/bin/env bash
# Наполняет вики демо-страницами, чтобы граф был не пустой.
# Использование: ./seed.sh [http://localhost:8081]
set -euo pipefail
API="${1:-http://localhost:8081}"
AUTH=()
[ -n "${WRITE_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $WRITE_TOKEN")

put() {
  # ${AUTH[@]+...} — иначе bash 3.2 (macOS) ругается на пустой массив под set -u
  curl -sS -X PUT "$API/api/pages/$1" \
    -H 'content-type: application/json' ${AUTH[@]+"${AUTH[@]}"} \
    -d "$2" > /dev/null && echo "  + $1"
}

echo "Заполняю ${API} ..."

put "llm-wiki" '{
  "title": "LLM Wiki",
  "tags": ["мета"],
  "content": "База знаний, которую читает и пополняет [[claude-code]] через [[mcp]].\n\nУстройство:\n- [[api]] — REST поверх SQLite\n- [[mcp]] — инструменты для агента\n- [[граф-связей]] — как строятся рёбра\n\nСсылки в тексте пишутся как `[[имя-страницы]]` — из них собирается [[граф-связей]]."
}'

put "граф-связей" '{
  "title": "Граф связей",
  "tags": ["мета", "устройство"],
  "content": "Рёбра графа берутся **только** из текста страниц: каждая ссылка `[[цель]]` даёт ребро от текущей страницы к цели.\n\nЕсли цель ещё не создана, узел рисуется пунктиром — это подсказка, что писать дальше. Смотри [[api]] и [[llm-wiki]]."
}'

put "api" '{
  "title": "API",
  "tags": ["устройство"],
  "content": "REST-слой над SQLite (FTS5 для поиска).\n\n```\nGET    /api/pages?q=      поиск\nGET    /api/pages/:slug   страница + связи\nPUT    /api/pages/:slug   создать/перезаписать\nDELETE /api/pages/:slug\nGET    /api/graph         узлы и рёбра\n```\n\nЕдинственный владелец базы — все пишут через него, в том числе [[mcp]]."
}'

put "mcp" '{
  "title": "MCP-сервер",
  "tags": ["устройство", "интеграция"],
  "content": "Тонкая обёртка над [[api]], говорит по Model Context Protocol (Streamable HTTP, `POST /mcp`).\n\nИнструменты: `wiki_search`, `wiki_read`, `wiki_write`, `wiki_graph`, `wiki_neighbors`, `wiki_tags`, `wiki_list`, `wiki_delete`.\n\nПодключается к [[claude-code]] одной командой `claude mcp add`."
}'

put "claude-code" '{
  "title": "Claude Code",
  "tags": ["интеграция"],
  "content": "Основной потребитель [[mcp]]. Читает [[llm-wiki]] перед работой и дописывает выводы после — так знания переживают сессию.\n\nПолезная привычка: заводить страницу на каждое принятое решение и связывать её с соседними через `[[...]]`."
}'

echo "Готово. Открой UI: ${API/8081/8080}"
