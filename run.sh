#!/usr/bin/env sh
# Starts the media library. First run: ./run.sh ~/Videos   Later runs: ./run.sh
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
fi
# Install the dependencies on the first run, and again whenever requirements.txt changes.
if ! cmp -s requirements.txt .venv/requirements.txt; then
  .venv/bin/python -m pip install -r requirements.txt && cp requirements.txt .venv/requirements.txt
fi
if [ -n "$1" ]; then
  folder="$1"; shift
  exec .venv/bin/python -m medialib --library "$folder" "$@"
fi
exec .venv/bin/python -m medialib
