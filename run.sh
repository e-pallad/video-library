#!/usr/bin/env sh
# Starts the media library. First run: ./run.sh ~/Videos   Later runs: ./run.sh
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi
if [ -n "$1" ]; then
  folder="$1"; shift
  exec .venv/bin/python -m medialib --library "$folder" "$@"
fi
exec .venv/bin/python -m medialib
