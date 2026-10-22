#!/bin/bash
# Universal Hugo Build Script - headlessmode
# Contract Layer v1.0
# Usage:
#   ./scripts/build.sh dev                 # Start development server
#   ./scripts/build.sh build production    # Build for production
#   ./scripts/build.sh test production     # Build + run tests
#   ./scripts/build.sh clean               # Clean artifacts

set -e

# Source environment configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# Color output helpers
log_info() { echo "[INFO] $*"; }
log_success() { echo "[SUCCESS] $*"; }
log_error() { echo "[ERROR] $*" >&2; }

# Validate environment parameter
validate_environment() {
    local env=$1
    if [[ ! "$env" =~ ^(local|production)$ ]]; then
        log_error "Invalid environment: $env"
        log_error "Must be one of: local, production"
        exit 1
    fi
}

# Check prerequisites
check_prerequisites() {
    if ! command -v hugo &> /dev/null; then
        log_error "Hugo is not installed. Please install Hugo first."
        exit 1
    fi

    log_info "Hugo version: $(hugo version)"
}

# Build Tailwind CSS via @tailwindcss/cli.
# Must run before hugo so the static asset exists when Hugo copies it.
build_tailwind() {
    if [[ ! -f package.json ]]; then
        log_info "No package.json — skipping Tailwind build"
        return 0
    fi
    if ! command -v npm &> /dev/null; then
        log_error "npm not installed; cannot build Tailwind CSS"
        exit 1
    fi
    if [[ ! -d node_modules ]]; then
        log_info "Installing npm dependencies..."
        npm ci || npm install
    fi
    log_info "Compiling Tailwind CSS..."
    npm run build:css
}

# Build site for specific environment
build_site() {
    local env=$1
    validate_environment "$env"

    log_info "Building ${SITE_NAME} for environment: $env"

    # Build config path
    local config="site-config/_default/hugo.toml"
    if [[ -f "site-config/${env}.toml" ]]; then
        config="$config,site-config/${env}.toml"
        log_info "Using environment config: site-config/${env}.toml"
    fi

    # Compile Tailwind first (produces themes/headlessmode/static/css/tailwind.css)
    build_tailwind

    # Execute build
    bash scripts/build-site.sh --environment "$env" --config "$config" --cleanDestinationDir --noBuildLock

    log_success "Build complete: public/"
}

# Start development server
serve_site() {
    local port="${PORT:-1315}"

    # Get WSL2 IP for Windows access (localhost often doesn't work)
    local wsl_ip=$(hostname -I | awk '{print $1}')

    log_info "Starting Hugo development server for ${SITE_NAME}"
    log_info ""
    log_info "Access from Windows browser:"
    log_info "  → http://${wsl_ip}:${port}/"
    log_info ""
    log_info "(localhost:${port} may not work in WSL2)"
    log_info "Press Ctrl+C to stop"

    # Compile Tailwind first (produces themes/headlessmode/static/css/tailwind.css).
    # For live editing of utility classes, run `npm run watch:css` in a second terminal.
    build_tailwind

    hugo server \
        --environment local \
        --configDir site-config \
        --bind 0.0.0.0 \
        --port "$port" \
        --buildDrafts \
        --buildFuture \
        --cleanDestinationDir \
        --navigateToChanged
}

# Run tests on built site
test_site() {
    local env=$1
    validate_environment "$env"

    log_info "Testing ${SITE_NAME} build for environment: $env"

    # Build first
    build_site "$env"

    # HTML validation (if html5validator is installed)
    if command -v html5validator &> /dev/null; then
        log_info "Running HTML validation..."
        html5validator --root public/ --also-check-css || {
            log_error "HTML validation failed"
            exit 1
        }
        log_success "HTML validation passed"
    else
        log_info "Skipping HTML validation (html5validator not installed)"
    fi

    # Accessibility testing (if pa11y-ci is available)
    if [[ -f package.json ]] && grep -q "pa11y-ci" package.json; then
        log_info "Running accessibility tests..."
        npm run test:a11y || {
            log_error "Accessibility tests failed"
            exit 1
        }
        log_success "Accessibility tests passed"
    else
        log_info "Skipping accessibility tests (pa11y-ci not configured)"
    fi

    log_success "All tests passed for ${SITE_NAME}"
}

# Clean build artifacts
clean_site() {
    log_info "Cleaning build artifacts for ${SITE_NAME}"

    if [[ -d "public" ]]; then
        rm -rf public/
        log_success "Removed public/"
    fi

    if [[ -d "resources" ]]; then
        rm -rf resources/
        log_success "Removed resources/"
    fi

    log_success "Clean complete"
}

# Main command dispatcher
main() {
    check_prerequisites

    local command=$1

    case "$command" in
        dev|serve)
            serve_site
            ;;
        build)
            local env=${2:-local}
            build_site "$env"
            ;;
        test)
            local env=${2:-production}
            test_site "$env"
            ;;
        clean)
            clean_site
            ;;
        *)
            log_error "Unknown command: $command"
            echo ""
            echo "Usage:"
            echo "  $0 dev                 # Start development server"
            echo "  $0 build production    # Build for production"
            echo "  $0 test production     # Build + run tests"
            echo "  $0 clean               # Clean artifacts"
            exit 1
            ;;
    esac
}

main "$@"
