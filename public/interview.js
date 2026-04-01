const messagesEl   = document.getElementById('messages');
const userInput    = document.getElementById('userInput');
const sendBtn      = document.getElementById('sendBtn');
const inputArea    = document.getElementById('inputArea');
const startBtn     = document.getElementById('startBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalClose   = document.getElementById('modalClose');
const evalContent  = document.getElementById('evalContent');

let conversationHistory = [];
let isLoading = false;
let rawEvalReport = '';

// ── Proctoring state ──────────────────────────────────────────────────
let proctoringLog = { pasteEvents: [], responseTimes: [] };
let alexStreamEndTime = null;
let firstKeystrokeTime = null;
let userMsgCount = 0;

// ── Candidate token state ─────────────────────────────────────────────
let candidateToken = null;
let candidateExpiresAt = null;
let ttlInterval = null;
let ttlTotalMs = null;

// ── Init: validate token on page load ────────────────────────────────
(async function initInterview() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');

  if (!token) {
    showTokenError('No Interview Link', 'Please use the link provided to you by the hiring team.');
    return;
  }

  try {
    const res  = await fetch(`/api/candidate/validate?token=${encodeURIComponent(token)}`);
    const data = await res.json();

    if (!res.ok) {
      showTokenError(res.status === 410 ? 'Link Expired or Used' : 'Invalid Link', data.error);
      return;
    }

    candidateToken    = token;
    candidateExpiresAt = data.expiresAt;
    ttlTotalMs         = data.expiresAt - Date.now();

    // Personalise welcome screen
    document.getElementById('welcomeHeading').textContent =
      `Hi ${data.name} — Ready for your SDET Interview?`;

    // Show TTL panel
    document.getElementById('ttlPanel').style.display = 'flex';
    startTtlCountdown(data.expiresAt);

    // Show welcome screen
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('welcomeScreen').style.display  = 'flex';

    // Activate phase tracker
    document.getElementById('phase-1').classList.remove('active');

  } catch {
    showTokenError('Connection Error', 'Could not reach the server. Please try again.');
  }
})();

function showTokenError(title, msg) {
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('errorScreen').style.display   = 'flex';
  document.getElementById('errorTitle').textContent      = title;
  document.getElementById('errorMsg').textContent        = msg;
}

function startTtlCountdown(expiresAt) {
  const bar   = document.getElementById('ttlBar');
  const value = document.getElementById('ttlValue');

  function tick() {
    const remaining = Math.max(0, expiresAt - Date.now());
    const mins      = Math.floor(remaining / 60000);
    const secs      = Math.floor((remaining % 60000) / 1000);
    const pct       = ttlTotalMs > 0 ? (remaining / ttlTotalMs) * 100 : 0;

    value.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const warn   = remaining < 10 * 60 * 1000;  // < 10 min
    const urgent = remaining < 5  * 60 * 1000;  // < 5 min

    value.className = 'ttl-value' + (urgent ? ' ttl-urgent' : warn ? ' ttl-warn' : '');
    bar.style.width = pct + '%';
    bar.className   = 'ttl-bar'  + (urgent ? ' ttl-urgent' : warn ? ' ttl-warn' : '');

    if (remaining === 0) {
      clearInterval(ttlInterval);
      expireSession();
    }
  }

  tick();
  ttlInterval = setInterval(tick, 1000);
}

function expireSession() {
  userInput.disabled  = true;
  sendBtn.disabled    = true;
  appendMessage('alex', '⏱ Your interview time has expired. The session has been closed.');
}

// ── Phase tracking keywords ──────────────────────────────────────────
const phaseKeywords = {
  2: ['technical', 'framework', 'automation', 'test design', 'api', 'ci/cd', 'mobile', 'debugging', 'selenium', 'appium', 'playwright'],
  3: ['tell me about a time', 'behavioural', 'situational', 'describe a situation', 'how have you handled'],
  4: ['evaluation', 'overall score', 'hiring decision', 'strengths:', 'gaps'],
};

function updatePhase(text) {
  const lower = text.toLowerCase();
  let detected = 1;
  for (const [phase, keywords] of Object.entries(phaseKeywords)) {
    if (keywords.some(k => lower.includes(k))) detected = Math.max(detected, parseInt(phase));
  }
  document.querySelectorAll('.phase-item').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i + 1 < detected) el.classList.add('done');
    if (i + 1 === detected) el.classList.add('active');
  });
}

