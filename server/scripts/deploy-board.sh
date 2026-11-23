#!/usr/bin/env bash
#
# Deploy the two dsh-discuss servers on a release host.
#
#   server/scripts/deploy-board.sh start     create config/dirs if needed, start both, wait
#   server/scripts/deploy-board.sh status    pid, address, health, database
#   server/scripts/deploy-board.sh stop      stop both (TERM, then KILL)
#   server/scripts/deploy-board.sh restart   stop + start
#   server/scripts/deploy-board.sh logs      [discuss|admin] [--follow]
#   server/scripts/deploy-board.sh unit      write systemd --user units for both
#
# Options:
#   --config PATH      deployment config (default: <checkout>/server/discuss.config.json)
#   --data-dir PATH    default <checkout>/server/data
#   --run-dir PATH     pid files, default <checkout>/server/run
#   --log-dir PATH     default <checkout>/server/logs
#   --host ADDR        --port N --admin-host ADDR --admin-port N   (config creation only)
#   --wait SECONDS     health-check budget per service (default 20)
#   --enable           with `unit`: enable both units right away
#
# Both processes are started with setsid in their own session, so they outlive
# the shell that ran this script — and any DSH process that spawned it. Use
# `unit` when systemd should supervise them across reboots instead.
#
# Everything the deployment writes stays inside the checkout: the config
# (server/discuss.config.json), the SQLite database (server/data/), pid files
# (server/run/) and logs (server/logs/). All of those are gitignored.
#
# Exit codes: 0 success, 1 failure, 2 usage error.

set -euo pipefail

