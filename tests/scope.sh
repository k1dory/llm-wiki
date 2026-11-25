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
check "запись запрещена"         '[ "$(curl -s -o /dev/null -w %{http_code} -X PUT "$API/api/pages/x" -H "authorization: Bearer $WT" -H content-type:application/json -d "{}")" = 403 ]'
check "удаление запрещено"       '[ "$(curl -s -o /dev/null -w %{http_code} -X DELETE "$API/api/pages/rab" -H "authorization: Bearer $WT")" = 403 ]'
check "без токена 401"           '[ "$(curl -s -o /dev/null -w %{http_code} "$API/api/pages")" = 401 ]'
check "rw видит личную"          'curl -s "$API/api/pages/лич" -H "authorization: Bearer $RW" | grep -q ЛичныйЗаголовок'

exit $fail
