# Speaking Loop

A voice-first Japanese conversation practice app for intermediate learners.

The learner chooses target vocabulary and grammar, then speaks with an AI tutor in Japanese. The tutor keeps the conversation natural while nudging toward useful practice opportunities. After the session, the app shows which targets were used, modelled, or missed.

## Stack

- React + Vite
- Tailwind CSS
- Vercel static frontend
- Vercel serverless function at `api/conversation.js`
- Shisa API for LLM, ASR, TTS, and translation

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local env file:

```bash
cp .env.example .env
```

Set your Shisa key:

```bash
SHISA_API_KEY=your_key_here
```

Run with Vercel dev so the API route is available:

```bash
npm run dev:vercel
```

Plain Vite only serves the frontend:

```bash
npm run dev
```

Use `npm run dev:vercel` for full voice/API testing.

## Build

```bash
npm run build
```

## CI / PR Workflow

GitHub Actions runs on pull requests and pushes to `master`.

```bash
npm run build
npm run test:e2e
```

The e2e suite uses Playwright with mocked Shisa API responses, mocked tutor
audio playback, and a mocked VAD. It does not require a real microphone or
`SHISA_API_KEY` in CI.

Use pull requests for changes. Agents should push branches and update PRs; a
human should review and merge. Vercel should create preview deployments for PR
branches and deploy production from `master`.

## Deploy

The project is configured for Vercel.

Add the production environment variable in Vercel:

```bash
SHISA_API_KEY=your_key_here
```

Deploy:

```bash
npx vercel deploy --prod
```

## Architecture

The browser owns session state and sends it to the serverless function on each turn.

```text
Browser
  -> /api/conversation
  -> Shisa ASR / LLM / TTS / Translation
  -> Browser
```

No database or user accounts are used.

The API supports:

- `action: "start"`: first tutor message
- `action: "turn"`: process one user utterance
- `action: "review"`: generate final review

## Notes

- The Shisa key must stay server-side. Do not expose it in frontend code.
- `.env`, `.vercel`, `dist`, and `node_modules` are intentionally ignored.
- The current implementation returns one JSON response per turn. It does not yet stream LLM/TTS audio sentence-by-sentence.
