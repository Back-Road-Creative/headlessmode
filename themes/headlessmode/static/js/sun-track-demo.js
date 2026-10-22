/* sun-track demo — plot one UTC day of apparent solar elevation.
 *
 * Same shape as quiet-corners.js and for the same reason: the site CSP sets
 * script-src without 'unsafe-inline', so an inline <script> is blocked in
 * production. Data is same-origin JSON (connect-src 'self'); no libraries.
 * The figure holds no SVG <text> — axe cannot resolve a background color
 * behind SVG text, so every label lives in the HTML around the chart.
 */

(function () {
    'use strict';

    var SRC = '/data/sun-track/elevation.json';
    var NS = 'http://www.w3.org/2000/svg';
    // Plot area inside the 720x240 viewBox, and the elevation range it spans.
    var L = 0, R = 720, T = 8, B = 232, DEG_HI = 90, DEG_LO = -60;
    var scenarios = [];

    function el(name, attrs) {
        var n = document.createElementNS(NS, name);
        for (var k in attrs) { n.setAttribute(k, attrs[k]); }
        return n;
    }
    function x(min) { return L + (R - L) * (min / 1440); }
    function y(deg) { return B - (B - T) * ((deg - DEG_LO) / (DEG_HI - DEG_LO)); }
    function byId(id) { return document.getElementById(id); }

    function drawChart(s, step) {
        var svg = byId('st-chart');
        // Keep the <title> node: it is the figure's accessible name, and the
        // markup's aria-labelledby already points at its id.
        while (svg.lastChild && svg.lastChild.nodeName !== 'title') { svg.removeChild(svg.lastChild); }
        byId('st-chart-title').textContent = 'Apparent solar elevation at ' + s.place + ' on ' +
            s.date + ', in degrees above the horizon, across one UTC day. The golden windows ' +
            'are listed as exact times in the table below this figure.';

        // Golden band, then the horizon and hour grid, then the curve on top.
        svg.appendChild(el('rect', { x: L, y: y(6), width: R - L, height: y(-4) - y(6), class: 'st-band' }));
        svg.appendChild(el('line', { x1: L, y1: y(0), x2: R, y2: y(0), class: 'st-horizon' }));
        for (var m = 360; m < 1440; m += 360) {
            svg.appendChild(el('line', { x1: x(m), y1: T, x2: x(m), y2: B, class: 'st-grid' }));
        }
        svg.appendChild(el('polyline', {
            class: 'st-curve',
            points: s.curve.map(function (deg, i) { return x(i * step) + ',' + y(deg); }).join(' ')
        }));
    }

    function select(id, step) {
        var s = scenarios.filter(function (v) { return v.id === id; })[0];
        if (!s) { return; }
        byId('st-caption').textContent = s.place + ' · ' + s.date + ' · ' + s.note;
        drawChart(s, step);
        var body = byId('st-bands');
        body.textContent = '';
        s.bands.forEach(function (b) {
            var row = body.appendChild(document.createElement('tr'));
            [b.start + '–' + b.end + ' UTC', b.minutes + ' min'].forEach(function (v) {
                row.appendChild(document.createElement('td')).textContent = v;
            });
        });
        byId('st-peak').textContent =
            'Highest the sun gets: ' + s.peak.elevation.toFixed(2) + '° at ' + s.peak.at + ' UTC.';
    }

    function build(data) {
        scenarios = data.scenarios;
        var step = data._provenance.step_minutes;
        byId('st-generator').textContent = data._provenance.generator;
        var picker = byId('st-picker');
        scenarios.forEach(function (s, i) {
            var wrap = picker.appendChild(document.createElement('span'));
            wrap.className = 'st-opt';
            var input = wrap.appendChild(document.createElement('input'));
            input.type = 'radio';
            input.name = 'st-scenario';
            input.id = 'st-opt-' + s.id;
            input.checked = i === 0;
            input.addEventListener('change', function () { select(s.id, step); });
            var label = wrap.appendChild(document.createElement('label'));
            label.setAttribute('for', input.id);
            label.textContent = s.place + ' · ' + s.date;
        });
        select(scenarios[0].id, step);
        byId('st-demo').classList.add('st-ready');
    }

    function load() {
        fetch(SRC)
            .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
            .then(build)
            .catch(function (err) {
                byId('st-fallback').textContent = 'The figure could not load its data (' +
                    err.message + '). The numbers are in /data/sun-track/elevation.json.';
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', load);
    } else {
        load();
    }
}());
