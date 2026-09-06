#!/bin/zsh
set -eu

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
PORT="${ROOM_PLAN_PORT:-8000}"
ACCESS_TOKEN="$(openssl rand -hex 12)"

cd "$PROJECT_DIR"

if [[ ! -x .venv/bin/uvicorn ]]; then
  print -u2 "Не найден .venv/bin/uvicorn. Сначала создайте окружение по README.md."
  exit 1
fi

LAN_IP=""
for INTERFACE in en0 en1 en2 en3 en4 en5 en6 en7 en8; do
  CANDIDATE="$(ipconfig getifaddr "$INTERFACE" 2>/dev/null || true)"
  if [[ "$CANDIDATE" == 10.* || "$CANDIDATE" == 192.168.* || "$CANDIDATE" == 172.1[6-9].* || "$CANDIDATE" == 172.2[0-9].* || "$CANDIDATE" == 172.3[0-1].* ]]; then
    LAN_IP="$CANDIDATE"
    break
  fi
done

if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" && $2 !~ /^198\.18\./ { print $2; exit }')"
fi

print "Редактор будет доступен:"
if [[ -n "$LAN_IP" ]]; then
  print "  На Mac и телефоне: http://${LAN_IP}:${PORT}/?editor=1&access_token=${ACCESS_TOKEN}"
else
  print -u2 "Не удалось определить локальный IP-адрес Mac."
  exit 1
fi
print "Для остановки сервера нажмите Ctrl+C."
print "Ссылка действует до перезапуска сервера; не пересылайте её посторонним."

export ROOM_PLAN_ACCESS_TOKEN="$ACCESS_TOKEN"
exec .venv/bin/uvicorn main:app --host "$LAN_IP" --port "$PORT" --reload
