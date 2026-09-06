/* SG Job Dashboard - static front end.
 *
 * Reads two files out of a PRIVATE GitHub repo using a fine-grained, read-only
 * token that the user pastes into Settings:
 *   data/jobs.json      - written nightly by the pipeline
 *   data/companies.json - written by the manual Claude enrichment pass
 *
 * Everything else (saved / dismissed) is per-browser state in localStorage;
 * the token has no write access, by design.
 */

// The private repo hosts several unrelated projects, so the feed lives under a
// subdirectory rather than at the repo root. Change this if you move it.
const DATA_DIR = 'jobs/data';

const LS = {
  cfg: 'jobdash.config',
  state: 'jobdash.state',
  filters: 'jobdash.filters',
};

const el = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

let DATA = { jobs: [], counts: {}, profileSnapshot: {} };
let COMPANIES = {};
let JOB_STATE = store.get(LS.state, {}); // id -> "saved" | "dismissed"

/* ----------------------------------------------------------- GitHub API --- */

async function ghFile(cfg, filePath) {
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${filePath}?ref=${encodeURIComponent(cfg.branch || 'main')}`;
  const res = await fetch(url, {
    headers: {
      // raw media type streams the file itself and lifts the 1MB JSON-API cap.
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (res.status === 401) throw new Error('Token rejected (401). It may be expired or mistyped.');
  if (res.status === 403) throw new Error('Forbidden (403). The token probably lacks Contents:read on this repo.');
  if (res.status === 404) throw new Error(`Not found: ${cfg.repo}/${filePath}. Check the repo name, branch, and that the token can see this repo.`);
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);

  return res.json();
}

/* ------------------------------------------------------------- loading --- */

async function load({ silent = false } = {}) {
  const cfg = store.get(LS.cfg, null);

  // Local preview. Serving this folder with data/ copied in next to it lets you
  // check a layout change without a repo or a token; on localhost it is the
  // default, and `?local=1` forces it anywhere.
  const onLocalhost = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  const local = new URLSearchParams(location.search).has('local') || (onLocalhost && !cfg?.token);

  if (!local && (!cfg?.repo || !cfg?.token)) return showSetup();

  setStatus('loading');
  if (!silent) setMsg('Loading…', '');

  try {
    const read = local
      ? (f) => fetch(`./${f}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${f}: ${r.status}`))))
      : (f) => ghFile(cfg, f);

    // Local preview reads ./data/ next to the page; the real thing reads the
    // subdirectory inside the private repo.
    const dir = local ? 'data' : DATA_DIR;

    DATA = await read(`${dir}/jobs.json`);
    // Enrichment is optional - a missing file is a normal first-run state.
    COMPANIES = await read(`${dir}/companies.json`).catch(() => ({}));

    setStatus('ok');
    setMsg('', '');
    el('setup').hidden = true;
    el('stats').hidden = false;
    el('controls').hidden = false;
    el('generatedAt').textContent = DATA.generatedAt
      ? `updated ${timeAgo(DATA.generatedAt)}`
      : '';
    renderStats();
    render();
  } catch (err) {
    setStatus('err');
    showSetup();
    setMsg(err.message, 'err');
  }
}

function setStatus(s) {
  el('statusDot').className = `dot ${s}`;
}

function showSetup() {
  const cfg = store.get(LS.cfg, {});
  el('cfgRepo').value = cfg.repo || '';
  el('cfgBranch').value = cfg.branch || 'main';
  el('cfgToken').value = cfg.token || '';
  el('setup').hidden = false;
}

function setMsg(text, cls) {
  const m = el('setupMsg');
  m.textContent = text;
  m.className = `setup-msg ${cls || ''}`;
}

/* ------------------------------------------------------------ rendering --- */

function renderStats() {
  const c = DATA.counts || {};
  const p = DATA.profileSnapshot || {};
  const above = DATA.jobs.filter((j) => j.salaryEstimate?.totalMax >= (p.targetTotalAnnualMin || 0)).length;

  el('stats').innerHTML = [
    stat(c.total ?? 0, 'postings tracked'),
    stat(c.new ?? 0, 'new since last run'),
    stat(c.strongMatches ?? 0, 'scoring 70 or above'),
    stat(above, `could beat ${money(p.targetTotalAnnualMin)}`),
    stat(Object.keys(COMPANIES).length, 'companies researched'),
  ].join('');
}

const stat = (v, k) => `<div class="stat"><span class="v">${v}</span><span class="k">${k}</span></div>`;

function currentFilters() {
  return {
    q: el('q').value.trim().toLowerCase(),
    minScore: +el('minScore').value,
    minComp: +el('minComp').value,
    sortBy: el('sortBy').value,
    hideAgency: el('hideAgency').checked,
    declaredOnly: el('declaredOnly').checked,
    newOnly: el('newOnly').checked,
    showHidden: el('showHidden').checked,
  };
}

function render() {
  const f = currentFilters();
  store.set(LS.filters, f);
  el('minScoreOut').value = f.minScore;

  let jobs = DATA.jobs.filter((j) => {
    if (JOB_STATE[j.id] === 'dismissed' && !f.showHidden) return false;
    if (j.score < f.minScore) return false;
    if (f.hideAgency && j.isAgency) return false;
    if (f.declaredOnly && j.salaryEstimate?.origin !== 'posting') return false;
    if (f.newOnly && !j.isNew) return false;
    if (f.minComp && (j.salaryEstimate?.totalMax ?? 0) < f.minComp) return false;
    if (f.q) {
      const hay = [j.title, j.company, j.location, (j.skills || []).join(' '), j.description]
        .join(' ').toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });

  const cmp = {
    score: (a, b) => b.score - a.score,
    comp: (a, b) => (b.salaryEstimate?.totalMax ?? 0) - (a.salaryEstimate?.totalMax ?? 0),
    date: (a, b) => String(b.postedAt || '').localeCompare(String(a.postedAt || '')),
  }[f.sortBy];
  jobs = jobs.slice().sort(cmp);

  // Saved jobs float to the top regardless of sort.
  jobs.sort((a, b) => (JOB_STATE[b.id] === 'saved') - (JOB_STATE[a.id] === 'saved'));

  el('resultCount').textContent = `${jobs.length} shown`;

  const list = el('list');
  list.replaceChildren(...jobs.map(card));

  const empty = el('empty');
  empty.hidden = jobs.length > 0;
  if (!jobs.length) {
    empty.textContent = DATA.jobs.length
      ? 'Nothing matches these filters. Try lowering the minimum score.'
      : 'No jobs in the feed yet. Has the pipeline run?';
  }
}

function card(job) {
  const node = el('jobTpl').content.cloneNode(true);
  const root = node.querySelector('.job');
  const state = JOB_STATE[job.id];
  if (state) root.classList.add(state);

  // Score
  const sc = node.querySelector('.job-score');
  sc.classList.add(job.score >= 70 ? 's-hi' : job.score >= 50 ? 's-mid' : 's-lo');
  node.querySelector('.score-num').textContent = job.score;

  // Title + badges
  const title = node.querySelector('.job-title');
  title.textContent = job.title;
  title.href = job.url;

  const company = COMPANIES[job.companyKey];
  const badges = node.querySelector('.badges');
  if (job.isNew) badges.append(badge('new', 'new'));
  if (job.isAgency) badges.append(badge('agency', 'agency'));
  const tier = job.companyTier ?? company?.tier;
  if (tier) badges.append(badge(`tier ${tier}`, tier === 1 ? 'tier1' : ''));
  badges.append(badge(sourceLabel(job.source)));

  // Meta line
  node.querySelector('.job-meta').innerHTML = [
    `<span><b>${escapeHTML(job.company)}</b></span>`,
    `<span>${escapeHTML(job.location || 'Singapore')}</span>`,
    job.postedAt ? `<span>posted ${timeAgo(job.postedAt)}</span>` : '',
    job.minYearsExperience != null ? `<span>${job.minYearsExperience}y+ required</span>` : '',
    job.applicants ? `<span>${job.applicants} applicants</span>` : '',
  ].filter(Boolean).join('');

  // Company brief from the enrichment pass
  const briefBox = node.querySelector('.company-brief');
  if (company?.brief) {
    briefBox.innerHTML = [
      `<b>${escapeHTML(company.name || job.company)}</b> — ${escapeHTML(company.brief)}`,
      company.sgPresence ? `<br>Singapore: ${escapeHTML(company.sgPresence)}` : '',
      company.watchOuts ? `<br><span class="watch">Watch out: ${escapeHTML(company.watchOuts)}</span>` : '',
    ].join('');
  } else {
    briefBox.remove();
  }

  // Salary
  const s = job.salaryEstimate;
  const current = DATA.profileSnapshot?.currentTotalAnnual ?? 0;
  const trend = s.totalMax >= current * 1.1 ? 'up' : s.totalMax < current ? 'down' : '';
  node.querySelector('.salary').innerHTML = `
    <span class="amount ${trend}">${money(s.totalMin)} – ${money(s.totalMax)}</span>
    <span class="tag ${s.origin === 'posting' ? 'declared' : 'modelled'}">${s.origin === 'posting' ? 'declared' : 'estimated'}</span>
    <span class="muted">total comp</span>
    <span class="note">${escapeHTML(s.note)}</span>`;

  // Why this score
  const reasons = node.querySelector('.reasons');
  for (const r of (job.reasons || []).slice(0, 6)) {
    const li = document.createElement('li');
    li.className = r.kind;
    li.textContent = r.text;
    reasons.append(li);
  }

  // Actions
  node.querySelector('.apply').href = job.url;
  const saveBtn = node.querySelector('.save');
  const dismissBtn = node.querySelector('.dismiss');
  saveBtn.textContent = state === 'saved' ? 'Saved' : 'Save';
  saveBtn.classList.toggle('on', state === 'saved');
  dismissBtn.textContent = state === 'dismissed' ? 'Restore' : 'Dismiss';

  saveBtn.onclick = () => toggleState(job.id, 'saved');
  dismissBtn.onclick = () => toggleState(job.id, 'dismissed');

  const jd = node.querySelector('.jd');
  const expand = node.querySelector('.expand');
  if (!job.description) expand.remove();
  else expand.onclick = () => {
    jd.hidden = !jd.hidden;
    if (!jd.textContent) jd.textContent = job.description;
    expand.textContent = jd.hidden ? 'Description' : 'Hide';
  };

  return node;
}

function toggleState(id, value) {
  JOB_STATE[id] = JOB_STATE[id] === value ? undefined : value;
  if (!JOB_STATE[id]) delete JOB_STATE[id];
  store.set(LS.state, JOB_STATE);
  render();
}

/* -------------------------------------------------------------- helpers --- */

function badge(text, cls = '') {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

const SOURCE_LABEL = {
  mycareersfuture: 'MyCareersFuture',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
};
const sourceLabel = (s) => SOURCE_LABEL[s] || s;

function money(n) {
  if (!n) return '—';
  return 'S$' + Math.round(n / 1000) + 'k';
}

function timeAgo(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------------------------------------------- wiring --- */

el('saveCfg').onclick = async () => {
  const repo = el('cfgRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  const token = el('cfgToken').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return setMsg('Repository should look like owner/name.', 'err');
  if (!token) return setMsg('A token is required to read a private repo.', 'err');

  store.set(LS.cfg, { repo, branch: el('cfgBranch').value.trim() || 'main', token });
  setMsg('Connecting…', '');
  await load();
};

el('clearCfg').onclick = () => {
  store.del(LS.cfg);
  el('cfgToken').value = '';
  setMsg('Token removed from this browser.', 'ok');
  setStatus('');
};

el('settingsBtn').onclick = () => {
  const s = el('setup');
  s.hidden = !s.hidden;
  if (!s.hidden) showSetup();
};

el('refreshBtn').onclick = () => load({ silent: true });

for (const id of ['q', 'minScore', 'minComp', 'sortBy', 'hideAgency', 'declaredOnly', 'newOnly', 'showHidden']) {
  el(id).addEventListener('input', render);
}

// Restore last-used filters before the first paint.
(function restoreFilters() {
  const f = store.get(LS.filters, null);
  if (!f) return;
  el('q').value = f.q || '';
  el('minScore').value = f.minScore ?? 55;
  el('minComp').value = f.minComp ?? 160000;
  el('sortBy').value = f.sortBy || 'score';
  el('hideAgency').checked = f.hideAgency ?? true;
  el('declaredOnly').checked = f.declaredOnly ?? false;
  el('newOnly').checked = f.newOnly ?? false;
  el('showHidden').checked = f.showHidden ?? false;
})();

load();
