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

// Where saved / applied / dismissed lives. Same private repo and same token as
// the feed, which means that token needs Contents:write — it can therefore
// reach everything else in that repo. Deliberate choice, not an oversight.
// Kept outside jobs/data/ so a pipeline run can never overwrite it.
const SYNC_PATH = 'jobs/dashboard-state.json';
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
let PAGE = 1;
const PER_PAGE = 10;      // companies per page

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
    renderSyncBtn();
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
  el('cfgSync').checked = cfg.sync !== false;
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

// Company state lives in the same map as posting state, under a prefix, so it
// syncs and merges through exactly the same path.
const coKey = (companyKey) => `co:${companyKey}`;
const coStatusOf = (companyKey) => statusOf(coKey(companyKey));

/** Group postings into company records, best-graded posting first. */
function groupByCompany(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    if (!groups.has(j.companyKey)) {
      groups.set(j.companyKey, { key: j.companyKey, name: j.company, jobs: [] });
    }
    groups.get(j.companyKey).jobs.push(j);
  }
  for (const g of groups.values()) {
    g.jobs.sort((x, y) => gradeRank(y) - gradeRank(x) || y.keywordScore - x.keywordScore);
    g.best = g.jobs[0];
  }
  return [...groups.values()];
}

function render() {
  const f = currentFilters();
  store.set(LS.filters, f);

  const list = el('list');
  const empty = el('empty');

  // Saved and Applied are lists, not filters: they ignore the filter bar
  // entirely, because a job you have already applied to should never vanish
  // because today's minimum-fit setting moved.
  if (VIEW !== 'all') {
    // A company saved as a whole brings all its postings; a posting saved on
    // its own brings only itself. Applied only ever exists on a posting.
    const picked = DATA.jobs.filter((j) => {
      if (statusOf(j.id) === VIEW) return true;
      return VIEW === 'saved' && coStatusOf(j.companyKey) === 'saved';
    });
    const groups = groupByCompany(picked);
    const stamp = (g) =>
      Math.max(...g.jobs.map((j) => JOB_STATE[j.id]?.ts || 0), JOB_STATE[coKey(g.key)]?.ts || 0);
    groups.sort((x, y) => stamp(y) - stamp(x));

    el('resultCount').textContent =
      VIEW === 'saved'
        ? `${groups.length} ${groups.length === 1 ? 'company' : 'companies'} saved · ` +
          `${picked.length} ${picked.length === 1 ? 'role' : 'roles'}`
        : `${picked.length} applied · ${groups.length} ${groups.length === 1 ? 'company' : 'companies'}`;
    list.replaceChildren(...paginate(groups).map((g) => companyCard(g, { view: VIEW })));
    empty.hidden = picked.length > 0;
    empty.textContent =
      VIEW === 'applied'
        ? 'Nothing marked as applied yet. Use the Applied button on a posting.'
        : 'Nothing saved yet. Save a company, or a single posting inside one.';
    return;
  }

  const jobs = DATA.jobs.filter((j) => {
    // A decision — saved or dismissed, on the posting or on the company —
    // takes it out of All. All is the untriaged pile.
    const st = statusOf(j.id);
    if ((st === 'saved' || st === 'dismissed') && !f.showHidden) return false;
    const cst = coStatusOf(j.companyKey);
    if ((cst === 'saved' || cst === 'dismissed') && !f.showHidden) return false;

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

  const groups = groupByCompany(jobs);

  // Companies are ranked by their best posting, because that is the one that
  // decides whether the company is worth opening at all.
  const cmp = {
    fit: (a, b) => gradeRank(b.best) - gradeRank(a.best) || b.best.keywordScore - a.best.keywordScore,
    credibility: (a, b) =>
      (b.best.credibility?.score ?? 0) - (a.best.credibility?.score ?? 0) || gradeRank(b.best) - gradeRank(a.best),
    comp: (a, b) =>
      Math.max(...b.jobs.map((j) => j.salaryEstimate?.totalMax ?? 0)) -
      Math.max(...a.jobs.map((j) => j.salaryEstimate?.totalMax ?? 0)),
    date: (a, b) =>
      String(b.jobs[0].postedAt || '').localeCompare(String(a.jobs[0].postedAt || '')),
  }[f.sortBy] || ((a, b) => gradeRank(b.best) - gradeRank(a.best));
  groups.sort(cmp);

  // A company with something already applied to floats up: it is the reminder
  // of what is out the door.
  const hasApplied = (g) => g.jobs.some((j) => statusOf(j.id) === 'applied');
  groups.sort((a, b) => hasApplied(b) - hasApplied(a));

  el('resultCount').textContent =
    `${groups.length} ${groups.length === 1 ? 'company' : 'companies'} · ` +
    `${jobs.length} ${jobs.length === 1 ? 'role' : 'roles'}`;
  list.replaceChildren(...paginate(groups).map((g) => companyCard(g, { view: 'all' })));

  empty.hidden = groups.length > 0;
  if (!groups.length) {
    empty.textContent = DATA.jobs.length
      ? 'Nothing matches these filters. Most postings have not been read yet — set Fit to "any" to see them, or run the assessment pass.'
      : 'No jobs in the feed yet. Has the pipeline run?';
  }
}

/**
 * Slice the company list to the current page and drive the controls. Clamps
 * PAGE so that narrowing a filter cannot strand you on an empty page 7.
 */
function paginate(groups) {
  const pages = Math.max(1, Math.ceil(groups.length / PER_PAGE));
  PAGE = Math.min(Math.max(1, PAGE), pages);

  const pager = el('pager');
  pager.hidden = groups.length <= PER_PAGE;
  if (!pager.hidden) {
    const from = (PAGE - 1) * PER_PAGE + 1;
    const to = Math.min(PAGE * PER_PAGE, groups.length);
    el('pageInfo').textContent = `${from}–${to} of ${groups.length} companies · page ${PAGE}/${pages}`;
    el('pagePrev').disabled = PAGE === 1;
    el('pageNext').disabled = PAGE === pages;
  }
  return groups.slice((PAGE - 1) * PER_PAGE, PAGE * PER_PAGE);
}

/* ------------------------------------------------------------- company --- */

function companyCard(group, { view }) {
  const node = el('coTpl').content.cloneNode(true);
  const root = node.querySelector('.co');
  const lead = group.best;
  const coState = coStatusOf(group.key);
  if (coState) root.classList.add(coState);

  // The company's fit is its best posting's fit — that is the one that decides
  // whether this card is worth opening.
  const gradeChip = node.querySelector('.grade-chip');
  if (lead.verdict) {
    gradeChip.className = `grade-chip g-${lead.verdict.grade}`;
    gradeChip.innerHTML = `<span class="g-main">${GRADE_LABEL[lead.verdict.grade] || lead.verdict.grade}</span>` +
      (group.jobs.length > 1 ? `<span class="g-sub">best of ${group.jobs.length}</span>` : '');
  } else {
    gradeChip.className = 'grade-chip g-pending';
    gradeChip.innerHTML = `<span class="g-main">Not read yet</span><span class="g-sub">kw ${lead.keywordScore}</span>`;
  }

  const bestCred = group.jobs.reduce((m, j) =>
    (j.credibility?.score ?? 0) > (m?.score ?? -1) ? j.credibility : m, null) || { grade: 'unclear' };
  const credChip = node.querySelector('.cred-chip');
  credChip.className = `cred-chip c-${bestCred.grade}`;
  credChip.textContent = CRED_LABEL[bestCred.grade] || bestCred.grade;
  credChip.title = (bestCred.reasons || []).map((r) => r.text).join('\n');

  const company = COMPANIES[group.key];
  node.querySelector('.co-name').textContent = company?.name || group.name;

  const badges = node.querySelector('.badges');
  if (coState === 'saved') badges.append(badge('saved', 'saved-badge'));
  if (group.jobs.some((j) => j.isNew)) badges.append(badge('new', 'new'));
  if (lead.isAgency) badges.append(badge('agency', 'agency'));
  const tier = lead.companyTier ?? company?.tier;
  if (tier) badges.append(badge(`tier ${tier}`, tier === 1 ? 'tier1' : ''));
  badges.append(badge(sourceLabel(lead.source)));

  const bestComp = Math.max(...group.jobs.map((j) => j.salaryEstimate?.totalMax ?? 0));
  node.querySelector('.co-meta').innerHTML = [
    `<span><b>${group.jobs.length}</b> ${group.jobs.length === 1 ? 'role' : 'roles'} here</span>`,
    `<span>${escapeHTML(lead.location || 'Singapore')}</span>`,
    bestComp ? `<span>up to ${money(bestComp)}</span>` : '',
  ].filter(Boolean).join('');

  // The employer analysis, written once and shared by every posting below.
  const box = node.querySelector('.assessment');
  const c = lead.verdict?.company;
  if (c?.brief) {
    box.innerHTML = [
      `<p class="a-why">${escapeHTML(c.brief)}</p>`,
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

  const briefBox = node.querySelector('.company-brief');
  if (company?.brief) {
    briefBox.innerHTML = [
      escapeHTML(company.brief),
      company.sgPresence ? `<br>Singapore: ${escapeHTML(company.sgPresence)}` : '',
      company.watchOuts ? `<br><span class="watch">注意：${escapeHTML(company.watchOuts)}</span>` : '',
    ].join('');
  } else {
    briefBox.remove();
  }

  // Reported compensation is a property of the employer, so it belongs here
  // rather than repeated on every posting. Levels.fyi asks for the link back.
  const compBox = node.querySelector('.reported-comp');
  const rc = group.jobs.find((j) => j.reportedComp?.medianTotal)?.reportedComp;
  if (rc) {
    const ladder = (rc.levels || []).filter((l) => l.total)
      .map((l) => `<span class="rung"><b>${escapeHTML(l.level)}</b> ${money(l.total)}</span>`).join('');
    compBox.innerHTML =
      `<div class="rc-head">Reported median <b>${money(rc.medianTotal)}</b> ` +
      `<span class="rc-note">software engineer, Singapore</span>` +
      `<a href="${escapeHTML(rc.url)}" target="_blank" rel="noopener noreferrer" class="rc-src">Levels.fyi</a></div>` +
      (ladder ? `<div class="rc-ladder">${ladder}</div>` : '');
  } else {
    compBox.remove();
  }

  // Company-level actions. Saving or dismissing here covers every posting at
  // once; the buttons inside each posting still act on that posting alone.
  const saveBtn = node.querySelector('.save');
  const dismissBtn = node.querySelector('.dismiss');
  saveBtn.textContent = coState === 'saved' ? 'Company saved' : 'Save company';
  saveBtn.classList.toggle('on', coState === 'saved');
  dismissBtn.textContent = coState === 'dismissed' ? 'Restore company' : 'Dismiss company';
  saveBtn.onclick = () => setState(coKey(group.key), 'saved');
  dismissBtn.onclick = () => setState(coKey(group.key), 'dismissed');

  // Glassdoor holds employer ratings but forbids automated access in its
  // robots.txt, so this is a deep link rather than a scraped number.
  node.querySelector('.glassdoor').href =
    `https://www.glassdoor.sg/Search/results.htm?keyword=${encodeURIComponent(company?.name || group.name)}`;

  // A saved company can have a hundred open roles. Render the best few and
  // put the rest behind a click rather than pouring them onto the page.
  const box2 = node.querySelector('.postings');
  const CAP = 6;
  const shown = group.jobs.slice(0, CAP);
  box2.replaceChildren(...shown.map((j) => postingCard(j, { view })));

  if (group.jobs.length > CAP) {
    const more = document.createElement('button');
    more.className = 'btn small ghost show-all';
    more.textContent = `Show all ${group.jobs.length} roles`;
    more.onclick = () => {
      box2.replaceChildren(...group.jobs.map((j) => postingCard(j, { view })));
    };
    box2.append(more);
  }
  return node;
}

/* ------------------------------------------------------------- posting --- */

function postingCard(job, { view }) {
  const node = el('postTpl').content.cloneNode(true);
  const root = node.querySelector('.post');
  const state = statusOf(job.id);
  if (state) root.classList.add(state);

  const g = node.querySelector('.post-grade');
  if (job.verdict) {
    g.className = `post-grade g-${job.verdict.grade}`;
    g.textContent = GRADE_LABEL[job.verdict.grade] || job.verdict.grade;
  } else {
    g.className = 'post-grade g-pending';
    g.textContent = `kw ${job.keywordScore}`;
  }

  const title = node.querySelector('.job-title');
  title.textContent = job.title;
  title.href = job.url;

  const badges = node.querySelector('.badges');
  if (state === 'applied') badges.append(badge(`applied ${JOB_STATE[job.id].at || ''}`.trim(), 'applied-badge'));
  if (state === 'saved') badges.append(badge('saved', 'saved-badge'));
  if (job.isNew) badges.append(badge('new', 'new'));

  node.querySelector('.job-meta').innerHTML = [
    job.postedAt ? `<span>posted ${timeAgo(job.postedAt)}</span>` : '',
    job.minYearsExperience != null ? `<span>${job.minYearsExperience}y+ required</span>` : '',
    job.applicants ? `<span>${job.applicants} applicants</span>` : '',
  ].filter(Boolean).join('');

  // One line on this requisition specifically; the employer read is above.
  const noteEl = node.querySelector('.post-note');
  if (job.verdict?.note) noteEl.textContent = job.verdict.note;
  else noteEl.remove();

  const s = job.salaryEstimate;
  const current = DATA.profileSnapshot?.currentTotalAnnual ?? 0;
  const trend = s.totalMax >= current * 1.1 ? 'up' : s.totalMax < current ? 'down' : '';
  node.querySelector('.salary').innerHTML = `
    <span class="amount ${trend}">${money(s.totalMin)} – ${money(s.totalMax)}</span>
    <span class="tag ${s.origin === 'posting' ? 'declared' : 'modelled'}">${s.origin === 'posting' ? 'declared' : 'estimated'}</span>
    <span class="note">${escapeHTML(s.note)}</span>`;

  const reasons = node.querySelector('.reasons');
  for (const r of (job.reasons || []).slice(0, job.verdict ? 2 : 4)) {
    const li = document.createElement('li');
    li.className = r.kind;
    li.textContent = r.text;
    reasons.append(li);
  }

  node.querySelector('.apply').href = job.url;
  const saveBtn = node.querySelector('.save');
  const appliedBtn = node.querySelector('.mark-applied');
  const dismissBtn = node.querySelector('.dismiss');

  saveBtn.textContent = state === 'saved' ? 'Saved' : 'Save';
  saveBtn.classList.toggle('on', state === 'saved');
  appliedBtn.classList.toggle('on', state === 'applied');
  dismissBtn.textContent = state === 'dismissed' ? 'Restore' : 'Dismiss';

  saveBtn.onclick = () => setState(job.id, 'saved');
  appliedBtn.onclick = () => setState(job.id, 'applied');
  dismissBtn.onclick = () => setState(job.id, 'dismissed');

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
  renderSyncBtn();     // local write is instant; the repo write is on request
}

/* -------------------------------------------------------- cross-device --- */

const syncCfg = () => {
  const c = store.get(LS.cfg, {}) || {};
  if (!c.repo || !c.token || c.sync === false) return null;
  return { repo: c.repo, token: c.token, branch: c.branch || 'main' };
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
    if (res.status === 404) { SYNC_SHA = null; syncStatus('no state file yet — press Save to create it'); return renderSyncBtn(); }
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
    renderSyncBtn();
    render();
  } catch (err) {
    syncStatus(`sync failed: ${err.message}`, 'bad');
  }
}

/**
 * Everything decided since the last successful write. Kept as a timestamp
 * rather than a flag so it survives a reload and can be counted, and so a pull
 * that brings in another device's edits does not mark them as ours to push.
 */
const lastSynced = () => store.get('jobdash.syncedAt', 0);

function pendingCount() {
  const since = lastSynced();
  const n = (o) => Object.values(o || {}).filter((v) => (typeof v === 'number' ? v : v.ts || 0) > since).length;
  return n(JOB_STATE) + n(TOMBSTONES);
}

function renderSyncBtn() {
  const btn = el('syncBtn');
  if (!btn) return;
  if (!syncCfg()) { btn.hidden = true; return; }
  const n = pendingCount();
  btn.hidden = false;
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? 'Synced' : `Save ${n} change${n === 1 ? '' : 's'}`;
  // .primary paints the label white, so the ghost outline has to come off with
  // it or the button reads as an empty box.
  btn.classList.toggle('primary', n > 0);
  btn.classList.toggle('ghost', n === 0);
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
    // Another device wrote first: take theirs, merge, and write the union.
    if (res.status === 409 || res.status === 422) { await pullState(); return pushState(); }
    if (res.status === 403) throw new Error('token lacks Contents:write on the state repo');
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    SYNC_SHA = (await res.json()).content.sha;
    store.set('jobdash.syncedAt', Date.now());
    syncStatus('synced', 'ok');
    renderSyncBtn();
  } catch (err) {
    syncStatus(`sync failed: ${err.message}`, 'bad');
  }
}

function renderCounts() {
  const jobs = DATA?.jobs || [];

  // Saved counts companies: saving Airwallex is one decision, not the 172 open
  // roles it drags in. Applied stays a posting count — you apply to a job, and
  // three applications at one employer are three things done, not one.
  const savedCompanies = new Set(
    jobs.filter((j) => statusOf(j.id) === 'saved' || coStatusOf(j.companyKey) === 'saved')
      .map((j) => j.companyKey),
  );
  el('nSaved').textContent = savedCompanies.size;
  el('nApplied').textContent = jobs.filter((j) => statusOf(j.id) === 'applied').length;
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
    sync: el('cfgSync').checked,
  });
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

const goToPage = (n) => {
  PAGE = n;
  render();
  el('list').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
el('syncBtn').onclick = async () => {
  const btn = el('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  await pushState();
  renderSyncBtn();
};

// A tab closed with decisions still only in localStorage is not lost, but it is
// invisible to the other device, which is the whole point of syncing.
window.addEventListener('beforeunload', (e) => {
  if (syncCfg() && pendingCount() > 0) { e.preventDefault(); e.returnValue = ''; }
});

el('pagePrev').onclick = () => goToPage(PAGE - 1);
el('pageNext').onclick = () => goToPage(PAGE + 1);

for (const tab of document.querySelectorAll('.view-tab')) {
  tab.onclick = () => {
    VIEW = tab.dataset.view;
    PAGE = 1;
    document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('on', t === tab));
    el('controls').hidden = VIEW !== 'all';   // filters only mean anything in All
    render();
  };
}

for (const id of ['q', 'minGrade', 'minCred', 'minComp', 'sortBy', 'hideAgency', 'declaredOnly', 'newOnly', 'showHidden']) {
  // Any change to the result set puts you back on page 1; staying on page 6 of
  // a list that just became two pages long is never what you meant.
  el(id).addEventListener('input', () => { PAGE = 1; render(); });
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
