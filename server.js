import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Type } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const STORY_COUNT = 5;
const HN_API = "https://hacker-news.firebaseio.com/v0";
const ARTICLE_FETCH_TIMEOUT_MS = 5000;
const ARTICLE_TEXT_MAX_CHARS = 500;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function fetchTopStories() {
  const idsRes = await fetch(`${HN_API}/topstories.json`);
  const ids = (await idsRes.json()).slice(0, STORY_COUNT);
  return Promise.all(
    ids.map((id) => fetch(`${HN_API}/item/${id}.json`).then((r) => r.json()))
  );
}

async function fetchArticleText(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[HN source] GET ${url} returned HTTP ${res.status} — using body anyway, it may not be real article text.`);
    }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, ARTICLE_TEXT_MAX_CHARS);
    console.log(`[HN source] Extracted ${text.length} chars from ${url}. Preview: ${JSON.stringify(text.slice(0, 200))}`);
    return text;
  } catch (err) {
    console.warn(`[HN source] Failed to fetch article at ${url}: ${err.name}: ${err.message}`);
    return null;
  }
}

const INDUSTRY_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    industry: {
      type: Type.STRING,
      description: "The single industry most relevant to this story, e.g. Healthcare, Finance, Retail, Manufacturing, Cybersecurity.",
    },
    summary: {
      type: Type.STRING,
      description: "Exactly two sentences explaining concretely why this story matters for that industry.",
    },
  },
  required: ["industry", "summary"],
};

async function analyzeStory(story, articleText) {
  console.log(`[HN source] Story ${story.id} "${story.title}" — url: ${story.url || "(none, self-post)"}`);

  const sourceText = articleText || story.text || "";
  const sourceKind = articleText ? "article" : story.text ? "HN self-post text" : "title only";
  console.log(`[HN source] Story ${story.id}: using ${sourceKind} as Gemini input (${sourceText.length} chars).`);

  const prompt = sourceText
    ? `Story title: "${story.title}"\n\nArticle content (may be partial or malformed):\n${sourceText}\n\nInfer the single industry most relevant to this story, and write exactly two sentences explaining concretely why this story matters for that industry.`
    : `Story title: "${story.title}"\n\nNo article content is available. From the title alone, infer the single industry most relevant to this story, and write exactly two sentences giving your best guess at why this story matters for that industry.`;
  console.log(`[Gemini] Story ${story.id}: sending ${prompt.length}-char prompt to model "${GEMINI_MODEL}".`);

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: INDUSTRY_RESPONSE_SCHEMA,
      },
    });
    console.log(`[Gemini] Story ${story.id}: received ${response.text?.length ?? 0}-char response.`);
    const parsed = JSON.parse(response.text);
    if (!parsed.industry || !parsed.summary) {
      throw new Error(`Gemini response was missing industry or summary. Raw response: ${response.text}`);
    }
    return { industry: parsed.industry, summary: parsed.summary, summaryFailed: false };
  } catch (err) {
    console.error(`[Gemini] Story ${story.id} FAILED — model: "${GEMINI_MODEL}", name: ${err.name}, status: ${err.status ?? "n/a"}, message: ${err.message}`);
    return { industry: null, summary: null, summaryFailed: true };
  }
}

async function streamStoriesWithSummaries(res) {
  // fetchTopStories() runs before headers are sent, so a failure here can
  // still produce a proper error status instead of a broken stream.
  const stories = await fetchTopStories();
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  // Kick off all 5 article fetches concurrently right away — they're 5
  // independent websites with no shared rate limit, so there's no reason
  // to fetch them one at a time. Each promise starts running immediately;
  // we don't await it here yet.
  const articleFetches = stories.map((story) =>
    story.url ? fetchArticleText(story.url) : Promise.resolve(null)
  );

  // Gemini calls stay sequential (one in flight at a time) — running all 5
  // at once was bursting past Gemini's rate limit — and stories are still
  // emitted in the original top-5 ranking order. By the time the loop
  // reaches story i, its article fetch has usually already finished in the
  // background while earlier stories' Gemini calls were running, so this
  // await is often instant instead of adding its own wait.
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    const articleText = await articleFetches[i];
    const { industry, summary, summaryFailed } = await analyzeStory(story, articleText);
    res.write(JSON.stringify({
      id: story.id,
      title: story.title,
      url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
      score: story.score,
      by: story.by,
      descendants: story.descendants || 0,
      industry,
      summary,
      summaryFailed,
    }) + "\n");
  }
  res.end();
}

const CONTENT_TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/stories") {
    try {
      await streamStoriesWithSummaries(res);
    } catch (err) {
      if (res.headersSent) {
        res.end();
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  const filePath = req.url === "/" ? "/index.html" : req.url;
  try {
    const data = await fs.readFile(path.join(__dirname, filePath));
    const contentType = CONTENT_TYPES[path.extname(filePath)] || "text/html";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
