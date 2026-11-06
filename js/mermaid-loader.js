/*
 * mermaid-loader.js — lazy-loads Mermaid (~1MB) only on pages that actually
 * contain a Mermaid diagram. Trigger: `pre code.language-mermaid` (markdown
 * ```mermaid fences) or an explicit `.mermaid` element.
 *
 * Extracted from head.html (A6: CSP hardening). The dynamically injected
 * <script> targets cdn.jsdelivr.net, which is allowed by script-src.
 */
(function () {
    function hasMermaid() {
        return !!document.querySelector('pre code.language-mermaid, .mermaid');
    }
    function loadMermaid() {
        if (!hasMermaid()) return;
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js';
        s.onload = function () {
            if (window.mermaid && typeof window.mermaid.initialize === 'function') {
                window.mermaid.initialize({
                    startOnLoad: true,
                    theme: 'default',
                    securityLevel: 'loose'
                });
            }
        };
        document.head.appendChild(s);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadMermaid);
    } else {
        loadMermaid();
    }
})();
