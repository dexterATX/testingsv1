#!/usr/bin/env bash
#
# Deploys the research toolkit onto a Hostinger VPS (Debian 13 / Ubuntu 24.04).
#
# Run it as root ON THE VPS — over SSH, or in hPanel's browser terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/dexterATX/testingsv1/claude/exa-api-setup-fjzybl/deploy/hostinger.sh -o hostinger.sh
#   less hostinger.sh          # read it before running it as root
#   bash hostinger.sh
#
# What it does:
#   1. Installs Node 22 if the box does not already have it
#   2. Clones the repo to /opt/research-toolkit as an unprivileged service user
#   3. Writes /etc/research-toolkit.env (mode 600) with the API keys it prompts for
#   4. Installs a systemd unit bound to 127.0.0.1 only
#   5. Puts a reverse proxy in front of it with HTTPS and a password
#
# It is written for a box that is ALREADY DOING SOMETHING. It never edits an
# existing web server config it did not create, it takes a port nobody is
# using, and every step is idempotent — a second run updates rather than
# duplicates.
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dexterATX/testingsv1.git}"
REPO_REF="${REPO_REF:-claude/exa-api-setup-fjzybl}"
APP_DIR="${APP_DIR:-/opt/research-toolkit}"
APP_USER="${APP_USER:-research}"
ENV_FILE="${ENV_FILE:-/etc/research-toolkit.env}"
APP_PORT="${APP_PORT:-4317}"
SERVICE="research-toolkit"

# Public port for the site. 443 is the default; set another when the box
# already serves something on 443 and you want this alongside it rather than
# instead of it.
PUBLIC_PORT="${PUBLIC_PORT:-443}"

# `password` puts one basic-auth login in front of the UI; `none` leaves it
# open to anyone with the URL.
#
# The default is `password` because the page has no login of its own and this
# process holds live API keys — an open URL means anyone who finds it can spend
# them, and hostnames on shared provider domains get port-scanned. `none` is a
# supported choice, not an accident, and the script says so on the way out.
UI_AUTH="${UI_AUTH:-password}"
UI_USER="${UI_USER:-research}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- preflight ---

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash $0)"

# `command -v systemctl` is not enough: the binary is present inside plenty of
# containers where systemd is not PID 1 and every systemctl call fails with a
# bus error halfway through the deploy.
command -v systemctl >/dev/null || die "this script needs systemd"
[ -d /run/systemd/system ] || die "systemd is not running as PID 1 here.
    That happens inside containers and some LXC-based VPS plans. Run this on a
    KVM VPS, or start the app yourself:
        cd $APP_DIR && npm ci && npm run build && node dist/server/main.js"

say "Checking what already runs on this box"

# `ss` comes from iproute2. It is on every Hostinger template, but a missing
# one must not take the script down — under `set -e` an unguarded failure here
# aborts with no output at all, which is a horrible way to fail on someone
# else's server.
if ! command -v ss >/dev/null 2>&1; then
  info "installing iproute2 for the port check"
  apt-get update -qq && apt-get install -y -qq iproute2 >/dev/null 2>&1 || true
fi

listening_on() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltnpH "sport = :$1" 2>/dev/null | head -1 || true
}

if [ -n "$(listening_on "$APP_PORT" || true)" ]; then
  die "port $APP_PORT is already in use. Re-run with APP_PORT=<free port>."
fi

http_owner="$(listening_on 80 || true)"
https_owner="$(listening_on 443 || true)"
info "port 80:  ${http_owner:-free}"
info "port 443: ${https_owner:-free}"

if [ "$PUBLIC_PORT" != 443 ]; then
  public_owner="$(listening_on "$PUBLIC_PORT" || true)"
  info "port $PUBLIC_PORT: ${public_owner:-free}"
  [ -z "$public_owner" ] || die "port $PUBLIC_PORT is taken. Re-run with PUBLIC_PORT=<free port>."
fi

case "$UI_AUTH" in
  password|none) ;;
  *) die "UI_AUTH must be 'password' or 'none', got '$UI_AUTH'" ;;
esac

# Which proxy strategy applies. Decided here, acted on at the end, so the
# script fails before it has changed anything rather than halfway through.
if command -v caddy >/dev/null 2>&1; then
  PROXY_MODE=caddy-existing
elif [ -z "$https_owner" ] && [ -z "$http_owner" ]; then
  PROXY_MODE=caddy-install
else
  PROXY_MODE=manual
