/**
 * Drives the research UI.
 *
 * The server streams one JSON object per SSE frame; each stage updates its own
 * section, so Exa's raw hits are on screen long before the ranking finishes.
 *
 * Everything from the network is inserted as text, never as HTML — the titles
 * and excerpts come from arbitrary web pages.
 */

const $ = (id) => document.getElementById(id);

const el = {
  form: $('run-form'),
  query: $('query'),
  numResults: $('numResults'),
  topK: $('topK'),
  searchType: $('searchType'),
  chunk: $('chunk'),
  cluster: $('cluster'),
  synthesize: $('synthesize'),
  provider: $('provider'),
  providerField: $('provider-field'),
  run: $('run'),
  cancel: $('cancel'),
  configWarning: $('config-warning'),

  progressPanel: $('progress-panel'),
  stages: $('stages'),
  elapsed: $('elapsed'),
  error: $('error'),

  exaPanel: $('exa-panel'),
  exaList: $('exa-list'),
  exaCount: $('exa-count'),
  exaMeta: $('exa-meta'),
  toggleExa: $('toggle-exa'),

  rankedPanel: $('ranked-panel'),
  rankedList: $('ranked-list'),
  rankedCount: $('ranked-count'),
  rankedMeta: $('ranked-meta'),

  themesPanel: $('themes-panel'),
  themes: $('themes'),

  synthesisPanel: $('synthesis-panel'),
  synthesis: $('synthesis'),
  synthesisMeta: $('synthesis-meta'),
  synthesisSources: $('synthesis-sources'),
  synthesisWarning: $('synthesis-warning'),
};

let controller = null;
let startedAt = 0;
let timer = null;