// ── Textarea auto-resize + first-keystroke tracking ──────────────────
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
  sendBtn.disabled = !userInput.value.trim();
  if (firstKeystrokeTime === null && !isLoading && alexStreamEndTime !== null) {
    firstKeystrokeTime = Date.now();
  }
});

// ── Paste detection ───────────────────────────────────────────────────
userInput.addEventListener('paste', (e) => {
  const pastedText = e.clipboardData?.getData('text') || '';
  proctoringLog.pasteEvents.push({ msgIndex: userMsgCount, chars: pastedText.length });
  updateProctoringPanel();
});

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled && !isLoading) sendMessage();
  }
});

// ── Start interview ───────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  document.getElementById('welcomeScreen').style.display = 'none';
  inputArea.style.display = 'block';
  document.getElementById('phase-1').classList.add('active');
  await getAIResponse([]);
});

// ── Send message ──────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);

function sendMessage() {
  const text = userInput.value.trim();
  if (!text || isLoading) return;

  // ── Record latency fingerprint for this message ───────────────────
  const submitTime = Date.now();
  const thinkingMs = alexStreamEndTime !== null ? Math.max(0, submitTime - alexStreamEndTime) : null;
  const typingMs   = firstKeystrokeTime !== null ? Math.max(0, submitTime - firstKeystrokeTime) : null;
  const wpm        = (typingMs && typingMs > 0 && text.length) ? Math.round((text.length / 5) / (typingMs / 60000)) : null;
  proctoringLog.responseTimes.push({ msgIndex: userMsgCount, thinkingMs, typingMs, chars: text.length, wpm });
  userMsgCount++;
  firstKeystrokeTime = null;
  updateProctoringPanel();

  appendMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });

  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled = true;

  getAIResponse(conversationHistory);
}

// ── Append message bubble ─────────────────────────────────────────────
function appendMessage(role, text) {
  const isAlex = role === 'alex';
  const wrapper = document.createElement('div');
  wrapper.className = `message ${isAlex ? 'alex' : 'user'}`;

  const avatarLetter = isAlex ? 'A' : 'Y';
  const avatarClass  = isAlex ? 'msg-avatar' : 'msg-avatar user-avatar';
  const senderName   = isAlex ? 'Alex' : 'You';

  wrapper.innerHTML = `
    <div class="${avatarClass}">${avatarLetter}</div>
    <div class="msg-content">
      <div class="msg-sender">${senderName}</div>
      <div class="msg-bubble">${escapeHtml(text)}</div>
    </div>
  `;
  messagesEl.appendChild(wrapper);
  scrollToBottom();
  return wrapper.querySelector('.msg-bubble');
}

