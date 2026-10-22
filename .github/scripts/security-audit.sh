#!/usr/bin/env bash
# =============================================================================
# security-audit.sh — Production Security Audit for Static Sites
# Zero dependencies beyond bash, curl, openssl, grep, python3 (for JSON)
#
# Usage:
#   ./security-audit.sh <url> [url2] [url3]
#   ./security-audit.sh --json <url>
#   ./security-audit.sh --help
#
# Exit codes:
#   0 = all checks passed
#   1 = critical issue(s) found (blocks deploy)
#   2 = warnings only (deploy proceeds with notice)
#
# Environment (test mode):
#   MOCK_HEADERS  — file with mock curl -I response
#   MOCK_HTML     — file with mock HTML source
#   MOCK_SSL      — file with mock openssl cert output
#   MOCK_PATH_STATUS    — fixed HTTP status for all path probes
#   MOCK_PATH_RESPONSES — file with "path:status" lines
# =============================================================================
set -uo pipefail

VERSION="1.0.0"
TEST_MODE=false
JSON_MODE=false
URLS=()

# A single quote cannot be written inside a single-quoted bash string, and the
# workaround used below was `["\x27]`. That is NOT an escape for a quote: GNU
# grep treats a bracket expression literally, so the set was { " \ x 2 7 } — it
# matched a backslash or an 'x' and never matched a single quote. Every
# credential written with single quotes, which is most JavaScript, was invisible
# to the secret scan. (A local `grep` wrapping ugrep does honour \x27 and hides
# this; GNU grep 3.11, which the runners use, does not.)
#
# Build the class from a variable instead, so the quote is a real quote.
SQ="'"
QUOTED="[\"${SQ}]"        # one quote character, either kind
UNQUOTED="[^\"${SQ}]"     # any character that is not a quote

# ---- Severity tracking ----
CRITICALS=0
WARNINGS=0
FINDINGS=()   # Array of "severity|category|message" strings

# ---- Configuration ----
# Critical headers — missing any = deploy blocker
CRITICAL_HEADERS=(
    "content-security-policy"
    "x-frame-options"
    "x-content-type-options"
    "strict-transport-security"
)

# Advisory headers — missing = warning, not blocker
WARN_HEADERS=(
    "referrer-policy"
    "permissions-policy"
)

# Paths to probe — any 200 = critical (except noted)
EXPOSED_PATHS=(
    ".env"
    ".env.local"
    ".env.production"
    ".git/config"
    ".git/HEAD"
    ".gitignore"
    "wp-admin"
    "wp-login.php"
    "xmlrpc.php"
    "admin"
    "login"
    "backup.zip"
    "backup.tar.gz"
    "db.sql"
    "dump.sql"
    "config.json"
    "config.yml"
    "config.toml"
    "package.json"
    ".htaccess"
    ".htpasswd"
    ".DS_Store"
    "debug.log"
    "error_log"
    "server-status"
    "phpinfo.php"
    "wp-config.php"
    "composer.json"
    "Gemfile"
    "Makefile"
)

# Patterns that indicate real secrets (not analytics IDs)
SECRET_PATTERNS=(
    'sk-[a-zA-Z0-9]{20,}'           # OpenAI / Stripe secret keys
    'sk-proj-[a-zA-Z0-9]+'           # OpenAI project keys
    'ghp_[a-zA-Z0-9]{36}'            # GitHub personal access tokens
    'gho_[a-zA-Z0-9]{36}'            # GitHub OAuth tokens
    'github_pat_[a-zA-Z0-9_]+'       # GitHub fine-grained PATs
    'glpat-[a-zA-Z0-9_-]+'           # GitLab PATs
    'xoxb-[0-9]+-[a-zA-Z0-9]+'       # Slack bot tokens
    'xoxp-[0-9]+-[a-zA-Z0-9]+'       # Slack user tokens
    'whsec_[a-zA-Z0-9]+'             # Webhook secrets
    'AKIA[0-9A-Z]{16}'               # AWS access keys
    'eyJ[a-zA-Z0-9_-]{20,}\.eyJ'     # JWT tokens
    'AIza[0-9A-Za-z_-]{35}'          # Google API keys
)

