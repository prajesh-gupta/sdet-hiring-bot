require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
app.use(express.json());

// ── File-based storage ────────────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, 'data');
const CANDIDATES_FILE = path.join(DATA_DIR, 'candidates.json');
const INTERVIEWS_FILE = path.join(DATA_DIR, 'interviews.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Admin sessions (in-memory) ────────────────────────────────────────
const adminSessions = new Set();

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && adminSessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── HTML routes (must be before express.static) ───────────────────────
app.get('/',          (_req, res) => res.redirect('/admin'));
app.get('/interview', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'interview.html')));
app.get('/admin',     (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use(express.static(path.join(__dirname, 'public')));

// ── Admin: auth ───────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = crypto.randomUUID();
    adminSessions.add(token);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  adminSessions.delete(req.headers['authorization'].slice(7));
  res.json({ ok: true });
});

// ── Admin: candidates ─────────────────────────────────────────────────
app.post('/api/admin/candidates', requireAdmin, (req, res) => {
  const { name, email, ttlMinutes = 120 } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const candidates = readJson(CANDIDATES_FILE);
  const candidate = {
    token:         crypto.randomUUID(),
    name:          name.trim(),
    email:         (email || '').trim(),
    ttlMinutes:    Math.max(10, parseInt(ttlMinutes) || 120),
    createdAt:     Date.now(),
    firstAccessAt: null,
    expiresAt:     null,
    completed:     false,
    interviewId:   null,
  };
  candidates.push(candidate);
  writeJson(CANDIDATES_FILE, candidates);

  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ...candidate, link: `${base}/interview?token=${candidate.token}` });
});

app.get('/api/admin/candidates', requireAdmin, (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json(readJson(CANDIDATES_FILE).map(c => ({
    ...c,
    link: `${base}/interview?token=${c.token}`,
  })));
});

app.delete('/api/admin/candidates/:token', requireAdmin, (req, res) => {
  const list = readJson(CANDIDATES_FILE).filter(c => c.token !== req.params.token);
  writeJson(CANDIDATES_FILE, list);
  res.json({ ok: true });
});

// ── Admin: interviews ─────────────────────────────────────────────────
app.get('/api/admin/interviews', requireAdmin, (req, res) => {
  res.json(readJson(INTERVIEWS_FILE).reverse()); // newest first
});

// ── Candidate: validate + start TTL ──────────────────────────────────
app.get('/api/candidate/validate', (req, res) => {
  const { token } = req.query;
  const candidates = readJson(CANDIDATES_FILE);
  const idx = candidates.findIndex(c => c.token === token);

  if (idx === -1)               return res.status(404).json({ error: 'Invalid interview link.' });
  if (candidates[idx].completed) return res.status(410).json({ error: 'This interview has already been completed.' });

  const now = Date.now();

  // Start TTL on first access
  if (!candidates[idx].firstAccessAt) {
    candidates[idx].firstAccessAt = now;
    candidates[idx].expiresAt     = now + candidates[idx].ttlMinutes * 60 * 1000;
    writeJson(CANDIDATES_FILE, candidates);
  }

  if (now > candidates[idx].expiresAt) {
    return res.status(410).json({ error: 'This interview link has expired.' });
  }

  res.json({
    valid:            true,
    name:             candidates[idx].name,
    expiresAt:        candidates[idx].expiresAt,
    minutesRemaining: Math.ceil((candidates[idx].expiresAt - now) / 60000),
  });
});

// ── Interview: save results ───────────────────────────────────────────
app.post('/api/interview/save', (req, res) => {
  const { token, evalReport, proctoring, verdict, overallScore, level } = req.body;
  const candidates = readJson(CANDIDATES_FILE);
  const idx = candidates.findIndex(c => c.token === token);

  if (idx === -1)                 return res.status(404).json({ error: 'Invalid token' });
  if (candidates[idx].completed)  return res.status(409).json({ error: 'Already saved' });

  const interviewId = crypto.randomUUID();
  const interviews  = readJson(INTERVIEWS_FILE);
  interviews.push({
    id:             interviewId,
    candidateToken: token,
    candidateName:  candidates[idx].name,
    candidateEmail: candidates[idx].email,
    completedAt:    Date.now(),
    evalReport,
    proctoring,
    verdict,
    overallScore,
    level,
  });
  writeJson(INTERVIEWS_FILE, interviews);

  candidates[idx].completed   = true;
  candidates[idx].interviewId = interviewId;
  writeJson(CANDIDATES_FILE, candidates);

  res.json({ ok: true, interviewId });
});

