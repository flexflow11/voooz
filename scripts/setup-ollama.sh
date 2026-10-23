#!/usr/bin/env bash
# Pinned, checksum-verified CPU-only Ollama installation. No sudo or remote installer.
set -euo pipefail

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_ollama_root="${VOOOZ_OLLAMA_HOME:-$task_root/.cache/ollama}"
task_runtime="$task_ollama_root/runtime"
task_binary="$task_runtime/bin/ollama"
task_version="0.40.9"
task_checksum="01f0d0ae50cad3295a79a165033a65cf324f8ae5f7be64679464d29ecf28d67c"
task_archive="$task_ollama_root/downloads/ollama-linux-amd64.tar.zst"
task_model="${OLLAMA_MODEL:-qwen2.5:0.5b}"
task_mode="${1:-install}"

if [[ "$task_mode" == "--help" || "$task_mode" == "help" ]]; then
  cat <<'HELP'
Usage: bash scripts/setup-ollama.sh [install|serve|pull|check|smoke]

install  Download the official pinned Linux AMD64 release, verify its published
         checksum, and extract CPU runtime files. The large archive is removed.
serve    Start the local-only model server in the foreground; keep this process running.
pull     Download OLLAMA_MODEL (default qwen2.5:0.5b) using the running local server.
check    Require the configured model in the local server's installed-model list.
smoke    Run a short real JSON inference, not just a port/health check.

Optional VOOOZ_OLLAMA_HOME selects runtime/models storage; default .cache/ollama.
On first serve, upstream Ollama also creates its own identity under ~/.ollama.
Its model API remains bound to 127.0.0.1:11434; it should not be published directly.
HELP
  exit 0
fi

case "$task_mode" in install|serve|pull|check|smoke) ;; *) echo 'Unknown mode; use --help.' >&2; exit 2 ;; esac

if [[ "$task_mode" == "install" ]]; then
  if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
    echo 'This pinned helper supports Linux AMD64. Use the official Ollama installer for other systems.' >&2
    exit 1
  fi
  for task_command in curl sha256sum tar zstd python3; do
    command -v "$task_command" >/dev/null || { echo "Missing prerequisite: $task_command" >&2; exit 1; }
  done
  if [[ -x "$task_binary" && -f "$task_runtime/.version" && "$(cat "$task_runtime/.version")" == "$task_version" ]]; then
    "$task_binary" --version
    exit 0
  fi
  mkdir -p -- "$task_ollama_root/downloads" "$task_runtime"
  if [[ ! -f "$task_archive" ]]; then
    task_partial="$task_archive.partial"
    trap 'rm -f -- "$task_partial"' EXIT
    curl --fail --location --show-error --silent --retry 2 --connect-timeout 15 --max-time 600 \
      --output "$task_partial" "https://github.com/ollama/ollama/releases/download/v$task_version/ollama-linux-amd64.tar.zst"
    mv -- "$task_partial" "$task_archive"
    trap - EXIT
  fi
  printf '%s  %s\n' "$task_checksum" "$task_archive" | sha256sum --check --status || {
    echo 'Official release checksum mismatch; refusing to install or execute this archive.' >&2
    exit 1
  }
  task_members="$(mktemp "$task_ollama_root/members.XXXXXX")"
  task_selected="$(mktemp "$task_ollama_root/cpu-members.XXXXXX")"
  trap 'rm -f -- "$task_members" "$task_selected"' EXIT
  tar --zstd --list --file "$task_archive" > "$task_members"
  python3 - "$task_members" "$task_selected" <<'PY'
from pathlib import Path
import sys
names = Path(sys.argv[1]).read_text().splitlines()
selected = [name for name in names if name == 'bin/ollama' or (
    name.startswith('lib/ollama/') and len(name.split('/')) == 3
    and not name.endswith('/') and '..' not in name.split('/'))]
if 'bin/ollama' not in selected or 'lib/ollama/llama-server' not in selected:
    raise SystemExit('Unexpected official archive layout; refusing extraction.')
Path(sys.argv[2]).write_text('\n'.join(selected) + '\n')
PY
  tar --zstd --extract --file "$task_archive" --directory "$task_runtime" --files-from "$task_selected"
  "$task_binary" --version
  printf '%s\n' "$task_version" > "$task_runtime/.version"
  rm -f -- "$task_archive"
  echo "CPU runtime installed: $task_binary"
  exit 0
fi

[[ -x "$task_binary" ]] || { echo 'Run install first.' >&2; exit 1; }
export OLLAMA_HOST='127.0.0.1:11434'
export OLLAMA_MODELS="$task_ollama_root/models"
export OLLAMA_NO_CLOUD=1
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_MAX_QUEUE=4
export OLLAMA_CONTEXT_LENGTH=8192
export OLLAMA_KEEP_ALIVE='10m'

case "$task_mode" in
  serve)
    if curl --fail --silent --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
      echo 'A model server is already listening on 127.0.0.1:11434; inspect/reuse it.' >&2
      exit 1
    fi
    exec "$task_binary" serve
    ;;
  pull) exec "$task_binary" pull "$task_model" ;;
  check)
    python3 - "$task_model" <<'PY'
import json, sys, urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=5) as response:
        models = json.load(response).get('models', [])
    found = any(model.get('name') == sys.argv[1] or model.get('model') == sys.argv[1] for model in models)
except (OSError, ValueError):
    raise SystemExit('Local Ollama is unavailable; start serve first.')
print('Model installed' if found else 'Configured model is missing; run pull after network access is available.')
sys.exit(0 if found else 1)
PY
    ;;
  smoke)
    python3 - "$task_model" <<'PY'
import json, sys, urllib.request
body = {'model':sys.argv[1], 'stream':False, 'format':'json',
        'messages':[{'role':'user','content':'Return only this JSON object: {"ok":true}'}],
        'options':{'temperature':0,'num_ctx':2048,'num_predict':32}}
request = urllib.request.Request('http://127.0.0.1:11434/api/chat',
    data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request, timeout=120) as response:
    result=json.load(response)
assert result.get('done') is True, 'Inference did not complete'
answer=json.loads(result.get('message',{}).get('content',''))
assert answer.get('ok') is True, 'Unexpected model answer'
print('Real local Qwen inference passed')
PY
    ;;
esac
