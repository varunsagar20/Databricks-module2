# module2

## Top 5 Hacker News Stories

A small local web app that fetches the top 5 Hacker News stories (external
async data, via the official HN Firebase API) and, for each one, uses the
Gemini API to infer the industry it's most relevant to and generate a
2-sentence "Why this matters for [Industry]" summary.

### Setup

```bash
npm install
export GEMINI_API_KEY=your-api-key
npm start
```

Then open http://localhost:3000 in your browser.

### How it works

- `server.js` fetches the top 5 story IDs from `https://hacker-news.firebaseio.com/v0/topstories.json`,
  loads each story's details, and kicks off all 5 article-text fetches
  concurrently (independent websites, no shared rate limit). Gemini calls
  stay sequential — one in flight at a time, in the original ranking order —
  since running all 5 at once bursts past Gemini's rate limit; each story's
  article fetch has usually already finished in the background by the time
  its turn comes up, so the concurrent fetching hides most of that latency
  behind the Gemini calls instead of adding to it. Gemini (`gemini-flash-latest`)
  returns structured JSON output — an inferred `industry` and a 2-sentence
  relevance `summary` — per story. `/api/stories` streams each story as a
  line of NDJSON as soon as it's ready, instead of waiting for all 5 to
  finish and sending one big JSON array.
- `index.html` reads that stream and appends each story's card to the page
  the moment it arrives — title, points/author, comment count, a
  target-industry badge, and the relevance summary — with a live
  "Loaded N of 5 stories..." status while the rest are still in flight. If
  Gemini fails to generate a summary for a story, that story instead shows a
  clear "Gemini failed to generate a summary" message with a direct link to
  the article, so the page always degrades gracefully rather than showing a
  broken or missing summary.

No credentials are needed for the Hacker News API. You do need a
`GEMINI_API_KEY` (from Google AI Studio: https://aistudio.google.com/apikey)
for the summarization step. Set it as an environment variable — never commit
it or paste it into a file in this repo.