fi
info "proxy strategy: $PROXY_MODE"

HOSTNAME_FQDN="${PUBLIC_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
info "public hostname: $HOSTNAME_FQDN"

# ------------------------------------------------------------------- keys ---

say "API keys"

# Never bake keys into the repo. Re-running keeps whatever is already on disk.
declare -A KEYS=()
if [ -f "$ENV_FILE" ]; then
  info "$ENV_FILE exists — keeping the keys already in it"
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

prompt_key() {
  local name="$1" required="$2" current="${!1:-}"
  if [ -n "$current" ]; then
    info "$name: already set"
    KEYS["$name"]="$current"
    return
  fi

  # Piped into bash, or run from cron, there is no terminal to prompt on. Say
  # so instead of hanging or silently continuing without the key.
  #
  # `[ -r /dev/tty ]` is not the test: with no controlling terminal the node
  # still exists and passes the permission check, and only the open fails
  # (ENXIO). Probe it by opening it.
  # The redirect has to wrap the whole group: bash applies redirections left to
  # right, so `: < /dev/tty 2>/dev/null` reports the failure before stderr has
  # been silenced.
  local tty_ok=''
  if { : < /dev/tty ; } 2>/dev/null; then tty_ok=1; fi

  if [ -z "$tty_ok" ] && [ ! -t 0 ]; then
    [ -n "$required" ] && die "$name is not set and there is no terminal to prompt on.
    Run the script from an interactive shell, or pass the key in:
        $name=... bash $0"
    KEYS["$name"]=''
    return
  fi

  local value=''
  if [ -n "$tty_ok" ]; then
    read -rsp "    $name${required:+ (required)}: " value < /dev/tty
  else
    read -rsp "    $name${required:+ (required)}: " value
  fi
  echo
  if [ -z "$value" ] && [ -n "$required" ]; then
    die "$name is required"
  fi
  KEYS["$name"]="$value"
}

prompt_key EXA_API_KEY required
prompt_key VOXELL_API_KEY required
info "one write-up key — leave both blank to run without the synthesis step"
prompt_key FIREWORKS_API_KEY ''
prompt_key ANTHROPIC_API_KEY ''

# ------------------------------------------------------------------- node ---

say "Node 22"

