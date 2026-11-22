/**
 * Spoiler-free share text, 2-second animated SVG route replay,
 * and downloadable 1200x630 PNG Share Card via HTML Canvas.
 */
import { getEffectiveTheme } from './theme.js';

export function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function buildShareText({ titleLabel, start, target, clicks, hints, score, par, elapsedMs, url }) {
  const blocks = '■'.repeat(Math.min(clicks, 12)) + '□'.repeat(hints);
  const parDiff = par ? score - par : null;
  const parTxt =
    parDiff === null
      ? ''
      : parDiff < 0
      ? ` (Par ${parDiff})`
      : parDiff === 0
      ? ' (Par)'
      : ` (Par +${parDiff})`;

  return [
    `Tangent · ${titleLabel}`,
    `${start} → ${target}`,
    `${score} click${score === 1 ? '' : 's'}${parTxt} · ${formatTime(elapsedMs)}`,
    blocks,
    url || window.location.origin
  ].join('\n');
}

/**
 * Builds an animated editorial route SVG showing every article hop cleanly
 * (strictly deduplicated so the target never appears twice!).
 */
export function buildRouteSVG(stations) {
  const clean = stations.filter(Boolean);
  const n = clean.length;
  const gap = 152;
  const padX = 82;
  const w = Math.max(320, padX * 2 + Math.max(0, n - 1) * gap);
  const h = 136;

  const points = clean.map((_, i) => ({
    x: padX + i * gap,
    y: i % 2 === 0 ? 44 : 88
  }));

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const midX = (prev.x + curr.x) / 2;
    d += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
  }

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const nodeMarkup = clean
    .map((label, i) => {
      const p = points[i];
      const isStart = i === 0;
      const isEnd = i === n - 1;
      const short = label.length > 17 ? `${label.slice(0, 16)}…` : label;
      const labelY = p.y < 64 ? p.y - 20 : p.y + 28;
      const delay = (0.18 + i * 0.24).toFixed(2);
      const cls = isEnd ? 'rt-dot end' : isStart ? 'rt-dot start' : 'rt-dot';
      return `
        <g class="rt-node" style="animation-delay:${delay}s">
          <circle cx="${p.x}" cy="${p.y}" r="${isEnd || isStart ? 9 : 7}" class="${cls}"/>
          <text x="${p.x}" y="${labelY}" text-anchor="middle" class="rt-label">${esc(short)}</text>
        </g>
      `;
    })
    .join('');

  return `
    <svg class="route-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Route from ${esc(clean[0])} to ${esc(clean[n - 1])}">
      <path class="rt-rail" d="${d}"/>
      <path class="rt-line" pathLength="1" d="${d}"/>
      ${nodeMarkup}
    </svg>
  `;
}

/**
 * Generates and downloads a crisp 1200x630 PNG Share Card using the active theme.
 */
export function downloadShareCardPNG({ titleLabel, start, target, score, clicks, hints, par, elapsedMs, path }) {
  const theme = getEffectiveTheme();
  const palettes = {
    light: { bg: '#FAF9F6', card: '#FFFFFF', ink: '#111214', muted: '#5D626B', border: '#E4E2DC', accent: '#5372F8', pop: '#F7C948' },
    dark: { bg: '#121213', card: '#1B1C1E', ink: '#F4F4F5', muted: '#9B9FA6', border: '#2A2C30', accent: '#5372F8', pop: '#F7C948' },
    oled: { bg: '#000000', card: '#0A0B0D', ink: '#FFFFFF', muted: '#9A9EA6', border: '#22242A', accent: '#5372F8', pop: '#F7C948' }
  };
  const P = palettes[theme] || palettes.light;

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, 1200, 630);

  // Inner Card
  const pad = 48;
  roundRect(ctx, pad, pad, 1200 - pad * 2, 630 - pad * 2, 24);
  ctx.fillStyle = P.card;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = P.border;
  ctx.stroke();

  // Top Accent Stripe
  ctx.save();
  roundRect(ctx, pad, pad, 1200 - pad * 2, 16, 8);
  ctx.fillStyle = P.accent;
  ctx.fill();
  ctx.restore();

  // Wordmark & Challenge Label
  ctx.fillStyle = P.ink;
  ctx.font = '700 40px Georgia, serif';
  ctx.fillText('Tangent.', 92, 128);

  ctx.fillStyle = P.muted;
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(titleLabel.toUpperCase(), 1108, 124);
  ctx.textAlign = 'left';

  // Route headline
  ctx.fillStyle = P.ink;
  ctx.font = '700 48px Georgia, serif';
  const pairText = `${truncate(start, 20)}  →  ${truncate(target, 20)}`;
  ctx.fillText(pairText, 92, 218);

  // Score KPI pills
  const stats = [
    { label: 'SCORE', value: `${score} clicks`, fill: P.pop, ink: '#111214' },
    { label: 'TIME', value: formatTime(elapsedMs), fill: P.bg, ink: P.ink },
    { label: 'HINTS', value: String(hints), fill: P.bg, ink: P.ink }
  ];
  if (par) {
    const diff = score - par;
    stats.push({
      label: 'VS PAR',
      value: diff === 0 ? 'EVEN PAR' : diff < 0 ? `${diff} UNDER` : `+${diff}`,
      fill: '#65C99A',
      ink: '#0F1B14'
    });
  }

  let sx = 92;
  for (const st of stats) {
    roundRect(ctx, sx, 260, 224, 96, 16);
    ctx.fillStyle = st.fill;
    ctx.fill();
    ctx.strokeStyle = P.border;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = st.fill === P.bg ? P.muted : 'rgba(17,18,20,0.68)';
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillText(st.label, sx + 20, 290);

    ctx.fillStyle = st.ink;
    ctx.font = '800 30px monospace';
    ctx.fillText(st.value, sx + 20, 332);
    sx += 242;
  }

  // Spoiler-free hop dots bar
  ctx.fillStyle = P.muted;
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillText(`PATH LENGTH (${path.length} ARTICLES · SPOILER-FREE)`, 92, 418);

  const dotsCount = Math.min(path.length, 10);
  const startX = 112;
  const endX = 1088;
  const dotY = 472;
  const stepX = dotsCount > 1 ? (endX - startX) / (dotsCount - 1) : 0;

  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(startX, dotY);
  ctx.lineTo(startX + stepX * (dotsCount - 1), dotY);
  ctx.stroke();

  for (let i = 0; i < dotsCount; i++) {
    const x = startX + i * stepX;
    ctx.beginPath();
    ctx.arc(x, dotY, i === 0 || i === dotsCount - 1 ? 14 : 10, 0, Math.PI * 2);
    ctx.fillStyle = i === dotsCount - 1 ? P.pop : i === 0 ? P.accent : P.card;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = P.ink;
    ctx.stroke();
  }

  // Footer
  ctx.fillStyle = P.muted;
  ctx.font = '500 20px system-ui, sans-serif';
  ctx.fillText('playtangent.vercel.app', 92, 548);

  const link = document.createElement('a');
  link.download = `tangent-${start.toLowerCase().replace(/\W+/g, '-')}-to-${target.toLowerCase().replace(/\W+/g, '-')}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
