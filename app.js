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

// Where saved / applied / dismissed lives when sync is configured. One small
// JSON file in a repo of its own, so the token that can write it cannot touch
// anything else.
const SYNC_PATH = 'dashboard-state.json';
let SYNC_SHA = null;      // blob sha of the copy we last saw, for safe updates
let SYNC_TIMER = null;

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
// id -> { status: 'saved' | 'applied' | 'dismissed', at: 'YYYY-MM-DD' }
// Earlier versions stored a bare string, so migrate anything of that shape.
let JOB_STATE = migrateState(store.get(LS.state, {}));
let VIEW = 'all';

function migrateState(raw) {
  const out = {};
  for (const [id, v] of Object.entries(raw || {})) {
    if (typeof v === 'string') out[id] = { status: v, at: null, ts: 0 };
    else if (v && v.status) out[id] = { ts: 0, ...v };
  }
  return out;
}

// Deletions have to be recorded, or un-saving something on the laptop would be
// undone by the phone's copy still listing it.
let TOMBSTONES = store.get('jobdash.removed', {});

/**
 * Merge two devices' state. Every record carries the millisecond timestamp of
 * the change that produced it, including deletions, so the later edit wins per
 * job rather than one whole device's copy overwriting the other's.
 */
function mergeState(localEntries, localRemoved, remote) {
  const entries = {};
  const removed = { ...(localRemoved || {}), ...(remote?.removed || {}) };
  for (const [id, t] of Object.entries(localRemoved || {})) {
    removed[id] = Math.max(t, remote?.removed?.[id] || 0);
  }
  const all = new Set([...Object.keys(localEntries || {}), ...Object.keys(remote?.entries || {})]);
  for (const id of all) {
    const a = localEntries?.[id];
    const b = remote?.entries?.[id];
    const winner = (a?.ts || 0) >= (b?.ts || 0) ? a : b;
    if (!winner) continue;
    if ((removed[id] || 0) > (winner.ts || 0)) continue;   // deleted after this edit
    entries[id] = winner;
    delete removed[id];
  }
  return { entries, removed };
}

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local
const statusOf = (id) => JOB_STATE[id]?.status ?? null;

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
    el('views').hidden = false;
    el('controls').hidden = false;
    el('generatedAt').textContent = DATA.generatedAt
      ? `updated ${timeAgo(DATA.generatedAt)}`
      : '';
    renderStats();
    renderCounts();
    render();

    // Pull the other devices' saved/applied state after the feed is on screen,
    // so a slow or misconfigured sync never blocks the jobs from rendering.
    pullState();
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
  el('cfgStateRepo').value = cfg.stateRepo || '';
  el('cfgStateToken').value = cfg.stateToken || '';
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

  const total = c.total ?? 0;
  const read = c.assessed ?? 0;
  const worth = (c.strongFit ?? 0) + (c.goodFit ?? 0);

  el('stats').innerHTML = [
    stat(total, 'postings tracked', `${c.new ?? 0} new since the last run`),
    stat(read, 'read and assessed', `${total - read} never opened`),
    stat(worth, 'worth applying to', `out of the ${read} read, not the ${total}`),
    stat(c.strongFit ?? 0, 'strong fits', `out of the ${read} read`),
    stat(c.awaitingAssessment ?? 0, 'queued to read next', 'ranked by keyword score'),
    stat(c.directFromEmployer ?? 0, 'direct from employer', 'not via a job board'),
    stat(above, `could beat ${money(p.targetTotalAnnualMin)}`, 'declared or modelled'),
  ].join('');
}

// `note` states the denominator. Without it a tile like "17 worth applying to"
// reads as 17 out of everything tracked, when it is 17 out of the 100 read.
const stat = (v, k, note) =>
  `<div class="stat"><span class="v">${v}</span><span class="k">${k}</span>` +
  (note ? `<span class="n">${note}</span>` : '') +
  `</div>`;