/* ---------------------------------------------------------------- helpers */

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function clear(target) {
  while (target.firstChild) target.removeChild(target.firstChild);
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function stage(key, label, detail, done) {
  let li = el.stages.querySelector(`[data-stage="${key}"]`);
  if (!li) {
    li = node('li');
    li.dataset.stage = key;
    li.append(node('span', 'tick'), node('span', 'name'), node('span', 'detail'));
    el.stages.append(li);
  }
  li.querySelector('.tick').textContent = done ? '✓' : '·';
  li.querySelector('.tick').className = done ? 'tick' : 'tick spin';
  li.querySelector('.name').textContent = label;
  li.querySelector('.detail').textContent = detail ?? '';
}

function startClock() {
  startedAt = Date.now();
  timer = setInterval(() => {
    el.elapsed.textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  }, 100);
}

function stopClock() {
  if (timer) clearInterval(timer);
  timer = null;
  if (startedAt) el.elapsed.textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function setRunning(running) {
  el.run.disabled = running;
  el.run.textContent = running ? 'Running…' : 'Run research';
  el.cancel.hidden = !running;
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
  el.progressPanel.hidden = false;
}

/* ------------------------------------------------------------- rendering */

function renderExa(event) {
  clear(el.exaList);
  el.exaCount.textContent = String(event.results.length);

  const cost = event.costDollars?.total;
  el.exaMeta.textContent =
    `Exa request ${event.requestId}` + (cost != null ? ` · $${cost}` : '');

  event.results.forEach((result, index) => {
    const li = node('li');
    li.append(node('span', 'idx', String(index + 1)));

    const body = node('div');
    const link = node('a', 'title', result.title || '(untitled)');
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    body.append(link, node('span', 'url', result.url));
    li.append(body);
    el.exaList.append(li);
  });

  el.exaPanel.hidden = false;
}

function deltaLabel(delta) {
  if (delta > 0) return { text: `↑${delta}`, cls: 'delta up' };
  if (delta < 0) return { text: `↓${-delta}`, cls: 'delta down' };
  return { text: '–', cls: 'delta flat' };
}

function renderRanked(report) {
  clear(el.rankedList);
  el.rankedCount.textContent = String(report.results.length);

  const s = report.stats;
  el.rankedMeta.textContent =
    `${s.retrieved} retrieved · ${s.exactDuplicates} duplicate URLs · ` +
    `${s.nearDuplicates} near-duplicates collapsed · ${s.chunks} passages embedded ` +
    `(${s.cacheHits} cached) · ${s.tokens} tokens · ${s.model} @ ${s.dim}d`;

  report.results.forEach((entry, index) => {
    const li = node('li');

    const head = node('div', 'result-head');
    head.append(node('span', 'score', entry.score.toFixed(3)));

    const delta = deltaLabel(entry.rankDelta);
    head.append(node('span', delta.cls, delta.text));

    const body = node('div');
    const link = node('a', 'title', `${index + 1}. ${entry.title || '(untitled)'}`);
    link.href = entry.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    body.append(link, node('span', 'url', entry.url));
    head.append(body);
    li.append(head);

    const excerpt = entry.bestChunk?.text || entry.highlights?.[0];
    if (excerpt) {
      li.append(node('blockquote', 'excerpt', excerpt.replace(/\s+/g, ' ').slice(0, 260)));
    }

    if (entry.duplicates.length > 0) {
      const dupes = node('div', 'dupes');
      dupes.append(
        node('div', null, `also covered by ${entry.duplicates.length} other source(s):`),
      );
      for (const dupe of entry.duplicates) {
        dupes.append(node('div', null, `↳ ${dupe.similarity.toFixed(3)}  ${hostOf(dupe.url)}`));
      }
      li.append(dupes);
    }

    el.rankedList.append(li);
  });

  el.rankedPanel.hidden = false;
}

function renderThemes(clusters, report) {
  clear(el.themes);
  if (!clusters || clusters.length === 0) {
    el.themesPanel.hidden = true;
    return;
  }

  clusters.forEach((cluster, index) => {
    const box = node('div', 'theme');
    box.append(
      node(
        'h3',
        null,
        `Theme ${index + 1} · ${cluster.members.length} result(s) · cohesion ${cluster.cohesion.toFixed(2)}`,
      ),
    );
    box.append(node('div', 'members', cluster.label));

    const list = node('div', 'members');
    for (const member of cluster.members) {
      const entry = report?.results?.[member];
      if (entry) list.append(node('div', null, `· ${entry.title || entry.url}`));
    }
    box.append(list);
    el.themes.append(box);
  });

  el.themesPanel.hidden = false;
}

/** Renders the write-up, turning [n] markers into links to the source list. */
function renderSynthesis(synthesis) {
  clear(el.synthesis);
  clear(el.synthesisSources);

  for (const paragraph of synthesis.text.split(/\n\s*\n/)) {
    if (paragraph.trim() === '') continue;
    const p = node('p');

    // Split on citation markers, keeping them, then linkify each number.
    const parts = paragraph.split(/(\[\d+(?:\s*,\s*\d+)*\])/g);
    for (const part of parts) {
      const match = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
      if (!match) {
        p.append(document.createTextNode(part));
        continue;
      }
      for (const raw of match[1].split(',')) {
        const marker = raw.trim();
        const a = node('a', 'cite', marker);
        a.href = `#source-${marker}`;
        // No trailing text node: spacing is CSS margin, so a citation
        // immediately before punctuation does not render " ." with a gap.
        p.append(a);
      }
    }
    el.synthesis.append(p);
  }

  for (const source of synthesis.sources) {
    const li = node('li', source.cited ? null : 'uncited');
    li.id = `source-${source.marker}`;
    li.append(node('span', 'marker', `[${source.marker}]`));

    const body = node('div');
    const link = node('a', 'title', source.result.title || source.result.url);
    link.href = source.result.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    body.append(link, node('span', 'url', source.result.url));
    if (!source.cited) body.append(node('span', 'small muted', ' — not cited in the write-up'));
    li.append(body);
    el.synthesisSources.append(li);
  }

  if (synthesis.invalidMarkers.length > 0) {
    // The check that makes the write-up trustworthy: a marker with no source
    // behind it means the model invented a citation.
    el.synthesisWarning.textContent =
      `Fabricated citations: ${synthesis.invalidMarkers.join(', ')}. ` +
      `These reference sources that do not exist — do not trust this write-up as-is.`;
    el.synthesisWarning.hidden = false;
  } else {
    el.synthesisWarning.hidden = true;
  }

  const usage = synthesis.usage;
  el.synthesisMeta.textContent =
    `${synthesis.model ?? ''}` +
    (usage ? ` · ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out` : '');

  el.synthesisPanel.hidden = false;
}

/* ------------------------------------------------------------ event pump */

let lastReport = null;

function handle(event) {
  switch (event.type) {
    case 'search:start':
      stage('search', 'Searching Exa', `“${event.query}” · ${event.numResults} results`, false);
      break;

    case 'search:done':
      stage('search', 'Searching Exa', `${event.results.length} results`, true);
      renderExa(event);
      break;

    case 'dedupe:exact':
      stage(
        'exact',
        'Exact-URL dedupe',
        `${event.removed} removed · ${event.kept} kept`,
        true,
      );
      break;

    case 'chunk:done':
      stage('chunk', 'Chunking', `${event.documents} docs → ${event.passages} passages`, true);
      break;

    case 'embed:start':
      stage('embed', 'Embedding', `${event.texts} texts`, false);
      break;

    case 'embed:done':
      stage(
        'embed',
        'Embedding',
        `${event.model} @ ${event.dim}d · ${event.tokens} tokens · ${event.cacheHits} cached`,
        true,
      );
      break;

    case 'rerank:done':
      stage('rerank', 'Reranking', `${event.ranked.length} scored`, true);
      break;

    case 'dedupe:near':
      stage('near', 'Near-duplicate dedupe', `${event.collapsed} collapsed`, true);
      break;

    case 'cluster:done':
      stage('cluster', 'Clustering', `${event.clusters.length} themes`, true);
      break;

    case 'report':
      lastReport = event.report;
      renderRanked(event.report);
      renderThemes(event.report.clusters, event.report);
      break;

    case 'synthesis:start':
      stage('synth', 'Writing up', event.provider, false);
      break;

    case 'synthesis:done':
      stage('synth', 'Writing up', 'done', true);
      renderSynthesis(event.synthesis);
      break;

    case 'done':
      break;

    case 'complete':
      setRunning(false);
      stopClock();
      break;

    case 'error':
      showError(`${event.name ?? 'Error'}: ${event.message}`);
      setRunning(false);
      stopClock();
      break;

    default:
      break;
  }
}

/* ---------------------------------------------------------------- run it */

async function run(payload) {
  controller = new AbortController();
  setRunning(true);
  startClock();

  el.error.hidden = true;
  el.progressPanel.hidden = false;
  clear(el.stages);
  for (const panel of [el.exaPanel, el.rankedPanel, el.themesPanel, el.synthesisPanel]) {
    panel.hidden = true;
  }

  let response;
  try {
    response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name !== 'AbortError') showError(`Could not reach the server: ${error.message}`);
    setRunning(false);
    stopClock();
    return;
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    showError(detail.error ?? `Server returned ${response.status}`);
    setRunning(false);
    stopClock();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            handle(JSON.parse(line.slice(5).trim()));
          } catch {
            // A malformed frame should not kill the stream.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') showError(error.message);
  } finally {
    setRunning(false);
    stopClock();
  }
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const topK = Number(el.topK.value);

  run({
    query: el.query.value,
    numResults: Number(el.numResults.value),
    topK: Number.isFinite(topK) && topK > 0 ? topK : undefined,
    searchType: el.searchType.value || undefined,
    chunk: el.chunk.checked,
    cluster: el.cluster.checked,
    synthesize: el.synthesize.checked,
    provider: el.provider.value || undefined,
  });
});

