# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start server (production)
node server.js

# Start with auto-reload (development)
npm run dev

# Install dependencies
npm install
```

Server runs on `http://localhost:3000` (configurable via `PORT` in `.env`).

## Architecture

Single-file Node.js + Express backend with a vanilla JS/HTML/CSS frontend.

**Backend** (`server.js`):
- One API endpoint: `POST /api/chat` — accepts `{ messages: [] }` (Anthropic message format)
- Streams Claude responses via SSE (`text/event-stream`) using `@anthropic-ai/sdk` `messages.stream()`
- Special case: `messages.length === 0` returns a hard-coded greeting without calling the API (avoids Anthropic's requirement that the first message must be `user` role)
- System prompt is the `SYSTEM_PROMPT` constant (Alex persona, 3-phase interview structure, evaluation rubric)

**Frontend** (`public/`):
- `index.html` — app shell with sidebar (phase tracker), chat area, welcome screen, eval modal
- `app.js` — all client logic: SSE stream reader, `conversationHistory` state, phase tracking, eval card + modal
- `style.css` — dark theme with CSS variables

**Key invariant**: The hard-coded greeting is display-only and is never pushed to `conversationHistory`. Only real API responses (where `history.length > 0`) get added to history. This keeps the conversation array valid for the Anthropic API (must start with `user` role).

**Evaluation flow**: When Alex finishes the interview, the API response contains `<evaluation>...</evaluation>` XML. The client strips it from the bubble display, parses scores/verdict, renders an `eval-card` in chat, and shows the full report in a modal on click.

## Environment

Requires `.env` with:
```
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=3000
```