# Allowlisted patterns (analytics, ads — expected in public HTML)
ALLOWLIST_PATTERNS=(
    'ca-pub-[0-9]+'                  # AdSense publisher ID
    'G-[A-Z0-9]+'                    # GA4 measurement ID
    'UA-[0-9]+-[0-9]+'              # Universal Analytics
    'GTM-[A-Z0-9]+'                  # Google Tag Manager
    'AW-[0-9]+'                      # Google Ads conversion
    'pub-[0-9]+'                     # Generic pub IDs
)

# Internal IP patterns
INTERNAL_IP_PATTERNS=(
    '192\.168\.[0-9]+\.[0-9]+'
    '10\.[0-9]+\.[0-9]+\.[0-9]+'
    '172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+'
)

# ---- Logging ----
log_info()  { echo "[INFO]  $*"; }
log_pass()  { echo "[PASS]  $*"; }
log_warn()  { ((WARNINGS++)); FINDINGS+=("WARN|$1|$2"); echo "[WARN]  $1: $2"; }
log_crit()  { ((CRITICALS++)); FINDINGS+=("CRITICAL|$1|$2"); echo "[CRITICAL] $1: $2"; }

# ---- Data fetchers (mockable for testing) ----
fetch_headers() {
    local url="$1"
    if [[ -n "${MOCK_HEADERS:-}" && -f "${MOCK_HEADERS}" ]]; then
        cat "$MOCK_HEADERS"
    else
        curl -sI --max-time 10 "$url" 2>/dev/null
    fi
}

fetch_html() {
    local url="$1"
    if [[ -n "${MOCK_HTML:-}" && -f "${MOCK_HTML}" ]]; then
        cat "$MOCK_HTML"
    else
        curl -s --max-time 15 "$url" 2>/dev/null
    fi
}

fetch_path_status() {
    local url="$1" path="$2"
    if [[ -n "${MOCK_PATH_STATUS:-}" ]]; then
        echo "$MOCK_PATH_STATUS"
        return
    fi
    if [[ -n "${MOCK_PATH_RESPONSES:-}" && -f "${MOCK_PATH_RESPONSES}" ]]; then
        local status
        status=$(grep "^${path}:" "$MOCK_PATH_RESPONSES" 2>/dev/null | cut -d: -f2 | tr -d ' ')
        echo "${status:-404}"
        return
    fi
    curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${url}/${path}" 2>/dev/null
}

fetch_ssl() {
    local host="$1"
    if [[ -n "${MOCK_SSL:-}" && -f "${MOCK_SSL}" ]]; then
        cat "$MOCK_SSL"
    else
        echo | openssl s_client -connect "${host}:443" -servername "$host" 2>/dev/null \
            | openssl x509 -noout -dates -issuer -subject 2>/dev/null
    fi
}

# ---- Check functions ----

check_headers() {
    local url="$1"
    local headers
    headers=$(fetch_headers "$url" | tr '[:upper:]' '[:lower:]')

    # Critical headers
    for hdr in "${CRITICAL_HEADERS[@]}"; do
        if echo "$headers" | grep -q "^${hdr}:"; then
            log_pass "security-headers: ${hdr} present"
        else
            log_crit "security-headers" "Missing critical header: ${hdr}"
        fi
    done

    # Advisory headers
    for hdr in "${WARN_HEADERS[@]}"; do
        if echo "$headers" | grep -q "^${hdr}:"; then
            log_pass "security-headers: ${hdr} present"
        else
            log_warn "security-headers" "Missing advisory header: ${hdr}"
        fi
    done
}

check_server_fingerprint() {
    local url="$1"
    local headers
    headers=$(fetch_headers "$url" | tr '[:upper:]' '[:lower:]')

    # Check X-Powered-By
    if echo "$headers" | grep -q "^x-powered-by:"; then
        local value
        value=$(echo "$headers" | grep "^x-powered-by:" | head -1 | cut -d: -f2- | xargs)
        log_warn "fingerprint" "X-Powered-By header exposes: ${value}"
    fi

    # Check Server header for version numbers
    local server_header
    server_header=$(echo "$headers" | grep "^server:" | head -1 | cut -d: -f2- | xargs)
    if [[ -n "$server_header" ]] && echo "$server_header" | grep -qE '[0-9]+\.[0-9]+'; then
        log_warn "fingerprint" "Server header exposes version: ${server_header}"
    fi
}

