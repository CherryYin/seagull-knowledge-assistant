import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/dev-stack.sh", import.meta.url));
const urls = "http://127.0.0.1:8000/health http://127.0.0.1:3080/ http://127.0.0.1:4000/api/health http://127.0.0.1:5173/";

test("profile installation prepares upstream dependencies, both build faces and the web shell", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../deepseek-knowledge-lab/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["profiles:install"],
    "CI=true pnpm --dir dsh-harness install --frozen-lockfile && CI=true pnpm --dir dsh-harness run build:native-system && CI=true pnpm --dir dsh-harness run build:lib && CI=true pnpm --dir dsh-harness run build:web && pnpm --dir .dsh/profiles/headless install && pnpm --dir .dsh/profiles/web install");
});

function runShell(body, externalUrls = "") {
  const directory = mkdtempSync(join(tmpdir(), "seagull-stack-test-"));
  try {
    const result = spawnSync("bash", ["-c", `
      source "$1" help >/dev/null
      RUN_ROOT="$2/run"
      LOG_ROOT="$2/logs"
      TEST_EVENTS="$2/events"
      check_prerequisites() { :; }
      curl() {
        local url="\${!#}"
        [[ " $TEST_EXTERNAL_URLS " == *" $url "* ]] || return 7
        printf '200'
      }
      docker() { printf 'docker %s\\n' "$*" >>"$TEST_EVENTS"; }
      ${body}
    `, "dev-stack-test", script, directory], {
      encoding: "utf8", timeout: 10000,
      env: {
        ...process.env,
        PKG_URL: "http://127.0.0.1:8000",
        HARNESS_URL: "http://127.0.0.1:3080",
        BFF_URL: "http://127.0.0.1:4000",
        SEAGULL_URL: "http://127.0.0.1:5173",
        TEST_EXTERNAL_URLS: externalUrls,
      },
    });
    assert.ifError(result.error);
    const files = readdirSync(directory, { recursive: true });
    const events = files.includes("events") ? readFileSync(join(directory, "events"), "utf8") : "";
    return { ...result, files, events };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("unresolved Harness merges fail before infrastructure or services start", () => {
  const result = runShell(`
    git() { printf 'pnpm-lock.yaml\\npython/sdk-runtime/package.json\\n'; }
    check_prerequisites() { check_harness_checkout; }
    start_infrastructure() { echo infrastructure >>"$TEST_EVENTS"; }
    start_service() { echo "start $1" >>"$TEST_EVENTS"; }
    start_stack
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Harness has unresolved merge conflicts/);
  assert.match(result.stderr, /python\/sdk-runtime\/package.json/);
  assert.match(result.stderr, /profiles:install/);
  assert.equal(result.events, "");
});

test("Harness check allows a resolved checkout", () => {
  const result = runShell(`
    git() { return 0; }
    check_harness_checkout
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("Harness check fails closed when Git cannot inspect the checkout", () => {
  const result = runShell(`
    git() { return 128; }
    check_harness_checkout
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not inspect the Harness checkout/);
});

test("unmanaged collisions fail before infrastructure or scheduled jobs start", () => {
  const result = runShell(`
    start_infrastructure() { echo infrastructure >>"$TEST_EVENTS"; }
    start_service() { echo "start $1" >>"$TEST_EVENTS"; }
    start_stack
  `, "http://127.0.0.1:3080/");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /harness URL is already served by an unmanaged process/);
  assert.match(result.stdout, /npm run stack:start -- --reuse-existing/);
  assert.equal(result.events, "");
});

test("explicit reuse never adopts processes or writes PID files", () => {
  const result = runShell(`
    start_stack --skip-infra --skip-worker --reuse-existing
    printf 'started=%s\\n' "\${#STARTED_SERVICES[@]}"
    stop_stack --keep-infra
  `, urls);
  assert.equal(result.status, 0, result.stderr);
  for (const service of ["pkg-api", "harness", "bff", "seagull"]) {
    assert.match(result.stdout, new RegExp(`reusing ${service} at`));
    assert.match(result.stdout, new RegExp(`${service} is not managed by this script`));
  }
  assert.match(result.stdout, /started=0/);
  assert.ok(!result.files.some(file => file.endsWith(".pid")));
  assert.equal(result.events, "");
});

test("status distinguishes healthy external services from stopped processes", () => {
  const result = runShell("show_status", urls);
  assert.equal(result.status, 0, result.stderr);
  for (const service of ["pkg-api", "harness", "bff", "seagull"]) {
    assert.match(result.stdout, new RegExp(`${service}\\s+external\\s+-`));
  }
  assert.match(result.stdout, /pkg-worker\s+stopped\s+-/);
});

test("managed processes remain idempotent without checking or adopting another endpoint", () => {
  const result = runShell(`
    is_running() { [[ "$1" == harness ]]; }
    read_pid() { printf '12345'; }
    curl() { echo unexpected-network >>"$TEST_EVENTS"; return 1; }
    start_service harness "$2" "$HARNESS_URL/" /bin/false
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /harness already running \(PID 12345\)/);
  assert.equal(result.events, "");
});

test("failed startup rolls back only newly managed processes and leaves reused services alone", () => {
  const result = runShell(`
    definition=$(declare -f start_service)
    eval "\${definition/start_service/original_start_service}"
    start_service() {
      case "$1" in
        pkg-api) STARTED_SERVICES+=(pkg-api); echo 'start pkg-api' >>"$TEST_EVENTS" ;;
        harness) original_start_service "$@" ;;
        bff) echo 'simulated Gateway failure' >&2; return 1 ;;
        *) return 1 ;;
      esac
    }
    stop_service() { echo "stop $1" >>"$TEST_EVENTS"; }
    start_stack --skip-infra --skip-worker --reuse-existing
  `, "http://127.0.0.1:3080/");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /reusing harness/);
  assert.match(result.stdout, /startup failed/);
  assert.equal(result.events, "start pkg-api\nstop pkg-api\n");
});

test("unresponsive endpoints are never reported as reused", () => {
  const result = runShell(`
    REUSE_EXISTING=true
    mkdir -p "$RUN_ROOT" "$LOG_ROOT"
    if start_service harness "$2" "$HARNESS_URL/" /bin/false; then
      exit 9
    fi
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /starting harness/);
  assert.match(result.stdout, /harness failed to start/);
  assert.doesNotMatch(result.stdout, /reusing harness/);
});

test("unknown flags still fail instead of starting services", () => {
  const result = runShell("start_stack --reuse-existing --not-a-real-flag");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown start option/);
  assert.equal(result.events, "");
});

const harnessAuthPrompt = "dsh web authentication required; reopen the URL printed by dsh web.";

test("Harness auth prompt passes readiness without credentials or disabling auth", () => {
  const result = runShell(`
    curl() {
      if [[ " $* " == *' --write-out '* ]]; then printf '401';
      else printf '%s\\n' '${harnessAuthPrompt}'; fi
    }
    is_running() { return 0; }
    wait_for_url harness "$HARNESS_URL/"
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("authenticated unmanaged Harness is detected before starting anything", () => {
  const result = runShell(`
    curl() {
      [[ "\${!#}" == "$HARNESS_URL/" ]] || return 7
      if [[ " $* " == *' --write-out '* ]]; then printf '401';
      else printf '%s\\n' '${harnessAuthPrompt}'; fi
    }
    start_infrastructure() { echo infrastructure >>"$TEST_EVENTS"; }
    start_service() { echo "start $1" >>"$TEST_EVENTS"; }
    start_stack
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /harness URL is already served by an unmanaged process/);
  assert.equal(result.events, "");
});

test("authenticated Harness can be reused and shown as external without adoption", () => {
  const result = runShell(`
    curl() {
      [[ "\${!#}" == "$HARNESS_URL/" ]] || return 7
      if [[ " $* " == *' --write-out '* ]]; then printf '401';
      else printf '%s\\n' '${harnessAuthPrompt}'; fi
    }
    REUSE_EXISTING=true
    start_service harness "$2" "$HARNESS_URL/" /bin/false
    show_status
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reusing harness/);
  assert.match(result.stdout, /harness\s+external\s+-/);
  assert.ok(!result.files.some(file => file.endsWith(".pid")));
});

test("readiness rejects generic auth errors, forbidden, server errors and connection failures", () => {
  const result = runShell(`
    status=401
    body='${harnessAuthPrompt}'
    curl() {
      if [[ " $* " == *' --write-out '* ]]; then printf '%s' "$status";
      else printf '%s' "$body"; fi
    }
    for service in pkg-api bff seagull; do
      if service_responding "$service" "$HARNESS_URL/"; then exit 9; fi
    done
    body=unauthorized
    if service_responding harness "$HARNESS_URL/"; then exit 10; fi
    for status in 000 403 404 500 503; do
      if service_responding harness "$HARNESS_URL/"; then exit 11; fi
    done
    curl() { printf '200'; return 7; }
    if service_responding harness "$HARNESS_URL/"; then exit 12; fi
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("startup errors exclude old attempts and redact launch tokens", () => {
  const result = runShell(`
    mkdir -p "$LOG_ROOT" "$RUN_ROOT"
    printf 'old missing module error\\n' >"$(log_file harness)"
    if start_service harness "$2" "$HARNESS_URL/" bash -c 'printf "new failure ?token=test-secret&next=home\\n"; exit 1'; then
      exit 9
    fi
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /new failure \?token=\[REDACTED\]&next=home/);
  assert.doesNotMatch(result.stderr, /old missing module error|test-secret/);
});
