/* redactcam demo — draw the license-plate gate as a decision space.
 *
 * Same shape as quiet-corners.js and for the same reason: the site CSP sets
 * script-src without 'unsafe-inline', so an inline <script> is blocked in
 * production. Data is same-origin JSON (connect-src 'self'); no libraries. The
 * figure holds no SVG <text> — axe cannot resolve a background color behind
 * SVG text, so every label lives in the HTML around and over the chart.
 */
(function () {
    'use strict';

    var SRC = '/data/redactcam/plate-gate.json';
    var NS = 'http://www.w3.org/2000/svg';
    // 720x360 viewBox. x is aspect ratio on a log2 scale (1:1 to 16:1), y is
    // box area as a percentage of the frame on a log10 scale (0.01% to 10%) —
    // both chosen so the HTML tick labels fall at even intervals.
    var W = 720, H = 360, A_LO = 1, A_HI = 16, R_LO = 0.01, R_HI = 10;

    function el(name, attrs) {
        var n = document.createElementNS(NS, name);
        for (var k in attrs) { n.setAttribute(k, attrs[k]); }
        return n;
    }
    function byId(id) { return document.getElementById(id); }
    function x(a) { return W * (Math.log(a / A_LO) / Math.log(A_HI / A_LO)); }
    function y(r) { return H - H * (Math.log(r / R_LO) / Math.log(R_HI / R_LO)); }
    function band(lo, hi, fn, floor, ceil) {
        var a = fn(lo === null ? floor : lo), b = fn(hi === null ? ceil : hi);
        return [Math.min(a, b), Math.abs(b - a)];
    }

    function draw(data) {
        var svg = byId('rc-chart'), tags = byId('rc-labels'), g = data.gate;
        while (svg.lastChild && svg.lastChild.nodeName !== 'title') { svg.removeChild(svg.lastChild); }
        tags.textContent = '';
        // The accepted region: inside the aspect window AND under the area ceiling.
        svg.appendChild(el('rect', {
            class: 'rc-gate', x: x(g.min_aspect), y: y(g.max_area_pct),
            width: x(g.max_aspect) - x(g.min_aspect), height: H - y(g.max_area_pct)
        }));

        data.classes.forEach(function (c, i) {
            // A class with only one measured axis is drawn spanning the other.
            var xs = band(c.aspect[0], c.aspect[1], x, A_LO, A_HI);
            var ys = band(c.area[1], c.area[0], y, R_HI, R_LO);
            var w = Math.max(xs[1], 4), h = Math.max(ys[1], 4);
            svg.appendChild(el('rect', {
                class: 'rc-box ' + (c.kept ? 'rc-kept' : 'rc-dropped'),
                x: xs[0], y: ys[0], width: w, height: h
            }));
            // The box number is HTML over the chart, keyed to the table below.
            var tag = tags.appendChild(document.createElement('span'));
            tag.className = 'rc-tag';
            tag.textContent = String(i + 1);
            tag.style.left = (100 * (xs[0] + w / 2) / W) + '%';
            tag.style.top = (100 * (ys[0] + h / 2) / H) + '%';
        });
    }

    function table(data) {
        var body = byId('rc-rows'), notes = byId('rc-notes');
        body.textContent = '';
        notes.textContent = '';
        var span = function (v, unit) {
            if (v[0] === null && v[1] === null) { return 'not recorded'; }
            if (v[0] === null) { return 'up to ' + v[1] + unit; }
            if (v[0] === v[1]) { return 'about ' + v[0] + unit; }
            return v[0] + '–' + v[1] + unit;
        };
        data.classes.forEach(function (c, i) {
            var row = body.appendChild(document.createElement('tr'));
            [(i + 1) + '. ' + c.label, span(c.aspect, ':1'), span(c.area, '%'),
                c.kept ? 'blurred' : 'left alone'].forEach(function (v) {
                row.appendChild(document.createElement('td')).textContent = v;
            });
            notes.appendChild(document.createElement('li')).textContent = c.label + ' — ' + c.note;
        });
    }

    function build(data) {
        var g = data.gate, window_ = g.min_aspect + ':1 to ' + g.max_aspect +
            ':1, and no more than ' + g.max_area_pct + '% of the frame';
        byId('rc-chart-title').textContent = 'Where four kinds of road object fall against ' +
            "redactcam's license-plate gate, by box aspect ratio and box area. The gate keeps a box " +
            window_ + '. Every range is repeated as text in the table below this figure.';
        byId('rc-gate-label').textContent = window_;
        byId('rc-source').textContent = data._provenance.source;
        draw(data);
        table(data);
        byId('rc-demo').classList.add('rc-ready');
    }

    function load() {
        fetch(SRC)
            .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
            .then(build)
            .catch(function (err) {
                byId('rc-fallback').textContent = 'The figure could not load its data (' +
                    err.message + '). The numbers are in /data/redactcam/plate-gate.json.';
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', load);
    } else {
        load();
    }
}());