# Resolve the interpreter ONCE and use that exact path everywhere — the unit
# file, the build, the install. Checking `node` on root's PATH and then writing
# `/usr/bin/node` into the unit is how you get a script that reports success
# and a service that will not boot: nvm, a snap, or a hand-rolled /opt install
# all put a different node on root's PATH than the one systemd would find.
node_major() { [ -x "$1" ] && "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

NODE_BIN=''
for candidate in /usr/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ "$(node_major "$candidate")" -ge 20 ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  info "installing from NodeSource"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  NODE_BIN=/usr/bin/node
fi

[ -x "$NODE_BIN" ] || die "no usable node after install"
NODE_DIR="$(dirname "$NODE_BIN")"
NPM_BIN="$NODE_DIR/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"
[ -x "$NPM_BIN" ] || die "found node at $NODE_BIN but no npm alongside it"
info "using $NODE_BIN ($("$NODE_BIN" --version))"

command -v git >/dev/null || apt-get install -y -qq git >/dev/null

# `sudo -u` resets PATH and drops the environment, so the service user would
# otherwise resolve a different node than the one just chosen — and lose the
# proxy settings npm needs on a box that reaches the internet through one.
run_as_app() {
  local passthrough=()
  for var in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy \
             NODE_EXTRA_CA_CERTS NPM_CONFIG_REGISTRY; do
    [ -n "${!var:-}" ] && passthrough+=("$var=${!var}")
  done

  sudo -u "$APP_USER" env \
    HOME="/home/$APP_USER" \
    PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
    "${passthrough[@]}" \
    "$@"
}

# -------------------------------------------------------------------- app ---

say "Application at $APP_DIR"

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
  info "created service user $APP_USER"
fi

# The checkout is owned by $APP_USER; git refuses to read it as root without
# this, and that refusal is easy to miss because it still exits 0 in a `$(...)`.
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

if [ -d "$APP_DIR/.git" ]; then
  info "updating existing checkout"
  run_as_app git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  run_as_app git -C "$APP_DIR" fetch --depth 1 origin "$REPO_REF"
  run_as_app git -C "$APP_DIR" checkout -B "$REPO_REF" FETCH_HEAD
else
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  run_as_app git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
fi
info "at commit $(run_as_app git -C "$APP_DIR" rev-parse --short HEAD)"

info "installing dependencies"
run_as_app "$NPM_BIN" --prefix "$APP_DIR" ci --no-audit --no-fund >/dev/null

# npm can print a wall of errors and still exit 0 ("Exit handler never
# called!"), so trust the filesystem rather than the exit status.
[ -x "$APP_DIR/node_modules/.bin/tsc" ] \
  || die "npm ci did not produce a complete node_modules — check the npm log above"

# Compile rather than run TypeScript through a loader in production: the unit
# then starts plain node, and a type error surfaces here instead of at boot.
info "building"
run_as_app "$NPM_BIN" --prefix "$APP_DIR" run build >/dev/null
[ -f "$APP_DIR/dist/server/main.js" ] || die "build did not produce dist/server/main.js"

# The embedding cache; a repeat question then costs nothing.
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/.cache"

# -------------------------------------------------------------------- env ---

say "Writing $ENV_FILE"

# The umask stays inside this subshell.
#
# Setting `umask 077` at top level to protect this one file silently applies
# to every file the script writes afterwards — and most of those are read by
# somebody other than root: apt's keyring by `_apt`, the Caddy site file by
# the `caddy` user. They fail with a permission error that points at the
# reader, never at the umask that caused it.
(
  umask 077
  {
    echo "# Written by deploy/hostinger.sh. Mode 600, root-owned, read by systemd."
    for name in EXA_API_KEY VOXELL_API_KEY FIREWORKS_API_KEY ANTHROPIC_API_KEY; do
      [ -n "${KEYS[$name]:-}" ] && printf '%s=%s\n' "$name" "${KEYS[$name]}"
    done
    echo "PORT=$APP_PORT"
    echo "HOST=127.0.0.1"
  } > "$ENV_FILE"
)
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
info "$(grep -c '=' "$ENV_FILE") variables, mode 600"

# ---------------------------------------------------------------- systemd ---

say "systemd unit"

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Research toolkit web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/dist/server/main.js
Restart=always
RestartSec=3

# The process holds three API keys. Give it as little of the box as possible.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/.cache
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryMax=2G

[Install]
WantedBy=multi-user.target
UNIT

chmod 644 "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null
sleep 3

systemctl is-active --quiet "$SERVICE" || {
  journalctl -u "$SERVICE" -n 30 --no-pager
  die "service failed to start"
}
info "service running, listening on 127.0.0.1:$APP_PORT"

curl -fsS -m 10 "http://127.0.0.1:$APP_PORT/api/config" >/dev/null \
  && info "health check OK" \
  || die "service is up but /api/config did not answer"

# ------------------------------------------------------------------ proxy ---

say "Public access"

PASSWORD="${UI_PASSWORD:-$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)}"

# The site address. On a box already serving its root hostname, a distinct
# port puts this alongside that site instead of colliding with it — Caddy
# still gets a real certificate, because ACME validation uses port 80.
if [ "$PUBLIC_PORT" = 443 ]; then
  SITE_ADDR="$HOSTNAME_FQDN"
  PUBLIC_URL="https://$HOSTNAME_FQDN/"
else
  SITE_ADDR="$HOSTNAME_FQDN:$PUBLIC_PORT"
  PUBLIC_URL="https://$HOSTNAME_FQDN:$PUBLIC_PORT/"
fi

# Opens the public port on whichever host firewall is actually in charge.
# Nothing to do when neither is active — Hostinger KVM boxes ship with no
# host firewall, and the cloud firewall is a separate thing entirely.
open_firewall_port() {
  local port="$1"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$port/tcp" >/dev/null 2>&1 && info "opened $port/tcp in ufw"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$port/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 && info "opened $port/tcp in firewalld"
  fi
}

case "$PROXY_MODE" in
  caddy-install|caddy-existing)
    if [ "$PROXY_MODE" = caddy-install ]; then
      info "installing Caddy"
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null

      # apt verifies signatures as the `_apt` user, so the keyring and the
      # source list must be world-readable. `--yes` because gpg refuses to
      # overwrite an existing file and would otherwise wedge a re-run.
      rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
        | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg

      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
        > /etc/apt/sources.list.d/caddy-stable.list
      chmod 644 /etc/apt/sources.list.d/caddy-stable.list

      apt-get update -qq
      apt-get install -y -qq caddy >/dev/null
    else
      info "reusing the Caddy already on this box"
    fi

    # Its own file under Caddyfile's import glob — the existing Caddyfile is
    # never edited, so nothing already being served can break.
    install -d /etc/caddy/conf.d

    if [ "$UI_AUTH" = password ]; then
      HASH="$(caddy hash-password --plaintext "$PASSWORD")"
      AUTH_BLOCK=$'\tbasic_auth {\n\t\t'"$UI_USER $HASH"$'\n\t}\n'
    else
      AUTH_BLOCK=''
    fi

    cat > "/etc/caddy/conf.d/$SERVICE.caddy" <<CADDY
