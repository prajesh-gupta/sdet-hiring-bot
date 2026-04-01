// ── Auth ──────────────────────────────────────────────────────────────
let adminToken = localStorage.getItem('adminToken') || null;

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` };
}

// On load — check if already logged in
(async function init() {
  if (adminToken) {
    const ok = await checkAuth();
    if (ok) { showDashboard(); return; }
  }
  showLogin();
})();

async function checkAuth() {
  try {
    const res = await fetch('/api/admin/interviews', { headers: authHeaders() });
    return res.ok;
  } catch { return false; }
}

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashboard').style.display   = 'none';
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display   = 'flex';
  loadInterviews();
  loadCandidates();
}

// ── Login form ────────────────────────────────────────────────────────
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  btn.textContent = 'Signing in…';
  btn.disabled = true;
  err.style.display = 'none';

  try {
    const res  = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('loginUser').value,
        password: document.getElementById('loginPass').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    adminToken = data.token;
    localStorage.setItem('adminToken', adminToken);
    showDashboard();
  } catch (ex) {
    err.textContent   = ex.message;
    err.style.display = 'block';
  } finally {
    btn.textContent = 'Sign In';
    btn.disabled = false;
  }
});

// ── Logout ────────────────────────────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
  adminToken = null;
  localStorage.removeItem('adminToken');
  showLogin();
});

// ── Tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).style.display = 'block';
  });
});

// ── Load interviews ───────────────────────────────────────────────────
async function loadInterviews() {
  const container = document.getElementById('interviewsBody');
  try {
    const res  = await fetch('/api/admin/interviews', { headers: authHeaders() });
    if (!res.ok) { showLogin(); return; }
    const data = await res.json();
    document.getElementById('interviewCount').textContent = data.length;
    container.innerHTML = data.length === 0
      ? '<div class="empty-state">No interviews completed yet.</div>'
      : renderInterviewsTable(data);
  } catch {
    container.innerHTML = '<div class="empty-state">Failed to load interviews.</div>';
  }
}

function renderInterviewsTable(interviews) {
  const rows = interviews.map(iv => {
    const verdict    = iv.verdict || '—';
    const badgeCls   = verdictClass(verdict);
    const flags      = buildProctoringFlag(iv.proctoring);
    const date       = iv.completedAt ? new Date(iv.completedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    return `
      <tr class="clickable" onclick="openInterview('${iv.id}')">
        <td><strong>${esc(iv.candidateName)}</strong></td>
        <td class="muted">${esc(iv.candidateEmail || '—')}</td>
        <td class="muted">${date}</td>
        <td><span class="badge ${badgeCls}">${verdict}</span></td>
        <td>${iv.overallScore ? `<strong>${iv.overallScore}/5</strong>` : '—'}</td>
        <td class="muted">${esc(iv.level || '—')}</td>
        <td>${flags}</td>
      </tr>`;
  }).join('');

  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>Candidate</th><th>Email</th><th>Date</th>
          <th>Verdict</th><th>Score</th><th>Level</th><th>Proctoring</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildProctoringFlag(p) {
  if (!p) return '<span class="dimmed">—</span>';
  const flags = [];
  if (p.pasteCount >= 3) flags.push(`<span style="color:var(--red)">⚠ ${p.pasteCount} pastes</span>`);
  else if (p.pasteCount > 0) flags.push(`<span style="color:var(--yellow)">${p.pasteCount} paste${p.pasteCount > 1 ? 's' : ''}</span>`);
  if (p.avgWpm > 100) flags.push(`<span style="color:var(--red)">⚠ ${p.avgWpm} wpm</span>`);
  return flags.length ? flags.join(' · ') : '<span style="color:var(--green)">✓ Clean</span>';
}

// ── Interview detail modal ────────────────────────────────────────────
let allInterviews = [];

async function openInterview(id) {
  if (!allInterviews.length) {
    const res = await fetch('/api/admin/interviews', { headers: authHeaders() });
    allInterviews = await res.json();
  }
  const iv = allInterviews.find(i => i.id === id);
  if (!iv) return;

  document.getElementById('modalTitle').textContent = `${iv.candidateName} — ${iv.verdict || 'Evaluation'}`;
  document.getElementById('modalBody').textContent  = buildModalText(iv);
  document.getElementById('detailModal').style.display = 'flex';
}

function buildModalText(iv) {
  const date = iv.completedAt ? new Date(iv.completedAt).toLocaleString() : '—';
  const p    = iv.proctoring || {};
  return [
    `Candidate:  ${iv.candidateName}`,
    `Email:      ${iv.candidateEmail || '—'}`,
    `Date:       ${date}`,
    '',
    '=== PROCTORING ===',
    `Paste Events:      ${p.pasteCount ?? '—'}`,
    `Avg Think Time:    ${p.avgThinkSec != null ? p.avgThinkSec + 's' : '—'}`,
    `Avg Typing Speed:  ${p.avgWpm != null ? p.avgWpm + ' wpm' : '—'}`,
    `Total Responses:   ${p.totalResponses ?? '—'}`,
    (p.pasteCount >= 3 || p.avgWpm > 100) ? `\n⚠ FLAGS DETECTED` : `\n✓ No suspicious activity`,
    '',
    iv.evalReport || '(No eval report)',
  ].join('\n');
}

document.getElementById('closeModal').addEventListener('click', () => {
  document.getElementById('detailModal').style.display = 'none';
});
document.getElementById('detailModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('detailModal'))
    document.getElementById('detailModal').style.display = 'none';
});

// ── Load candidates ───────────────────────────────────────────────────
async function loadCandidates() {
  const container = document.getElementById('candidatesBody');
  try {
    const res  = await fetch('/api/admin/candidates', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('candidateCount').textContent = data.length;
    container.innerHTML = data.length === 0
      ? '<div class="empty-state">No candidates yet. Generate a link above.</div>'
      : renderCandidatesTable(data);
  } catch {
    container.innerHTML = '<div class="empty-state">Failed to load candidates.</div>';
  }
}

function renderCandidatesTable(candidates) {
  const rows = candidates.map(c => {
    const status = candidateStatus(c);
    const expStr = c.expiresAt
      ? new Date(c.expiresAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : (c.firstAccessAt ? '—' : `${c.ttlMinutes}m after access`);
    const del = c.completed ? '' :
      `<button class="btn-del" title="Delete" onclick="deleteCandidate('${c.token}', event)">✕</button>`;
    return `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="muted">${esc(c.email || '—')}</td>
        <td><span class="badge ${status.cls}">${status.label}</span></td>
        <td class="muted">${new Date(c.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
        <td class="muted">${expStr}</td>
        <td>
          <div class="link-cell">
            <span class="link-text" title="${esc(c.link)}">${esc(c.link)}</span>
            <button class="btn-copy" onclick="copyLink('${esc(c.link)}', this)">Copy</button>
            ${del}
          </div>
        </td>
      </tr>`;
  }).join('');

  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th><th>Email</th><th>Status</th>
          <th>Created</th><th>Expires</th><th>Link</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function candidateStatus(c) {
  if (c.completed)                              return { cls: 'badge-completed', label: 'Completed' };
  if (c.expiresAt && Date.now() > c.expiresAt) return { cls: 'badge-expired',   label: 'Expired'   };
  if (c.firstAccessAt)                          return { cls: 'badge-active',    label: 'In Progress' };
  return { cls: 'badge-pending', label: 'Pending' };
}

// ── Create candidate ──────────────────────────────────────────────────
document.getElementById('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('.create-btn');
  btn.textContent = 'Generating…';
  btn.disabled = true;

  try {
    const res  = await fetch('/api/admin/candidates', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name:       document.getElementById('cName').value,
        email:      document.getElementById('cEmail').value,
        ttlMinutes: document.getElementById('cTtl').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const box  = document.getElementById('newLink');
    const text = document.getElementById('newLinkText');
    text.textContent = data.link;
    box.style.display = 'flex';
    document.getElementById('copyNewLink').onclick = () => copyLink(data.link, document.getElementById('copyNewLink'));

    document.getElementById('cName').value  = '';
    document.getElementById('cEmail').value = '';
    loadCandidates();
  } catch (ex) {
    alert('Error: ' + ex.message);
  } finally {
    btn.textContent = 'Generate Link';
    btn.disabled = false;
  }
});

// ── Delete candidate ──────────────────────────────────────────────────
async function deleteCandidate(token, e) {
  e.stopPropagation();
  if (!confirm('Delete this candidate link?')) return;
  await fetch(`/api/admin/candidates/${token}`, { method: 'DELETE', headers: authHeaders() });
  loadCandidates();
}

// ── Copy to clipboard ─────────────────────────────────────────────────
function copyLink(link, btn) {
  navigator.clipboard.writeText(link).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function verdictClass(verdict) {
  const v = verdict.toLowerCase().replace(/\s+/g, '-');
  return `verdict-${v}`;
}