el.cancel.addEventListener('click', () => {
  controller?.abort();
  setRunning(false);
  stopClock();
});

el.toggleExa.addEventListener('click', () => {
  const collapsed = el.exaList.hidden;
  el.exaList.hidden = !collapsed;
  el.toggleExa.textContent = collapsed ? 'collapse' : 'expand';
});

/* Report what the server is actually configured for, rather than failing later. */
fetch('/api/config')
  .then((r) => r.json())
  .then((config) => {
    const missing = [];
    if (!config.hasExa) missing.push('EXA_API_KEY');
    if (!config.hasVoxell) missing.push('VOXELL_API_KEY');

    if (missing.length > 0) {
      el.configWarning.textContent = `Missing ${missing.join(' and ')} — searches will fail.`;
      el.configWarning.hidden = false;
    }

    if (config.providers.length === 0) {
      el.synthesize.checked = false;
      el.synthesize.disabled = true;
      el.synthesize.closest('.toggle').title =
        'Set ANTHROPIC_API_KEY or FIREWORKS_API_KEY to enable synthesis.';
    } else if (config.providers.length > 1) {
      for (const provider of config.providers) {
        el.provider.append(new Option(provider, provider));
      }
      el.providerField.hidden = false;
    }
  })
  .catch(() => {});