function currentFilters() {
  return {
    q: el('q').value.trim().toLowerCase(),
    minGrade: el('minGrade').value,
    minCred: +el('minCred').value,
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

  // Saved and Applied are lists, not filters: they ignore the filter bar
  // entirely, because a job you have already applied to should never vanish
  // because today's minimum-fit setting moved.
  if (VIEW !== 'all') {
    const wanted = DATA.jobs.filter((j) => statusOf(j.id) === VIEW);
    wanted.sort((a, b) => String(JOB_STATE[b.id].at || '').localeCompare(String(JOB_STATE[a.id].at || '')));
    el('resultCount').textContent = `${wanted.length} ${VIEW}`;
    el('list').replaceChildren(...wanted.map(card));
    const emptyEl = el('empty');
    emptyEl.hidden = wanted.length > 0;
    emptyEl.textContent =
      VIEW === 'applied'
        ? 'Nothing marked as applied yet. Use the Applied button on a card.'
        : 'Nothing saved yet. Use the Save button on a card.';
    return;
  }

  let jobs = DATA.jobs.filter((j) => {
    // Saving is a decision, the same as dismissing: once made, the job leaves
    // this list and lives in its own tab. All is the untriaged pile.
    const st = statusOf(j.id);
    if ((st === 'saved' || st === 'dismissed') && !f.showHidden) return false;
    if (!passesGrade(j, f.minGrade)) return false;
    if ((j.credibility?.score ?? 50) < f.minCred) return false;
    if (f.hideAgency && j.isAgency) return false;
    if (f.declaredOnly && j.salaryEstimate?.origin !== 'posting') return false;
    if (f.newOnly && !j.isNew) return false;
    if (f.minComp && (j.salaryEstimate?.totalMax ?? 0) < f.minComp) return false;
    // Company name only. Searching descriptions too meant typing "platform"
    // returned half the feed, which is what the fit filter is already for.
    if (f.q && !j.company.toLowerCase().includes(f.q)) return false;
    return true;
  });

  const cmp = {
    fit: (a, b) => gradeRank(b) - gradeRank(a) || b.keywordScore - a.keywordScore,
    credibility: (a, b) => (b.credibility?.score ?? 0) - (a.credibility?.score ?? 0) || gradeRank(b) - gradeRank(a),
    comp: (a, b) => (b.salaryEstimate?.totalMax ?? 0) - (a.salaryEstimate?.totalMax ?? 0),
    date: (a, b) => String(b.postedAt || '').localeCompare(String(a.postedAt || '')),
  }[f.sortBy] || ((a, b) => gradeRank(b) - gradeRank(a));
  jobs = jobs.slice().sort(cmp);

  // Applied jobs still float to the top: they stay in this list, and seeing
  // them here is the reminder of what is already out the door.
  jobs.sort((a, b) => (statusOf(b.id) === 'applied') - (statusOf(a.id) === 'applied'));

  el('resultCount').textContent = `${jobs.length} shown`;

  const list = el('list');
  list.replaceChildren(...jobs.map(card));

  const empty = el('empty');
  empty.hidden = jobs.length > 0;
  if (!jobs.length) {
    empty.textContent = DATA.jobs.length
      ? 'Nothing matches these filters. Most postings have not been read yet — set Fit to "any" to see them, or run the assessment pass.'
      : 'No jobs in the feed yet. Has the pipeline run?';
  }
}

// Assessed grades outrank the keyword score, which is triage only.
const GRADE_ORDER = ['avoid', 'unknown', 'weak-fit', 'stretch', 'good-fit', 'strong-fit'];
const GRADE_LABEL = {
  'strong-fit': 'Strong fit', 'good-fit': 'Good fit', stretch: 'Stretch',
  'weak-fit': 'Weak fit', avoid: 'Avoid', unknown: 'Unclear',
};
const gradeRank = (j) => (j.verdict ? GRADE_ORDER.indexOf(j.verdict.grade) + 1 : 0);

function passesGrade(job, mode) {
  if (mode === 'any') return true;
  if (!job.verdict) return false;              // every other mode wants an assessment
  if (mode === 'assessed') return true;
  return GRADE_ORDER.indexOf(job.verdict.grade) >= GRADE_ORDER.indexOf(mode);
}

const CRED_LABEL = {
  direct: 'Direct', likely: 'Likely real', unclear: 'Unclear', suspect: 'Compliance risk',
};

function card(job) {
  const node = el('jobTpl').content.cloneNode(true);
  const root = node.querySelector('.job');
  const state = statusOf(job.id);
  if (state) root.classList.add(state);

  // Fit grade (from the reading pass) and provenance (from the rules).
  const gradeChip = node.querySelector('.grade-chip');
  if (job.verdict) {
    gradeChip.className = `grade-chip g-${job.verdict.grade}`;
    gradeChip.innerHTML = `<span class="g-main">${GRADE_LABEL[job.verdict.grade] || job.verdict.grade}</span>`;
  } else {
    gradeChip.className = 'grade-chip g-pending';
    gradeChip.innerHTML = `<span class="g-main">Not read yet</span><span class="g-sub">kw ${job.keywordScore}</span>`;
  }

  const cred = job.credibility || { grade: 'unclear', score: 50 };
  const credChip = node.querySelector('.cred-chip');
  credChip.className = `cred-chip c-${cred.grade}`;
  credChip.textContent = CRED_LABEL[cred.grade] || cred.grade;
  credChip.title = (cred.reasons || []).map((r) => r.text).join('\n');

  // Title + badges
  const title = node.querySelector('.job-title');
  title.textContent = job.title;
  title.href = job.url;

  const company = COMPANIES[job.companyKey];
  const badges = node.querySelector('.badges');
  if (state === 'applied') {
    badges.append(badge(`applied ${JOB_STATE[job.id].at || ''}`.trim(), 'applied-badge'));
  }
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

  // The assessment reads company-first: the note is what this particular
  // posting is, and everything under it is the shared read on the employer,
  // written once however many requisitions they have open.
  const box = node.querySelector('.assessment');
  if (job.verdict) {
    const v = job.verdict;
    const c = v.company || {};
    const others = (c.postingCount || 1) - 1;
    box.innerHTML = [
      v.note ? `<p class="a-headline">${escapeHTML(v.note)}</p>` : '',
      c.brief
        ? `<p class="a-co-label">关于 ${escapeHTML(c.name || job.company)}` +
          (others > 0 ? `（另有 ${others} 个在招岗位）` : '') +
          `</p><p class="a-why">${escapeHTML(c.brief)}</p>`
        : '',
      c.matches?.length
        ? `<div class="a-list a-match"><b>匹配</b><ul>${c.matches.map((m) => `<li>${escapeHTML(m)}</li>`).join('')}</ul></div>`
        : '',
      c.gaps?.length
        ? `<div class="a-list a-gap"><b>差距</b><ul>${c.gaps.map((m) => `<li>${escapeHTML(m)}</li>`).join('')}</ul></div>`
        : '',
      c.compRead ? `<p class="a-comp">${escapeHTML(c.compRead)}</p>` : '',
      c.verdict ? `<p class="a-verdict">${escapeHTML(c.verdict)}</p>` : '',
    ].join('');
  } else {
    box.remove();
  }

  // Company brief from the enrichment pass
  const briefBox = node.querySelector('.company-brief');
  if (company?.brief) {
    briefBox.innerHTML = [
      `<b>${escapeHTML(company.name || job.company)}</b> — ${escapeHTML(company.brief)}`,
      company.sgPresence ? `<br>Singapore: ${escapeHTML(company.sgPresence)}` : '',
      company.watchOuts ? `<br><span class="watch">注意：${escapeHTML(company.watchOuts)}</span>` : '',
    ].join('');
  } else {
    briefBox.remove();
  }

  // Reported compensation from Levels.fyi. Shown above the modelled estimate
  // because a real number, however thin the sample, beats a tier multiplier.
  // Their terms ask for attribution and a link back, hence the cited link.
  const compBox = node.querySelector('.reported-comp');
  const rc = job.reportedComp;
  if (rc?.medianTotal) {
    const ladder = (rc.levels || [])
      .filter((l) => l.total)
      .map((l) => `<span class="rung"><b>${escapeHTML(l.level)}</b> ${money(l.total)}</span>`)
      .join('');
    compBox.innerHTML =
      `<div class="rc-head">Reported median <b>${money(rc.medianTotal)}</b> ` +
      `<span class="rc-note">software engineer, Singapore</span>` +
      `<a href="${escapeHTML(rc.url)}" target="_blank" rel="noopener noreferrer" class="rc-src">Levels.fyi</a></div>` +
      (ladder ? `<div class="rc-ladder">${ladder}</div>` : '');
  } else {
    compBox.remove();
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
  for (const r of (job.reasons || []).slice(0, job.verdict ? 3 : 6)) {
    const li = document.createElement('li');
    li.className = r.kind;
    li.textContent = r.text;
    reasons.append(li);
  }

  // Actions
  node.querySelector('.apply').href = job.url;
  const saveBtn = node.querySelector('.save');
  // Not '.applied': the card root carries that as a state class.
  const appliedBtn = node.querySelector('.mark-applied');
  const dismissBtn = node.querySelector('.dismiss');

  saveBtn.textContent = state === 'saved' ? 'Saved' : 'Save';
  saveBtn.classList.toggle('on', state === 'saved');
  appliedBtn.classList.toggle('on', state === 'applied');
  dismissBtn.textContent = state === 'dismissed' ? 'Restore' : 'Dismiss';

  saveBtn.onclick = () => setState(job.id, 'saved');
  appliedBtn.onclick = () => setState(job.id, 'applied');
  dismissBtn.onclick = () => setState(job.id, 'dismissed');

  // Glassdoor holds employer ratings but forbids automated access in its
  // robots.txt, so this is a deep link rather than a scraped number.
  node.querySelector('.glassdoor').href =
    `https://www.glassdoor.sg/Search/results.htm?keyword=${encodeURIComponent(company?.name || job.company)}`;

  // The date is editable because you often mark a job applied days later.
  const dateWrap = node.querySelector('.applied-on');
  const dateInput = node.querySelector('.applied-date');
  if (state === 'applied') {
    dateWrap.hidden = false;
    dateInput.value = JOB_STATE[job.id].at || today();
    dateInput.max = today();
    dateInput.onchange = () => {
      JOB_STATE[job.id].at = dateInput.value || today();
      JOB_STATE[job.id].ts = Date.now();
      persistState();
      render();
    };
  }

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

function setState(id, value) {
  const ts = Date.now();
  if (statusOf(id) === value) {
    delete JOB_STATE[id];
    TOMBSTONES[id] = ts;
  } else {
    JOB_STATE[id] = { status: value, at: JOB_STATE[id]?.at || today(), ts };
    delete TOMBSTONES[id];
  }
  persistState();
  renderCounts();
  render();
}

function persistState() {
  store.set(LS.state, JOB_STATE);
  store.set('jobdash.removed', TOMBSTONES);
  schedulePush();
}

/* -------------------------------------------------------- cross-device --- */

const syncCfg = () => {
  const c = store.get(LS.cfg, {}) || {};
  return c.stateRepo && c.stateToken
    ? { repo: c.stateRepo, token: c.stateToken, branch: c.stateBranch || 'main' }
    : null;
};

function syncStatus(text, kind = '') {
  const n = el('syncStatus');
  if (n) { n.textContent = text; n.className = `sync-status ${kind}`; }
}

async function pullState() {
  const cfg = syncCfg();
  if (!cfg) return;
  syncStatus('syncing…');
  try {
    const url = `https://api.github.com/repos/${cfg.repo}/contents/${SYNC_PATH}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`,
                 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (res.status === 404) { SYNC_SHA = null; syncStatus('synced (new file)', 'ok'); return schedulePush(0); }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const meta = await res.json();
    SYNC_SHA = meta.sha;
    const remote = JSON.parse(decodeURIComponent(escape(atob(meta.content.replace(/\n/g, '')))));
    const merged = mergeState(JOB_STATE, TOMBSTONES, remote);
    JOB_STATE = merged.entries;
    TOMBSTONES = merged.removed;
    store.set(LS.state, JOB_STATE);
    store.set('jobdash.removed', TOMBSTONES);
    syncStatus('synced', 'ok');
    renderCounts();
    render();
  } catch (err) {
    syncStatus(`sync failed: ${err.message}`, 'bad');
  }
}

function schedulePush(delay = 1500) {
  if (!syncCfg()) return;
  clearTimeout(SYNC_TIMER);
  SYNC_TIMER = setTimeout(pushState, delay);
}

async function pushState() {
  const cfg = syncCfg();
  if (!cfg) return;
  syncStatus('saving…');
  const body = { entries: JOB_STATE, removed: TOMBSTONES, updatedAt: new Date().toISOString() };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(body, null, 1))));
  try {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${SYNC_PATH}`, {
      method: 'PUT',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`,
                 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `state: ${new Date().toISOString().slice(0, 10)}`,
                             content, branch: cfg.branch, ...(SYNC_SHA ? { sha: SYNC_SHA } : {}) }),
    });
    // 409 means another device wrote first: take theirs, merge, try again.
    if (res.status === 409 || res.status === 422) { await pullState(); return schedulePush(500); }
    if (res.status === 403) throw new Error('token lacks Contents:write on the state repo');
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    SYNC_SHA = (await res.json()).content.sha;
    syncStatus('synced', 'ok');
  } catch (err) {
    syncStatus(`sync failed: ${err.message}`, 'bad');
  }
}