check_exposed_paths() {
    local url="$1"

    for path in "${EXPOSED_PATHS[@]}"; do
        local status
        status=$(fetch_path_status "$url" "$path")
        if [[ "$status" == "200" ]]; then
            log_crit "exposed-paths" "/${path} is publicly accessible (HTTP 200)"
        fi
    done
    log_pass "exposed-paths: probed ${#EXPOSED_PATHS[@]} sensitive paths"
}

check_pii() {
    local url="$1"
    local html
    html=$(fetch_html "$url")

    # Email addresses (excluding common false positives and the site's own
    # deliberately-published contact address — see content/contact.md)
    local emails
    emails=$(echo "$html" | grep -oiE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' \
        | grep -viE '(example\.com|placeholder|noreply|no-reply|schema\.org|w3\.org|sitemaps\.org|^hello@headlessmode\.com$)' \
        || true)
    if [[ -n "$emails" ]]; then
        local email_list
        email_list=$(echo "$emails" | sort -u | head -5 | tr '\n' ', ' | sed 's/,$//')
        log_crit "pii" "email address(es) found in source: ${email_list}"
    fi

    # Phone numbers (US format)
    # First strip known non-phone numeric patterns (analytics IDs, ad IDs, timestamps, CSS values)
    local stripped_html
    stripped_html=$(echo "$html" \
        | sed -E 's/ca-pub-[0-9]+//g' \
        | sed -E 's/G-[A-Z0-9]+//g' \
        | sed -E 's/UA-[0-9]+-[0-9]+//g' \
        | sed -E 's/[0-9]{13,}//g' \
        | sed -E 's/#[0-9a-fA-F]{6,8}//g' \
        | sed -E 's/[0-9]+px//g' \
        | sed -E 's/[0-9]+\.[0-9]+\.[0-9]+//g' \
    )
    local phones
    phones=$(echo "$stripped_html" | grep -oE '(\([0-9]{3}\)\s*[0-9]{3}[-.]?[0-9]{4}|[0-9]{3}[-.]?[0-9]{3}[-.]?[0-9]{4})' \
        | grep -vE '^0123456789' \
        || true)
    if [[ -n "$phones" ]]; then
        local phone_list
        phone_list=$(echo "$phones" | sort -u | head -3 | tr '\n' ', ' | sed 's/,$//')
        log_warn "pii" "phone number(s) found in source: ${phone_list}"
    fi
}

check_js_secrets() {
    local url="$1"
    local html
    html=$(fetch_html "$url")

    # Strip allowlisted patterns first
    local filtered="$html"
    for pattern in "${ALLOWLIST_PATTERNS[@]}"; do
        filtered=$(echo "$filtered" | sed -E "s/${pattern}/__ALLOWED__/g")
    done

    # Check for secret patterns
    for pattern in "${SECRET_PATTERNS[@]}"; do
        local matches
        matches=$(echo "$filtered" | grep -oE "$pattern" || true)
        if [[ -n "$matches" ]]; then
            local first_match
            first_match=$(echo "$matches" | head -1)
            # Redact the middle of the secret
            local redacted="${first_match:0:8}...${first_match: -4}"
            log_crit "js-secrets" "Potential secret found matching pattern: ${redacted}"
        fi
    done

    # Generic dangerous assignments (only in <script> blocks)
    local script_content
    script_content=$(echo "$html" | sed -n '/<script/,/<\/script>/p')

    # Check for password/secret/apiSecret assignments
    if echo "$script_content" | grep -qiE "(password|apiSecret|api_secret|secretKey|secret_key)\s*[:=]\s*${QUOTED}${UNQUOTED}{8,}"; then
        local match
        match=$(echo "$script_content" | grep -oiE "(password|apiSecret|api_secret|secretKey|secret_key)\s*[:=]\s*${QUOTED}${UNQUOTED}{1,20}" | head -1)
        log_crit "js-secrets" "Hardcoded credential assignment: ${match}..."
    fi
}

check_generator_tag() {
    local url="$1"
    local html
    html=$(fetch_html "$url")

    local generator
    generator=$(echo "$html" | grep -oi "<meta[^>]*name=${QUOTED}*generator${QUOTED}*[^>]*content=${QUOTED}*${UNQUOTED}*${QUOTED}*" | head -1 || true)
    if [[ -n "$generator" ]]; then
        log_warn "generator" "Generator meta tag exposes build tool: ${generator}"
    fi
}

check_ssl() {
    local url="$1"
    local host
    host=$(echo "$url" | sed -E 's|https?://||' | cut -d/ -f1)

    local ssl_info
    ssl_info=$(fetch_ssl "$host")

    if [[ -z "$ssl_info" ]]; then
        log_crit "ssl" "Could not retrieve SSL certificate"
        return
    fi

    local not_after
    not_after=$(echo "$ssl_info" | grep "notAfter=" | cut -d= -f2-)
    if [[ -z "$not_after" ]]; then
        log_crit "ssl" "Could not parse SSL certificate expiry"
        return
    fi

    log_pass "ssl: certificate present, expires ${not_after}"

    # Check if expiring within 30 days
    local expiry_epoch now_epoch days_left
    expiry_epoch=$(date -d "$not_after" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$not_after" +%s 2>/dev/null || echo "0")
    now_epoch=$(date +%s)

    if [[ "$expiry_epoch" -gt 0 ]]; then
        days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
        if [[ "$days_left" -lt 0 ]]; then
            log_crit "ssl" "Certificate EXPIRED ${days_left} days ago!"
        elif [[ "$days_left" -lt 30 ]]; then
            log_warn "ssl" "Certificate expires in ${days_left} days (< 30 day threshold)"
        else
            log_pass "ssl: ${days_left} days until expiry"
        fi
    fi
}

check_internal_ips() {
    local url="$1"
    local html
    html=$(fetch_html "$url")

    for pattern in "${INTERNAL_IP_PATTERNS[@]}"; do
        local matches
        matches=$(echo "$html" | grep -oE "$pattern" | sort -u || true)
        if [[ -n "$matches" ]]; then
            local ip_list
            ip_list=$(echo "$matches" | tr '\n' ', ' | sed 's/,$//')
            log_warn "internal-ip" "Internal IP address(es) found: ${ip_list}"
        fi
    done
}

# ---- Report generation ----
# Reduce per-URL exit codes to the worst one. Severity does NOT follow numeric
# order — 1 (critical) is worse than 2 (warnings), which is worse than 0 (clean)
# — so this cannot be a numeric comparison. The previous version compared
# numerically and started with `this_exit -lt worst_exit`, which DOWNGRADED:
# auditing a site with warnings (2) and then a clean site (0) satisfied 0 < 2 and
# reset the result to 0, so a multi-URL run reported success despite findings.
#
# A named function rather than inline code so the regression test can call the
# real reducer instead of asserting against a copy of it.
worst_exit_of() {
    local worst=0 this
    for this in "$@"; do
        if [[ "$this" -eq 1 ]]; then
            worst=1
        elif [[ "$this" -eq 2 && "$worst" -ne 1 ]]; then
            worst=2
        fi
    done
    echo "$worst"
}

generate_json_report() {
    local url="$1"
    local status="PASS"
    [[ "$WARNINGS" -gt 0 ]] && status="WARN"
    [[ "$CRITICALS" -gt 0 ]] && status="FAIL"

    # Findings are built from data the audited site controls — a Server banner,
    # a meta tag, a matched credential fragment. The previous version pasted
    # them straight into Python source and into a hand-built JSON string, so a
    # response header containing a quote produced malformed JSON, and one
    # containing ''' plus Python could execute inside this script. Nothing
    # remote is interpolated now: the findings go over stdin and the scalars go
    # through the environment, where they are data and can never be code.
    local total_checks=$(( ${#CRITICAL_HEADERS[@]} + ${#WARN_HEADERS[@]} + ${#EXPOSED_PATHS[@]} + 5 ))

    printf '%s\n' ${FINDINGS[@]+"${FINDINGS[@]}"} | \
    SA_URL="$url" \
    SA_VERSION="$VERSION" \
    SA_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    SA_STATUS="$status" \
    SA_CRITICALS="$CRITICALS" \
    SA_WARNINGS="$WARNINGS" \
    SA_TOTAL="$total_checks" \
    python3 -c '
import json, os, sys

findings = []
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    parts = line.split("|", 2)
    while len(parts) < 3:
        parts.append("")
    findings.append({
        "severity": parts[0],
        "category": parts[1],
        "message": parts[2],
    })

print(json.dumps({
    "url": os.environ["SA_URL"],
    "version": os.environ["SA_VERSION"],
    "timestamp": os.environ["SA_TIMESTAMP"],
    "summary": {
        "status": os.environ["SA_STATUS"],
        "criticals": int(os.environ["SA_CRITICALS"]),
        "warnings": int(os.environ["SA_WARNINGS"]),
        "total_checks": int(os.environ["SA_TOTAL"]),
    },
    "findings": findings,
}, indent=2))
'
}

# ---- Audit runner ----
run_audit() {
    local url="$1"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Security Audit: ${url}"
    echo "  Version: ${VERSION} | $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Reset counters for this URL
    CRITICALS=0
    WARNINGS=0
    FINDINGS=()

    echo "── Security Headers ──"
    check_headers "$url"
    check_server_fingerprint "$url"

    echo ""
    echo "── Exposed Paths ──"
    check_exposed_paths "$url"

    echo ""
    echo "── Content Analysis ──"
    check_pii "$url"
    check_js_secrets "$url"
    check_generator_tag "$url"
    check_internal_ips "$url"

    echo ""
    echo "── SSL/TLS ──"
    check_ssl "$url"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [[ "$CRITICALS" -gt 0 ]]; then
        echo "  RESULT: ❌ FAIL — ${CRITICALS} critical, ${WARNINGS} warnings"
    elif [[ "$WARNINGS" -gt 0 ]]; then
        echo "  RESULT: ⚠️  WARN — ${WARNINGS} warnings (no criticals)"
    else
        echo "  RESULT: ✅ PASS — all checks passed"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# ---- Main ----
usage() {
    cat <<EOF
Usage: security-audit.sh [OPTIONS] <url> [url2] [url3...]

Production security audit for static sites.
Checks headers, exposed paths, PII, secrets, SSL, and more.

Options:
  --help        Show this help
  --json        Output JSON report (single URL only)
  --test-mode   Enable mock data via environment variables
  --version     Show version

Exit codes:
  0  All checks passed
  1  Critical issue(s) found — blocks deploy
  2  Warnings only — deploy proceeds with notice

Environment (test mode):
  MOCK_HEADERS         Mock file for HTTP headers
  MOCK_HTML            Mock file for page HTML
  MOCK_SSL             Mock file for SSL cert info
  MOCK_PATH_STATUS     Fixed HTTP status for all path probes
  MOCK_PATH_RESPONSES  File with "path:status" lines

Examples:
  ./security-audit.sh https://example.com
  ./security-audit.sh --json https://example.com
  ./security-audit.sh https://site1.com https://site2.com https://site3.com

Version: ${VERSION}
EOF
}

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help)
                usage
                exit 0
                ;;
            --version)
                echo "security-audit ${VERSION}"
                exit 0
                ;;
            --json)
                JSON_MODE=true
                shift
                ;;
            --test-mode)
                TEST_MODE=true
                shift
                ;;
            -*)
                echo "Unknown option: $1" >&2
                usage >&2
                exit 1
                ;;
            *)
                URLS+=("$1")
                shift
                ;;
        esac
    done

    if [[ ${#URLS[@]} -eq 0 ]]; then
        echo "Error: No URL provided." >&2
        echo "" >&2
        usage >&2
        exit 1
    fi

    # Track worst exit code across all URLs
    local worst_exit=0

    for url in "${URLS[@]}"; do
        if $JSON_MODE; then
            # JSON mode: run audit (suppressed), then output JSON
            run_audit "$url" >/dev/null 2>&1 || true
            generate_json_report "$url"
        else
            run_audit "$url"
        fi

        # Determine exit code for this URL
        local this_exit=0
        if [[ "$CRITICALS" -gt 0 ]]; then
            this_exit=1
        elif [[ "$WARNINGS" -gt 0 ]]; then
            this_exit=2
        fi

        worst_exit=$(worst_exit_of "$worst_exit" "$this_exit")
    done

    exit "$worst_exit"
}

# Run only when executed, not when sourced, so the companion test file can call
# individual functions without kicking off a live audit of the whole site.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