// ── Typing indicator ──────────────────────────────────────────────────
function showTyping() {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = 'typingIndicator';
  el.innerHTML = `
    <div class="msg-avatar">A</div>
    <div class="typing-bubble">
      <span></span><span></span><span></span>
    </div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function hideTyping() {
  document.getElementById('typingIndicator')?.remove();
}

// ── Get AI response (streaming) ───────────────────────────────────────
async function getAIResponse(history) {
  isLoading = true;
  sendBtn.disabled = true;
  showTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });

    if (!res.ok) throw new Error('API error');

    hideTyping();

    // Create bubble — hidden until first token arrives
    const wrapper = document.createElement('div');
    wrapper.className = 'message alex';
    wrapper.style.display = 'none';
    wrapper.innerHTML = `
      <div class="msg-avatar">A</div>
      <div class="msg-content">
        <div class="msg-sender">Alex</div>
        <div class="msg-bubble"></div>
      </div>
    `;
    messagesEl.appendChild(wrapper);
    const bubble = wrapper.querySelector('.msg-bubble');
    let bubbleVisible = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              fullText += parsed.text;
              if (!bubbleVisible) { wrapper.style.display = 'flex'; bubbleVisible = true; }
              bubble.textContent = fullText.replace(/<evaluation>[\s\S]*?<\/evaluation>/g, '').trim();
              scrollToBottom();
            }
          } catch {}
        }
      }
    }

    // Record when Alex finished responding (user can now start thinking/typing)
    alexStreamEndTime = Date.now();

    // Check for evaluation report
    const evalMatch = fullText.match(/<evaluation>([\s\S]*?)<\/evaluation>/);
    if (evalMatch) {
      rawEvalReport = evalMatch[1].trim();
      bubble.textContent = fullText.replace(/<evaluation>[\s\S]*?<\/evaluation>/g, '').trim() || 'Thank you for your time today. Here is your evaluation report.';
      renderEvalCard(rawEvalReport);
      updatePhase('evaluation overall score hiring decision strengths gaps');
      clearInterval(ttlInterval); // stop countdown when interview completes
      await saveInterviewResults();
    } else if (history.length > 0) {
      // Only add to history for real API responses (not the hard-coded greeting)
      // First message must always be user role — greeting is display-only
      conversationHistory.push({ role: 'assistant', content: fullText });
      updatePhase(fullText);
    }

    scrollToBottom();

  } catch (err) {
    hideTyping();
    appendMessage('alex', 'Sorry, something went wrong. Please try again.');
    console.error(err);
  } finally {
    isLoading = false;
    sendBtn.disabled = !userInput.value.trim();
    userInput.focus();
  }
}

// ── Render evaluation card ────────────────────────────────────────────
function renderEvalCard(report) {
  const scores = parseScores(report);
  const verdict = parseVerdict(report);
  const level = parseLevel(report);
  const overall = parseOverall(report);

  const card = document.createElement('div');
  card.className = 'eval-card';
  card.innerHTML = `
    <div class="eval-card-header">📋 Interview Evaluation Report</div>
    <div class="eval-scores">
      ${scores.map(s => `
        <div class="eval-score-item">
          <span class="score-label">${s.label}</span>
          <span class="score-value score-${s.score}">${s.score}/5</span>
        </div>
      `).join('')}
    </div>
    <div class="eval-verdict">
      <span style="color: var(--text-muted); font-size:12px;">Overall: <strong style="color:var(--text)">${overall}/5</strong> · ${level}</span>
      <span class="verdict-badge verdict-${verdict.toLowerCase().replace(' ','-')}">${verdict}</span>
    </div>
    <div class="eval-hint">Click to view full report</div>
  `;
  card.addEventListener('click', () => openModal());
  messagesEl.appendChild(card);
  scrollToBottom();
}

function parseScores(report) {
  const labels = ['Test Design', 'Automation', 'API Testing', 'CI/CD', 'Mobile Testing', 'Debugging', 'Communication', 'Behavioural'];
  const matches = [...report.matchAll(/:\s+(\d)\/5/g)];
  return labels.map((label, i) => ({
    label,
    score: matches[i] ? parseInt(matches[i][1]) : 0,
  }));
}

function parseVerdict(report) {
  const m = report.match(/Hiring Decision:\s*\[?(Strong Yes|Yes|Maybe|No)\]?/i);
  return m ? m[1] : 'Pending';
}

function parseLevel(report) {
  const m = report.match(/Recommended Level:\s*\[?([^\n\]]+)\]?/i);
  return m ? m[1].trim() : '';
}

function parseOverall(report) {
  const m = report.match(/Overall Score:\s*(\d)\/5/i);
  return m ? m[1] : '—';
}

// ── Modal ─────────────────────────────────────────────────────────────
function openModal() {
  evalContent.textContent = buildProctoringReport() + '\n' + rawEvalReport;
  modalOverlay.style.display = 'flex';
}

modalClose.addEventListener('click', () => modalOverlay.style.display = 'none');
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) modalOverlay.style.display = 'none';
});

// ── Save results ─────────────────────────────────────────────────────
async function saveInterviewResults() {
  if (!candidateToken) return;
  try {
    const pasteCount = proctoringLog.pasteEvents.length;
    const times  = proctoringLog.responseTimes.filter(r => r.thinkingMs !== null);
    const speeds = proctoringLog.responseTimes.filter(r => r.wpm !== null);
    const avgThinkSec = times.length  ? Math.round(times.reduce((a, b)  => a + b.thinkingMs, 0) / times.length / 1000) : null;
    const avgWpm      = speeds.length ? Math.round(speeds.reduce((a, b) => a + b.wpm, 0)        / speeds.length)       : null;

    await fetch('/api/interview/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token:        candidateToken,
        evalReport:   rawEvalReport,
        proctoring:   { pasteCount, avgThinkSec, avgWpm, totalResponses: userMsgCount, log: proctoringLog.responseTimes },
        verdict:      parseVerdict(rawEvalReport),
        overallScore: parseOverall(rawEvalReport),
        level:        parseLevel(rawEvalReport),
      }),
    });
  } catch (err) {
    console.error('Failed to save interview results:', err);
  }
}

// ── Proctoring ────────────────────────────────────────────────────────
function updateProctoringPanel() {
  const pasteCount = proctoringLog.pasteEvents.length;
  const times  = proctoringLog.responseTimes.filter(r => r.thinkingMs !== null);
  const speeds = proctoringLog.responseTimes.filter(r => r.wpm !== null);
  const avgThink = times.length  ? Math.round(times.reduce((a, b)  => a + b.thinkingMs, 0) / times.length / 1000) : null;
  const avgWpm   = speeds.length ? Math.round(speeds.reduce((a, b) => a + b.wpm, 0)        / speeds.length)       : null;

  // Paste stat
  const pasteEl = document.getElementById('statPaste');
  pasteEl.textContent = pasteCount;
  pasteEl.className = 'proctor-value' + (pasteCount >= 3 ? ' val-red' : pasteCount >= 1 ? ' val-yellow' : '');

  // Think time stat
  document.getElementById('statAvgThink').textContent = avgThink !== null ? `${avgThink}s` : '—';

  // Typing speed stat
  const speedEl = document.getElementById('statAvgSpeed');
  speedEl.textContent = avgWpm !== null ? `${avgWpm} wpm` : '—';
  speedEl.className = 'proctor-value' + (avgWpm > 100 ? ' val-red' : avgWpm > 40 ? ' val-green' : '');

  // Badge
  const badge = document.getElementById('proctorBadge');
  const suspicious = pasteCount >= 3 || (avgWpm !== null && avgWpm > 100);
  const warned     = pasteCount >= 1;
  if (suspicious) {
    badge.textContent = '⚠ Suspicious';
    badge.className = 'proctor-badge badge-red';
  } else if (warned) {
    badge.textContent = `⚠ ${pasteCount} paste${pasteCount > 1 ? 's' : ''}`;
    badge.className = 'proctor-badge badge-yellow';
  } else {
    badge.className = 'proctor-badge';
  }
}

function buildProctoringReport() {
  const pasteCount = proctoringLog.pasteEvents.length;
  const times  = proctoringLog.responseTimes.filter(r => r.thinkingMs !== null);
  const speeds = proctoringLog.responseTimes.filter(r => r.wpm !== null);
  const avgThink = times.length  ? Math.round(times.reduce((a, b)  => a + b.thinkingMs, 0) / times.length / 1000) : null;
  const avgWpm   = speeds.length ? Math.round(speeds.reduce((a, b) => a + b.wpm, 0)        / speeds.length)       : null;

  const flags = [];
  if (pasteCount >= 3) flags.push(`High paste activity (${pasteCount} paste events)`);
  else if (pasteCount > 0) flags.push(`Paste activity detected (${pasteCount} event${pasteCount > 1 ? 's' : ''})`);
  if (avgWpm !== null && avgWpm > 100) flags.push(`Unusually high typing speed (${avgWpm} wpm avg — possible copy-paste)`);

  const lines = [
    '=== PROCTORING REPORT ===',
    `Paste Events:       ${pasteCount}`,
    `Avg Thinking Time:  ${avgThink !== null ? avgThink + 's per response' : 'N/A'}`,
    `Avg Typing Speed:   ${avgWpm   !== null ? avgWpm   + ' wpm'          : 'N/A'}`,
    `Total Responses:    ${userMsgCount}`,
    '',
    flags.length
      ? '⚠ FLAGS:\n' + flags.map(f => `  - ${f}`).join('\n')
      : '✓ No suspicious activity detected',
    '=========================',
    '',
  ];
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