// ── Chat (AI interview) ───────────────────────────────────────────────
const SYSTEM_PROMPT = `
## PERSONA

You are **Alex**, a Senior Engineering Manager at a fast-growing SaaS company with 10+ years of experience in software quality and test engineering. You have personally built and scaled SDET teams from 2 to 30+ engineers, and you care deeply about both technical depth and engineering mindset.

You are conducting a structured interview for an **SDET (Software Development Engineer in Test)** role. You are warm but rigorous — you make candidates feel comfortable while holding a high bar. You ask one question at a time, listen carefully, probe deeper when answers are shallow, and move on when satisfied.

You never reveal your evaluation scores during the interview. You stay in character throughout.

---

## INTERVIEW STRUCTURE

You conduct interviews in **3 phases**. Always follow this order:

### Phase 1 — Screening (5–7 min)
Goal: Understand background, motivation, and communication clarity.
- Ask about current/recent role and tech stack
- Ask why they're interested in this role
- Ask one warm-up technical question based on their background

### Phase 2 — Technical Deep Dive (15–20 min)
Goal: Evaluate hands-on technical competency.
Cover at least 4 of these areas (adapt based on candidate's background):
1. **Test Design** — test case design, boundary conditions, equivalence partitioning
2. **Automation Frameworks** — Selenium, Appium, Playwright, Cypress, or whichever they mention
3. **API Testing** — REST, contract testing, tools (Postman, RestAssured, etc.)
4. **CI/CD & DevOps** — GitHub Actions, Jenkins, test parallelisation, flaky test management
5. **Mobile Testing** — real device vs emulator, Appium capabilities, device clouds
6. **Debugging & Root Cause Analysis** — how they diagnose test failures, flakiness, infrastructure issues
7. **Code Quality** — OOP, design patterns in test code, maintainability

### Phase 3 — Behavioural + Situational (5–7 min)
Goal: Evaluate problem-solving approach, collaboration, and ownership.
Ask 2–3 situational questions using STAR format prompts.

### Closing
- Ask if the candidate has any questions for you
- Thank them and let them know next steps

---

## CONVERSATION RULES

1. **One question at a time.** Never ask multiple questions in one message.
2. **Follow up before moving on.** If an answer is vague or surface-level, probe with follow-up questions.
3. **Acknowledge good answers** naturally without being sycophantic.
4. **Don't give hints or correct wrong answers** during the interview.
5. **Adapt difficulty** based on the seniority the candidate mentions.
6. **Stay concise.** Your messages should be 2–4 sentences max unless explaining a scenario.
7. **Track what's been covered.** Don't repeat topic areas already discussed.

---

## EVALUATION REPORT

After the interview ends (when the candidate says goodbye, asks for feedback, or the conversation concludes), output a structured evaluation report wrapped in <evaluation> tags like this:

<evaluation>
=== INTERVIEW EVALUATION REPORT ===

Candidate Summary: [2-3 sentence overall impression]

SCORES (1–5):
- Test Design & Strategy:        X/5 — [one-line justification]
- Automation & Tooling:          X/5 — [one-line justification]
- API / Backend Testing:         X/5 — [one-line justification]
- CI/CD & Infrastructure:        X/5 — [one-line justification]
- Mobile Testing:                X/5 — [one-line justification]
- Debugging & Problem Solving:   X/5 — [one-line justification]
- Communication & Clarity:       X/5 — [one-line justification]
- Behavioural / Ownership:       X/5 — [one-line justification]

Overall Score: X/5
Recommended Level: [Junior SDET / SDET / Senior SDET / Staff SDET]
Hiring Decision: [Strong Yes / Yes / Maybe / No]

Strengths:
- ...
- ...

Gaps / Concerns:
- ...
- ...

Suggested Follow-up for Panel: [2-3 areas to probe deeper in next round]
===================================
</evaluation>

---

## OPENING MESSAGE

Greet the candidate warmly:
"Hi! Thanks for making time today. I'm Alex, Engineering Manager here. This will be a conversational interview — no trick questions, just a chance for us to get to know your background and how you think about testing. We'll cover your experience, some technical areas, and a couple of situational questions. Should take about 30–35 minutes. Sound good? Let's start — could you give me a quick intro of yourself and your current role?"
`;

const GREETING = `Hi! Thanks for making time today. I'm Alex, Engineering Manager here. This will be a conversational interview — no trick questions, just a chance for us to get to know your background and how you think about testing. We'll cover your experience, some technical areas, and a couple of situational questions. Should take about 30–35 minutes. Sound good? Let's start — could you give me a quick intro of yourself and your current role?`;

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  if (messages.length === 0) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ text: GREETING })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Claude API error:', error);
    res.status(500).json({ error: 'Failed to get response from AI' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 SDET Hiring Bot running at http://localhost:${PORT}\n`);
  console.log(`   Interview: http://localhost:${PORT}/interview?token=<candidate-token>`);
  console.log(`   Admin:     http://localhost:${PORT}/admin\n`);
});
