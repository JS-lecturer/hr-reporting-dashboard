/* charts.js — hand-rolled SVG charts. No external chart library dependency,
   so there is nothing to fail/fallback for. */

const Charts = {
  colors: ["#2b6cb0", "#2f855a", "#b7791f", "#9b2c2c", "#553c9a", "#0987a0", "#718096", "#c05621"],

  svgEl(w, h) {
    return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" width="100%" height="${h}">`;
  },

  bar(data, opts) {
    opts = opts || {};
    const w = opts.width || 640, h = opts.height || 260;
    const padL = 140, padB = 30, padT = 10, padR = 20;
    const chartW = w - padL - padR, chartH = h - padB - padT;
    const max = Math.max(...data.map(d => d.value), 1);
    const barH = chartH / data.length;
    let svg = this.svgEl(w, h);
    data.forEach((d, i) => {
      const bw = (d.value / max) * chartW;
      const y = padT + i * barH + barH * 0.15;
      const bh = barH * 0.7;
      svg += `<rect x="${padL}" y="${y}" width="${Math.max(bw,1)}" height="${bh}" fill="${this.colors[i % this.colors.length]}" rx="2"></rect>`;
      svg += `<text x="${padL - 8}" y="${y + bh / 2 + 4}" font-size="12" text-anchor="end" fill="var(--text-secondary,#4a5568)">${escapeHtml(String(d.label))}</text>`;
      svg += `<text x="${padL + bw + 6}" y="${y + bh / 2 + 4}" font-size="12" fill="var(--text-primary,#1a202c)">${typeof d.value === "number" ? formatNum(d.value) : d.value}</text>`;
    });
    svg += `</svg>`;
    return svg;
  },

  pie(data, opts) {
    opts = opts || {};
    const size = opts.size || 220;
    const r = size / 2 - 10, cx = size / 2, cy = size / 2;
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    let angle = -Math.PI / 2;
    let svg = this.svgEl(size + 160, size);
    data.forEach((d, i) => {
      const slice = (d.value / total) * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      angle += slice;
      const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
      const large = slice > Math.PI ? 1 : 0;
      svg += `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${this.colors[i % this.colors.length]}" stroke="var(--bg-card,#fff)" stroke-width="1"></path>`;
    });
    data.forEach((d, i) => {
      const y = 20 + i * 20;
      svg += `<rect x="${size + 15}" y="${y - 11}" width="12" height="12" fill="${this.colors[i % this.colors.length]}"></rect>`;
      svg += `<text x="${size + 32}" y="${y}" font-size="12" fill="var(--text-primary,#1a202c)">${escapeHtml(String(d.label))} (${d.value})</text>`;
    });
    svg += `</svg>`;
    return svg;
  },

  line(points, opts) {
    opts = opts || {};
    const w = opts.width || 640, h = opts.height || 220;
    const padL = 50, padB = 30, padT = 15, padR = 20;
    const chartW = w - padL - padR, chartH = h - padB - padT;
    if (!points.length) return `<div class="empty-note">No time-series data available.</div>`;
    const max = Math.max(...points.map(p => p.value), 1);
    const min = Math.min(...points.map(p => p.value), 0);
    const range = (max - min) || 1;
    const stepX = chartW / Math.max(points.length - 1, 1);
    let svg = this.svgEl(w, h);
    let d = "";
    points.forEach((p, i) => {
      const x = padL + i * stepX;
      const y = padT + chartH - ((p.value - min) / range) * chartH;
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    });
    svg += `<path d="${d}" fill="none" stroke="${this.colors[0]}" stroke-width="2"></path>`;
    points.forEach((p, i) => {
      const x = padL + i * stepX;
      const y = padT + chartH - ((p.value - min) / range) * chartH;
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${this.colors[0]}"></circle>`;
      if (i % Math.ceil(points.length / 8 || 1) === 0) {
        svg += `<text x="${x.toFixed(1)}" y="${h - 6}" font-size="10" text-anchor="middle" fill="var(--text-secondary,#4a5568)">${escapeHtml(String(p.label))}</text>`;
      }
    });
    svg += `</svg>`;
    return svg;
  },

  histogram(values, opts) {
    opts = opts || {};
    const bins = opts.bins || 10;
    const w = opts.width || 640, h = opts.height || 220;
    const min = Math.min(...values), max = Math.max(...values);
    const range = (max - min) || 1;
    const counts = new Array(bins).fill(0);
    values.forEach(v => {
      let idx = Math.floor(((v - min) / range) * bins);
      if (idx >= bins) idx = bins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    });
    const data = counts.map((c, i) => ({ label: (min + (i * range / bins)).toFixed(2), value: c }));
    const padL = 50, padB = 30, padT = 10, padR = 10;
    const chartW = w - padL - padR, chartH = h - padB - padT;
    const barW = chartW / bins;
    const maxC = Math.max(...counts, 1);
    let svg = this.svgEl(w, h);
    data.forEach((d, i) => {
      const bh = (d.value / maxC) * chartH;
      const x = padL + i * barW;
      const y = padT + chartH - bh;
      svg += `<rect x="${x + 1}" y="${y}" width="${Math.max(barW - 2, 1)}" height="${bh}" fill="${this.colors[1]}"></rect>`;
      if (i % 2 === 0) svg += `<text x="${x + barW/2}" y="${h - 6}" font-size="9" text-anchor="middle" fill="var(--text-secondary,#4a5568)">${d.label}</text>`;
    });
    svg += `</svg>`;
    return svg;
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatNum(n) {
  if (typeof n !== "number") return n;
  return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : (Number.isInteger(n) ? n : n.toFixed(2));
}