$SITE_ADDR {
$AUTH_BLOCK	reverse_proxy 127.0.0.1:$APP_PORT {
		# The pipeline streams over SSE and a deep search can take minutes.
		flush_interval -1
		transport http {
			response_header_timeout 10m
		}
	}
}
CADDY

    # Caddy runs as the `caddy` user, not as root: a 600 site file validates
    # fine (validate runs as root) and then fails on reload.
    chmod 644 "/etc/caddy/conf.d/$SERVICE.caddy"

    if ! grep -q 'conf.d/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
      printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
    fi

    # Validate before reloading, and roll back if it fails. On a box already
    # serving a live site, loading a broken config is the one failure mode that
    # costs more than this deploy failing.
    #
    # This is also what catches a site address Caddy already serves — that is
    # an "ambiguous site definition" error, not something to pre-check by
    # grepping the adapted JSON, which stores host and port separately and so
    # never matches "host:port".
    if ! validation="$(caddy validate --config /etc/caddy/Caddyfile 2>&1)"; then
      rm -f "/etc/caddy/conf.d/$SERVICE.caddy"
      die "the new Caddy site did not validate, so it has been removed and the
    running config is untouched. Caddy said:

    $(printf '%s' "$validation" | grep -i error | head -2)

    If that mentions an ambiguous site definition, this box already serves
    $SITE_ADDR. Re-run with PUBLIC_PORT=<other port>."
    fi

    open_firewall_port "$PUBLIC_PORT"
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    ;;

  manual)
    # Something else owns :80/:443. Editing a config that is serving a live
    # site is not this script's call to make, so it stops and hands over.
    PUBLIC_URL=''
    ;;
esac

# ----------------------------------------------------------------- report ---

say "Done"

cat <<SUMMARY

  service     systemctl status $SERVICE
  logs        journalctl -u $SERVICE -f
  app         127.0.0.1:$APP_PORT  (never bound to a public interface)
  keys        $ENV_FILE  (root, 600)
  code        $APP_DIR  @ $(git -C "$APP_DIR" rev-parse --short HEAD)
SUMMARY

if [ -n "$PUBLIC_URL" ] && [ "$UI_AUTH" = password ]; then
  cat <<SUMMARY
  url         $PUBLIC_URL
  login       $UI_USER / $PASSWORD

  Save that password now — it is not stored anywhere in plaintext.

  The certificate is issued on first request, so give the very first load
  a few seconds.
SUMMARY
elif [ -n "$PUBLIC_URL" ]; then
  cat <<SUMMARY
  url         $PUBLIC_URL
  login       none — open to anyone with the URL (UI_AUTH=none)

  The certificate is issued on first request, so give the very first load
  a few seconds.

  Open means open: every visitor spends your API credits, and this host is
  on a provider domain that gets scanned. Worth having a spend cap on the
  keys. To put a password on it later:

      UI_AUTH=password bash $0

  and to watch what it is actually serving:

      journalctl -u caddy -f
SUMMARY
else
  cat <<SUMMARY

  The app is running but NOT reachable from outside: $http_owner$https_owner
  already owns ports 80/443, and this script will not edit a web server config
  it did not write.

  Either reach it over an SSH tunnel from your own machine:

      ssh -N -L $APP_PORT:127.0.0.1:$APP_PORT root@$HOSTNAME_FQDN
      # then open http://127.0.0.1:$APP_PORT

  or add this to the web server that already runs here, and give it a password
  — the UI has no login and this process holds live API keys:

      location / {
          proxy_pass http://127.0.0.1:$APP_PORT;
          proxy_http_version 1.1;
          proxy_buffering off;            # SSE
          proxy_read_timeout 600s;        # a deep search takes minutes
          auth_basic "research";
          auth_basic_user_file /etc/nginx/.htpasswd;
      }
SUMMARY
fi
echo