function renderCounts() {
  const n = (s) => Object.values(JOB_STATE).filter((v) => v.status === s).length;
  el('nSaved').textContent = n('saved');
  el('nApplied').textContent = n('applied');
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

  store.set(LS.cfg, {
    repo, branch: el('cfgBranch').value.trim() || 'main', token,
    stateRepo: el('cfgStateRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
    stateToken: el('cfgStateToken').value.trim(),
  });
  setMsg('Connecting…', '');
  await load();
};

el('clearCfg').onclick = () => {
  store.del(LS.cfg);
  el('cfgToken').value = '';
  el('cfgStateToken').value = '';
  setMsg('Token removed from this browser.', 'ok');
  setStatus('');
};

el('settingsBtn').onclick = () => {
  const s = el('setup');
  s.hidden = !s.hidden;
  if (!s.hidden) showSetup();
};

el('refreshBtn').onclick = () => load({ silent: true });

for (const tab of document.querySelectorAll('.view-tab')) {
  tab.onclick = () => {
    VIEW = tab.dataset.view;
    document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('on', t === tab));
    el('controls').hidden = VIEW !== 'all';   // filters only mean anything in All
    render();
  };
}

for (const id of ['q', 'minGrade', 'minCred', 'minComp', 'sortBy', 'hideAgency', 'declaredOnly', 'newOnly', 'showHidden']) {
  el(id).addEventListener('input', render);
}

// Restore last-used filters before the first paint.
(function restoreFilters() {
  const f = store.get(LS.filters, null);
  if (!f) return;
  el('q').value = f.q || '';
  el('minGrade').value = f.minGrade ?? 'good-fit';
  el('minCred').value = f.minCred ?? 40;
  el('minComp').value = f.minComp ?? 160000;
  el('sortBy').value = f.sortBy || 'fit';
  el('hideAgency').checked = f.hideAgency ?? true;
  el('declaredOnly').checked = f.declaredOnly ?? false;
  el('newOnly').checked = f.newOnly ?? false;
  el('showHidden').checked = f.showHidden ?? false;
})();

load();
