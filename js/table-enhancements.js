/*
 * table-enhancements.js — post-render enhancements for markdown tables:
 *   - Right-align numeric "Weight" columns
 *   - Color-code Grade cells in A–F scoring tables
 * Triggered by table headers matching 'weight' or 'grade' (case-insensitive).
 *
 * Extracted from head.html (A6: CSP hardening).
 */
(function () {
    function applyTableEnhancements() {
        document.querySelectorAll('.section-content table, .content-body table').forEach(function (tbl) {
            var headers = Array.from(tbl.querySelectorAll('thead th'));
            if (!headers.length) return;
            var weightIdx = -1;
            var gradeIdx = -1;
            headers.forEach(function (th, i) {
                var txt = (th.textContent || '').trim().toLowerCase();
                if (txt === 'weight') weightIdx = i;
                if (txt === 'grade') gradeIdx = i;
            });
            if (weightIdx === -1 && gradeIdx === -1) return;
            if (gradeIdx !== -1) tbl.classList.add('grade-table');
            Array.from(tbl.querySelectorAll('tbody tr')).forEach(function (tr) {
                var cells = tr.children;
                if (weightIdx !== -1 && cells[weightIdx]) {
                    cells[weightIdx].classList.add('weight');
                }
                if (gradeIdx !== -1 && cells[gradeIdx]) {
                    var g = (cells[gradeIdx].textContent || '').trim().charAt(0).toUpperCase();
                    if ('ABCDF'.indexOf(g) !== -1) {
                        cells[gradeIdx].setAttribute('data-grade', g);
                    }
                }
            });
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyTableEnhancements);
    } else {
        applyTableEnhancements();
    }
})();
