/**
 * Saying what happened, in the three places somebody will read it.
 *
 * A terminal for the person who ran it, markdown for the pull request, and an
 * SVG timeline for the case this tool exists for: proving to somebody else
 * that the step change has a date on it and the date is not the date of your
 * deploy.
 */

const SYMBOL = { drifted: 'x', stable: 'ok', inconclusive: '-' };

const pad = (s, n) => String(s).padEnd(n);

/* -------------------------------------------------------------- terminal */

export function toTerminal(assessments, summary, { colour = false } = {}) {
  const paint = (code, s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
  const c = {
    bold: (s) => paint('1', s), dim: (s) => paint('2', s),
    green: (s) => paint('32', s), red: (s) => paint('31', s), yellow: (s) => paint('33', s),
  };

  const lines = [''];
  const width = Math.max(8, ...assessments.map((a) => a.probeId.length));

  for (const a of assessments) {
    const colourise = a.status === 'drifted' ? c.red : a.status === 'stable' ? c.green : c.dim;
    const share = `${a.mode.count}/${a.samples}`;
    const p = a.p === null || a.p === undefined ? '' : `p ${a.p < 1e-4 ? a.p.toExponential(1) : a.p.toFixed(4)}`;
    const effect = a.effect === undefined ? '' : `moved ${(a.effect * 100).toFixed(0)}%`;

    lines.push(
      `  ${colourise(pad(SYMBOL[a.status] ?? '?', 3))}${pad(a.probeId, width + 2)}` +
      `${c.dim(pad(share, 8))}${c.dim(pad(effect, 12))}${c.dim(p)}`,
    );

    if (a.confidence === 'proof') {
      lines.push(`      ${c.bold('the provider itself reported a different model')}`);
    }

    if (a.status !== 'stable' && a.reason) lines.push(`      ${c.dim(a.reason)}`);

    if (a.status !== 'drifted' && a.chart?.out) {
      lines.push(`      ${c.yellow('~')} ${c.dim(`the modal answer's share is ${a.chart.z > 0 ? 'above' : 'below'} its own band, a slow slide rather than a jump`)}`);
    }

    if (a.errors) lines.push(`      ${c.yellow('~')} ${c.dim(`${a.errors} request(s) failed and were not counted as answers`)}`);
  }

  lines.push('');
  lines.push(summary.clean ? `  ${c.green(summary.headline)}` : `  ${c.red(summary.headline)}`);

  if (summary.blind) {
    lines.push(`  ${c.dim(`${summary.blind} probe(s) ran against a provider that reports no model identity, so those rest on statistics alone`)}`);
  }

  lines.push('');

  return lines.join('\n');
}

/* -------------------------------------------------------------- markdown */

export function toMarkdown(assessments, summary, { title = 'driftline' } = {}) {
  const lines = [`### ${title}`, ''];

  lines.push(summary.clean ? `**${summary.headline}.**` : `**${summary.headline}.**`);
  lines.push('');

  const drifted = assessments.filter((a) => a.status === 'drifted');

  if (drifted.length) {
    lines.push('| Probe | Modal answer | Moved | Adjusted p | How we know |');
    lines.push('| :--- | ---: | ---: | ---: | :--- |');

    for (const a of drifted) {
      lines.push(
        `| \`${a.probeId}\` | ${a.mode.count}/${a.samples} | ${(a.effect * 100).toFixed(0)}% | ` +
        `${a.adjusted ? a.adjusted.toExponential(1) : 'n/a'} | ` +
        `${a.confidence === 'proof' ? 'the provider reported a different model' : 'the distribution moved'} |`,
      );
    }

    lines.push('');

    for (const a of drifted) {
      if (a.reason) lines.push(`- \`${a.probeId}\`: ${a.reason}`);
    }
  } else {
    lines.push('| Probe | Modal answer | Moved | Verdict |');
    lines.push('| :--- | ---: | ---: | :--- |');
    for (const a of assessments) {
      lines.push(
        `| \`${a.probeId}\` | ${a.mode.count}/${a.samples} | ` +
        `${a.effect === undefined ? 'n/a' : `${(a.effect * 100).toFixed(0)}%`} | ${a.status} |`,
      );
    }
  }

  const sliding = assessments.filter((a) => a.status !== 'drifted' && a.chart?.out);

  if (sliding.length) {
    lines.push('', '**Sliding**', '');
    for (const a of sliding) {
      lines.push(`- \`${a.probeId}\`: the modal share sits outside its own control band, which a comparison against yesterday alone would miss.`);
    }
  }

  const inconclusive = assessments.filter((a) => a.status === 'inconclusive');

  if (inconclusive.length) {
    lines.push('', '**Nothing to compare**', '');
    for (const a of inconclusive) lines.push(`- \`${a.probeId}\`: ${a.reason}`);
  }

  if (summary.blind) {
    lines.push('', `_${summary.blind} probe(s) ran against a provider that reports no model identity, so those rest on statistics alone._`);
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------- timeline */

/**
 * The picture, as inline SVG with no dependency and no script.
 *
 * One line per probe showing the modal answer's share over time, with a marker
 * wherever the provider reported a different identity. This is the artefact
 * that settles an argument: the step is on a Tuesday, and your deploy was on
 * the Thursday.
 *
 * Drawn rather than charted by a library because a canary that pulls in a
 * charting dependency to render a line has lost the plot.
 */
export function toSvg(series, { width = 900, rowHeight = 90, padding = 48 } = {}) {
  const probes = Object.entries(series).filter(([, points]) => points.length > 1);

  if (probes.length === 0) {
    return svgWrap(width, 120, `<text x="${padding}" y="64" class="muted">Not enough history to draw yet. Two runs minimum.</text>`);
  }

  const height = padding * 2 + probes.length * rowHeight;
  const plotWidth = width - padding * 2 - 140;
  const body = [];

  probes.forEach(([probeId, points], row) => {
    const top = padding + row * rowHeight;
    const baseline = top + rowHeight - 30;
    const scale = rowHeight - 50;

    const x = (i) => padding + 140 + (points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
    const y = (share) => baseline - share * scale;

    body.push(`<text x="${padding}" y="${top + 20}" class="label">${escape(probeId)}</text>`);
    body.push(`<line x1="${padding + 140}" y1="${baseline}" x2="${width - padding}" y2="${baseline}" class="axis"/>`);
    body.push(`<line x1="${padding + 140}" y1="${y(1)}" x2="${width - padding}" y2="${y(1)}" class="grid"/>`);
    body.push(`<text x="${padding + 128}" y="${y(1) + 4}" class="tick" text-anchor="end">1.0</text>`);
    body.push(`<text x="${padding + 128}" y="${baseline + 4}" class="tick" text-anchor="end">0</text>`);

    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.share).toFixed(1)}`).join(' ');
    body.push(`<path d="${path}" class="line"/>`);

    points.forEach((p, i) => {
      const cls = p.identityChanged ? 'mark proof' : p.drifted ? 'mark drift' : 'mark';
      body.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(p.share).toFixed(1)}" r="${p.identityChanged ? 5 : 3}" class="${cls}"><title>${escape(p.at ?? '')} share ${(p.share * 100).toFixed(0)}%${p.identityChanged ? ', provider reported a different model' : ''}</title></circle>`);
    });
  });

  return svgWrap(width, height, body.join('\n  '));
}

function svgWrap(width, height, body) {
  // Colours resolve against both light and dark backgrounds, because this ends
  // up pasted into a pull request and nobody knows which theme the reader uses.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
  <style>
    .label { font-size: 13px; fill: #8b949e; }
    .tick  { font-size: 10px; fill: #6e7681; }
    .muted { font-size: 13px; fill: #8b949e; }
    .axis  { stroke: #6e7681; stroke-width: 1; }
    .grid  { stroke: #6e7681; stroke-width: 1; stroke-dasharray: 2 4; opacity: .5; }
    .line  { fill: none; stroke: #58a6ff; stroke-width: 2; }
    .mark  { fill: #58a6ff; }
    .mark.drift { fill: #f85149; }
    .mark.proof { fill: #f85149; stroke: #f85149; stroke-width: 3; }
  </style>
  ${body}
</svg>`;
}

const escape = (s) => String(s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
