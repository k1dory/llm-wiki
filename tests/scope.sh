#!/usr/bin/env bash
# Проверка токена области: скрытые страницы не утекают ни через одну ручку API.
#   docker build -t wiki-api-scope ./api && ./tests/scope.sh
set -euo pipefail

IMG=${IMG:-wiki-api-scope}
PORT=${PORT:-18081}
RW=rw-test-token
WT=work-test-token
NAME=wiki-scope-test-$$

docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:8080" \
  -e TOKEN=$RW -e SCOPED_TOKENS="work=$WT" -e DB_PATH=/tmp/wiki.db "$IMG" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

API=http://127.0.0.1:$PORT
for _ in $(seq 50); do curl -fs "$API/health" >/dev/null && break; sleep 0.2; done

put() { curl -fs -X PUT "$API/api/pages/$1" -H "authorization: Bearer $RW" \
  -H 'content-type: application/json' -d "$2" >/dev/null; }
put rab  '{"title":"Рабочая","tags":["work","genomed"],"content":"секрет-слово [[лич]] [[рабоч2]] [[нет-такой]]"}'
put рабоч2 '{"title":"Рабочая 2","tags":["work"],"content":"ссылка [[rab]]"}'
put лич  '{"title":"ЛичныйЗаголовок","tags":["roblox"],"content":"секрет-слово [[rab]]"}'

w() { curl -s "$API$1" -H "authorization: Bearer $WT"; }
# Поиск — через --data-urlencode: голую кириллицу в URL curl не кодирует.
ws() { curl -s -G "$API/api/pages" --data-urlencode "q=$1" -H "authorization: Bearer $WT"; }
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

check "список без личной"        '! w /api/pages | grep -q ЛичныйЗаголовок'
check "список с рабочей"         'w /api/pages | grep -q "\"rab\""'
check "поиск находит рабочую"    'ws секрет | grep -q "\"rab\""'
check "поиск без личной"         '! ws секрет | grep -q "\"лич\""'
check "поиск по заголовку личной пуст" '! ws ЛичныйЗаголовок | grep -q "\"slug\""'
check "личная = 404"             '[ "$(curl -s -o /dev/null -w %{http_code} "$API/api/pages/лич" -H "authorization: Bearer $WT")" = 404 ]'
check "обратные ссылки без личной" '! w /api/pages/rab | grep -q ЛичныйЗаголовок'
check "исходящие без личной"     '! w /api/pages/rab | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(l[\"slug\"]==\"лич\" for l in d[\"links\"]) else 1)"'
check "висячая ссылка осталась"  'w /api/pages/rab | grep -q "нет-такой"'
check "граф без личной"          '! w /api/graph | grep -qE "ЛичныйЗаголовок|\"лич\""'
check "теги без roblox"          '! w /api/tags | grep -q roblox'
code() { curl -s -o /dev/null -w %{http_code} "$@"; }
wput() { code -X PUT "$API/api/pages/$1" -H "authorization: Bearer $WT" -H content-type:application/json -d "$2"; }
check "запись новой страницы"    '[ "$(wput kol "{\"title\":\"От коллеги\",\"tags\":[\"argus\"],\"content\":\"x\"}")" = 200 ]'
check "новой поставлен тег work" 'w /api/pages/kol | grep -q "\"work\""'
check "без тегов тоже work"      '[ "$(wput kol2 "{\"content\":\"y\"}")" = 200 ] && w /api/pages/kol2 | grep -q "\"work\""'
check "снять work нельзя"        '[ "$(wput rab "{\"tags\":[\"genomed\"]}")" = 200 ] && w /api/pages/rab | grep -q "\"work\""'
check "перезапись личной = 409"  '[ "$(wput лич "{\"content\":\"взлом\",\"tags\":[\"work\"]}")" = 409 ]'
check "личная не тронута"        'curl -s "$API/api/pages/лич" -H "authorization: Bearer $RW" | grep -q "секрет-слово" && ! curl -s "$API/api/pages/лич" -H "authorization: Bearer $RW" | grep -q "\"work\""'
check "удаление личной = 404"    '[ "$(code -X DELETE "$API/api/pages/лич" -H "authorization: Bearer $WT")" = 404 ]'
check "личная на месте"          '[ "$(code "$API/api/pages/лич" -H "authorization: Bearer $RW")" = 200 ]'
check "удаление своей"           '[ "$(code -X DELETE "$API/api/pages/kol2" -H "authorization: Bearer $WT")" = 200 ]'
check "чужой токен не пишет"     '[ "$(code -X PUT "$API/api/pages/z" -H "authorization: Bearer nope" -H content-type:application/json -d "{}")" = 401 ]'
check "без токена 401"           '[ "$(curl -s -o /dev/null -w %{http_code} "$API/api/pages")" = 401 ]'
check "rw видит личную"          'curl -s "$API/api/pages/лич" -H "authorization: Bearer $RW" | grep -q ЛичныйЗаголовок'

exit $fail