# Resolve the real script through any symlinks (a `ln -s .../deploy-board.sh
# /usr/local/bin/board` invocation must still find the checkout), then take the
# checkout root two levels up: <checkout>/server/scripts/deploy-board.sh.
SELF=${BASH_SOURCE[0]}
while [[ -L $SELF ]]; do
  link_dir=$(cd -- "$(dirname -- "$SELF")" && pwd -P)
  SELF=$(readlink -- "$SELF")
  [[ $SELF == /* ]] || SELF="$link_dir/$SELF"
done
SELF_DIR=$(cd -- "$(dirname -- "$SELF")" && pwd -P)
DEPLOY_DIR=$(cd -- "$SELF_DIR/../.." && pwd -P)

CONFIG="$DEPLOY_DIR/server/discuss.config.json"
DATA_DIR="$DEPLOY_DIR/server/data"
RUN_DIR="$DEPLOY_DIR/server/run"
LOG_DIR="$DEPLOY_DIR/server/logs"

# Only used when this script has to create the config file. Both servers bind
# every interface: a LAN board is unreachable from its clients otherwise, and
# the shipped example config carries the same defaults.
GEN_HOST=0.0.0.0
GEN_PORT=7801
GEN_ADMIN_HOST=0.0.0.0
GEN_ADMIN_PORT=7802

WAIT_SECONDS=${WAIT_SECONDS:-20}
STOP_SECONDS=${STOP_SECONDS:-10}

COMMAND=""
LOGS_TARGET=""
FOLLOW=0
ENABLE_UNIT=0
# Whether --host/--port/--admin-* were given: they only apply while creating
# the config, so warn only when the caller actually asked for them.
GEN_EXPLICIT=0

SERVICES=(discuss admin)
declare -A SCRIPT=(
  [discuss]="server/bin-discuss.js"
  [admin]="server/bin-admin.js"
)
declare -A DESCRIPTION=(
  [discuss]="dsh-discuss board server"
  [admin]="dsh-discuss admin server (topic writer)"
)

NODE=${NODE:-$(command -v node || true)}
CURL=${CURL:-$(command -v curl || true)}

# Resolved from the config by load_config.
HOST=0.0.0.0
PORT=7801
ADMIN_HOST=0.0.0.0
ADMIN_PORT=7802
DB_PATH=""

# ---------------------------------------------------------------- output ----

info() { printf '  %s\n' "$*"; }
warn() { printf 'deploy: %s\n' "$*" >&2; }
die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

# ------------------------------------------------------------------ args ----

need_value() {
  (($# >= 2)) || die "$1 needs a value"
}

while (($# > 0)); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --config | --data-dir | --run-dir | --log-dir | --host | --port | --admin-host | --admin-port | --wait)
      need_value "$@"
      case "$1" in
        --config) CONFIG=$2 ;;
        --data-dir) DATA_DIR=$2 ;;
        --run-dir) RUN_DIR=$2 ;;
        --log-dir) LOG_DIR=$2 ;;
        --host) GEN_HOST=$2; GEN_EXPLICIT=1 ;;
        --port) GEN_PORT=$2; GEN_EXPLICIT=1 ;;
        --admin-host) GEN_ADMIN_HOST=$2; GEN_EXPLICIT=1 ;;
        --admin-port) GEN_ADMIN_PORT=$2; GEN_EXPLICIT=1 ;;
        --wait) WAIT_SECONDS=$2 ;;
      esac
      shift 2
      ;;
    --follow | -f)
      FOLLOW=1
      shift
      ;;
    --enable)
      ENABLE_UNIT=1
      shift
      ;;
    -*)
      die "unknown option: $1 (see --help)"
      ;;
    *)
      if [[ -z $COMMAND ]]; then
        COMMAND=$1
      elif [[ $COMMAND == logs && -z $LOGS_TARGET ]]; then
        LOGS_TARGET=$1
      else
        die "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

# Relative --config paths resolve against the caller's pwd, like every other CLI;
# the directory must exist, so a typo fails here instead of as EACCES from mkdir.
config_dir=$(dirname -- "$CONFIG")
[[ -d $config_dir ]] || die "config directory does not exist: $config_dir"
CONFIG="$(cd -- "$config_dir" && pwd -P)/$(basename -- "$CONFIG")"

# ------------------------------------------------------------- config io ----

# Read one key from the deployment config, falling back to $2.
cfg() {
  "$NODE" -e '
    const fs = require("node:fs")
    const [, file, key, fallback] = process.argv
    let config = {}
    try { config = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
    const value = config[key]
    process.stdout.write(value === undefined || value === null ? fallback : String(value))
  ' "$CONFIG" "$1" "$2"
}

# Pull the addresses, ports and database path the deployment actually uses. A
# relative dbPath is anchored at the checkout, so a server started from any
# directory still writes one database.
load_config() {
  local database
  HOST=$(cfg host 0.0.0.0)
  PORT=$(cfg port 7801)
  ADMIN_HOST=$(cfg adminHost 0.0.0.0)
  ADMIN_PORT=$(cfg adminPort 7802)
  database=$(cfg dbPath "$DATA_DIR/discuss.db")
  case "$database" in
    /*) DB_PATH=$database ;;
    *) DB_PATH="$DEPLOY_DIR/${database#./}" ;;
  esac
}

# Write a fresh config from the shipped example, then pin this deployment's
# address, ports and absolute database path into it.
generate_config() {
  local template="$DEPLOY_DIR/server/discuss.config.example.json" base='{}' database
  mkdir -p -- "$(dirname -- "$CONFIG")"
  [[ -f $template ]] && base=$(cat -- "$template")
  database="$DATA_DIR/discuss.db"
  case "$database" in
    /*) : ;;
    *) database="$DEPLOY_DIR/${database#./}" ;;
  esac
  mkdir -p -- "$(dirname -- "$database")"
  "$NODE" -e '
    const fs = require("node:fs")
    const [, out, base, host, port, adminHost, adminPort, dbPath] = process.argv
    const config = {
      ...JSON.parse(base),
      host,
      port: Number(port),
      adminHost,
      adminPort: Number(adminPort),
      dbPath,
    }
    fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n")
  ' "$CONFIG" "$base" "$GEN_HOST" "$GEN_PORT" "$GEN_ADMIN_HOST" "$GEN_ADMIN_PORT" "$database"
  chmod 600 -- "$CONFIG"
  info "wrote $CONFIG"
}

ensure_config() {
  if [[ ! -f $CONFIG ]]; then
    generate_config
  elif ((GEN_EXPLICIT)); then
    warn "--host/--port only apply when the config is created; editing $CONFIG is ignored"
  fi
  load_config
}

prepare_dirs() {
  mkdir -p -- "$DATA_DIR" "$RUN_DIR" "$LOG_DIR" "$(dirname -- "$DB_PATH")"
}

# ------------------------------------------------------------------ paths ----

pid_file() { printf '%s/%s.pid' "$RUN_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$LOG_DIR" "$1"; }

read_pid() {
  local file
  file=$(pid_file "$1")
  [[ -f $file ]] && cat -- "$file" 2>/dev/null || true
}

# A pid is ours only when its command line names this deployment's script and
# config: a recycled pid or a dead pid file must never be signalled.
pid_is_ours() {
  local name=$1 pid=$2
  [[ -n $pid && -r /proc/$pid/cmdline ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq -- "server/bin-$name.js --config=$CONFIG"
}

# Last resort: recover the pid from the command line, so `stop` still works
# after a lost pid file. Only this deployment's exact config matches.
find_pid() {
  local candidate
  for candidate in $(pgrep -f -- "server/bin-$1.js" 2>/dev/null); do
    if pid_is_ours "$1" "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
}

# ----------------------------------------------------------------- health ----

# The address a client on this host should use: a wildcard bind answers on
# loopback, anything else is used as written.
probe_host() {
  local host=$HOST
  [[ $1 == admin ]] && host=$ADMIN_HOST
  case "$host" in
    '' | 0.0.0.0) host=127.0.0.1 ;;
    '::' | '[::]') host='[::1]' ;;
  esac
  printf '%s' "$host"
}

service_port() {
  if [[ $1 == admin ]]; then printf '%s' "$ADMIN_PORT"; else printf '%s' "$PORT"; fi
}

service_url() {
  printf 'http://%s:%s/' "$(probe_host "$1")" "$(service_port "$1")"
}

# Any HTTP answer means the listener is up; `/healthz` is the route both
# servers answer, so a probe never looks like an unknown route in their logs.
# The last probe's address and answer are kept for `status` to explain a down
# service instead of leaving the reader to guess.
PROBE_URL=""
PROBE_ANSWER=""
is_up() {
  local url out code reason
  url="$(service_url "$1")healthz"
  # A user-wide http_proxy must not intercept a probe of the local listener.
  out=$("$CURL" -sS --noproxy '*' -o /dev/null -m 2 -w '\n%{http_code}' "$url" 2>&1 || true)
  code=${out##*$'\n'}
  reason=${out%$'\n'*}
  code=${code:-000}
  [[ $code =~ ^[0-9]{3}$ ]] || { reason=$out; code=000; }
  PROBE_URL=$url
  if [[ $code == 000 && -n $reason ]]; then
    PROBE_ANSWER="000 ($(printf '%s' "$reason" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-160))"
  else
    PROBE_ANSWER=$code
  fi
  [[ $code =~ ^[0-9]{3}$ && $code != 000 ]]
}

wait_up() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  while ((SECONDS < deadline)); do
    is_up "$1" && return 0
    sleep 0.25
  done
  return 1
}

# Something else holds the port: name the port instead of failing obscurely.
assert_port_free() {
  local port
  port=$(service_port "$1")
  is_up "$1" && return 0
  if (exec 3<>"/dev/tcp/$(probe_host "$1")/$port") 2>/dev/null; then
    die "port $port is already in use by another process; stop it or change $CONFIG"
  fi
}

# ------------------------------------------------------------------ start ----

rotate_log() {
  local file=$1 size
  [[ -f $file ]] || return 0
  size=$(wc -c <"$file" 2>/dev/null || echo 0)
  if ((size > 10 * 1024 * 1024)); then
    mv -f -- "$file" "$file.1"
  fi
}

start_service() {
  local name=$1 script log pid
  script="$DEPLOY_DIR/${SCRIPT[$name]}"
  log=$(log_file "$name")

  if is_up "$name"; then
    info "$name already up: $(service_url "$name")"
    return 0
  fi
  assert_port_free "$name"
  rotate_log "$log"

  # Own session, so neither a closed terminal nor a dying DSH takes it down.
  # DISCUSS_CONFIG is unset on purpose: --config is this deployment's truth.
  pushd "$DEPLOY_DIR" >/dev/null
  if command -v setsid >/dev/null 2>&1; then
    setsid env -u DISCUSS_CONFIG "$NODE" "$script" --config="$CONFIG" >>"$log" 2>&1 &
  else
    env -u DISCUSS_CONFIG "$NODE" "$script" --config="$CONFIG" >>"$log" 2>&1 &
    disown || true
  fi
  pid=$!
  popd >/dev/null

  sleep 0.3
  if ! kill -0 "$pid" 2>/dev/null; then
    # setsid forks when it already leads a process group; recover the child.
    pid=$(find_pid "$name")
  fi
  [[ -n ${pid:-} ]] || die "$name failed to start; see $log"
  printf '%s\n' "$pid" >"$(pid_file "$name")"

  if ! wait_up "$name"; then
    tail -n 20 -- "$log" >&2 || true
    die "$name did not answer within ${WAIT_SECONDS}s (log: $log)"
  fi
  info "$name up: pid $pid on $(service_url "$name")"
}

# ------------------------------------------------------------------- stop ----

stop_service() {
  local name=$1 pid deadline
  pid=$(read_pid "$name")
  if ! pid_is_ours "$name" "$pid"; then
    pid=$(find_pid "$name")
  fi
  if [[ -z $pid ]] || ! pid_is_ours "$name" "$pid"; then
    rm -f -- "$(pid_file "$name")"
    info "$name not running"
    return 0
  fi

  if ! kill -TERM "$pid" 2>/dev/null; then
    die "$name (pid $pid) belongs to another user; run this script as that user or as root"
  fi
  deadline=$((SECONDS + STOP_SECONDS))
  while [[ -d /proc/$pid ]] && ((SECONDS < deadline)); do
    sleep 0.2
  done
  if [[ -d /proc/$pid ]]; then
    warn "$name ignored SIGTERM for ${STOP_SECONDS}s; sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.2
  fi
  if [[ -d /proc/$pid ]]; then
    die "$name (pid $pid) is still alive; stop it manually"
  fi
  rm -f -- "$(pid_file "$name")"
  info "$name stopped (pid $pid)"
}

# --------------------------------------------------------------- database ----

db_report() {
  if [[ -z $DB_PATH ]]; then
    info "database: (config not read yet)"
    return 0
  fi
  if [[ ! -f $DB_PATH ]]; then
    info "database: $DB_PATH (not created yet)"
    return 0
  fi
  info "database: $DB_PATH ($(wc -c <"$DB_PATH" | tr -d ' ') bytes)"
  "$NODE" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite")
    const [file] = process.argv.slice(1)
    const db = new DatabaseSync(file, { readOnly: true })
    const count = table => {
      try { return db.prepare("select count(*) c from " + table).get().c } catch { return "?" }
    }
    console.log("  rows: sessions=" + count("sessions") + " topics=" + count("topics")
      + " subscriptions=" + count("subscriptions") + " messages=" + count("messages"))
  ' "$DB_PATH" 2>/dev/null || info "rows: unreadable (locked, or not initialised yet)"
}

# ----------------------------------------------------------------- status ----

cmd_status() {
  local name pid state
  echo "dsh-discuss deployment"
  info "checkout: $DEPLOY_DIR"
  if [[ -f $CONFIG ]]; then info "config:   $CONFIG"; else info "config:   $CONFIG (missing, defaults apply)"; fi
  for name in "${SERVICES[@]}"; do
    pid=$(read_pid "$name")
    # A pid file outlives the process; say so instead of printing a stale number.
    # /proc/$pid exists for every user's live process, while kill -0 fails with
    # EPERM on another user's pid and would call a live service dead.
    if [[ -n $pid ]] && [[ ! -d /proc/$pid ]]; then pid="$pid (dead)"; fi
    if is_up "$name"; then state=up; else state=down; fi
    printf '  %-8s %-4s %-30s pid %s\n' "$name" "$state" "$(service_url "$name")" "${pid:--}"
    info "log:      $(log_file "$name")"
    if [[ $state == down ]]; then
      info "probe:    $PROBE_URL -> ${PROBE_ANSWER:-no answer}"
    fi
  done
  db_report
}

# ------------------------------------------------------------------- logs ----

cmd_logs() {
  local name=${LOGS_TARGET:-discuss} file
  [[ $name == discuss || $name == admin ]] || die "logs: unknown service '$name' (discuss|admin)"
  file=$(log_file "$name")
  [[ -f $file ]] || die "no log yet: $file"
  if ((FOLLOW)); then
    tail -n 50 -F -- "$file"
  else
    tail -n 50 -- "$file"
  fi
}

# --------------------------------------------------------------- systemd ----

write_unit() {
  local name=$1 dir="$HOME/.config/systemd/user"
  mkdir -p -- "$dir"
  cat >"$dir/dsh-$name.service" <<EOF
[Unit]
Description=${DESCRIPTION[$name]}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DEPLOY_DIR
Environment=NODE_ENV=production
ExecStart=$NODE $DEPLOY_DIR/${SCRIPT[$name]} --config=$CONFIG
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  info "wrote $dir/dsh-$name.service"
}

cmd_unit() {
  local name
  for name in "${SERVICES[@]}"; do write_unit "$name"; done
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || warn "systemctl --user daemon-reload failed"
    if ((ENABLE_UNIT)); then
      systemctl --user enable --now dsh-discuss dsh-discuss-admin ||
        die "systemctl --user enable --now failed"
      info "enabled: dsh-discuss, dsh-discuss-admin"
    fi
  fi
  cat <<EOF

Free the ports from the setsid processes before systemd owns them:
  $0 stop

Then:
  systemctl --user enable --now dsh-discuss dsh-discuss-admin
  systemctl --user status dsh-discuss
  loginctl enable-linger $USER     # keep them running without a login session
EOF
}

# ------------------------------------------------------------------- main ----

preflight() {
  [[ -n ${NODE:-} ]] || die "node not found in PATH (set NODE=/path/to/node)"
  [[ -n ${CURL:-} ]] || die "curl not found in PATH (set CURL=/path/to/curl)"
  local major minor name
  major=$("$NODE" -p 'Number(process.versions.node.split(".")[0])')
  minor=$("$NODE" -p 'Number(process.versions.node.split(".")[1])')
  if ((major < 22 || (major == 22 && minor < 5))); then
    die "node $("$NODE" --version) is too old: the servers need node:sqlite (>= 22.5)"
  fi
  "$NODE" -e 'require("node:sqlite")' >/dev/null 2>&1 ||
    die "node:sqlite is unavailable in $("$NODE" --version)"
  for name in "${SERVICES[@]}"; do
    [[ -f $DEPLOY_DIR/${SCRIPT[$name]} ]] ||
      die "missing ${SCRIPT[$name]}: run this from a full checkout or release tarball"
  done
}

start_all() {
  local name
  for name in "${SERVICES[@]}"; do start_service "$name"; done
}

stop_all() {
  local name
  for name in "${SERVICES[@]}"; do stop_service "$name"; done
}

case "$COMMAND" in
  start)
    preflight
    ensure_config
    prepare_dirs
    start_all
    echo
    cmd_status
    ;;
  stop)
    ensure_config
    stop_all
    ;;
  restart)
    ensure_config
    stop_all
    preflight
    prepare_dirs
    start_all
    echo
    cmd_status
    ;;
  status)
    load_config
    cmd_status
    ;;
  logs)
    cmd_logs
    ;;
  unit)
    preflight
    ensure_config
    prepare_dirs
    cmd_unit
    ;;
  '')
    usage
    exit 2
    ;;
  *)
    die "unknown command: $COMMAND (see --help)"
    ;;
esac
