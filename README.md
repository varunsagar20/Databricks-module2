# Databricks-module2

## Top 5 Hacker News Stories

A small local web app that fetches the top 5 Hacker News stories (external
async data, via the official HN Firebase API) and generates a short LLM
summary for each one using the Gemini API.

### Setup

```bash
npm install
export GEMINI_API_KEY=your-api-key
npm start
```

Then open http://localhost:3000 in your browser.

### How it works

- `server.js` fetches the top 5 story IDs from `https://hacker-news.firebaseio.com/v0/topstories.json`,
  loads each story's details, best-effort fetches the linked article text, and
  asks Gemini (`gemini-flash-latest`) to generate a 1-2 sentence summary of each story.
- `index.html` calls the local `/api/stories` endpoint and renders the titles,
  metadata, and summaries.

No credentials are needed for the Hacker News API. You do need a
`GEMINI_API_KEY` (from Google AI Studio: https://aistudio.google.com/apikey)
for the summarization step. Set it as an environment variable — never commit
it or paste it into a file in this repo.
