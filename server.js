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
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  } catch {
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

async function analyzeStory(story) {
  const articleText = story.url ? await fetchArticleText(story.url) : null;
  const sourceText = articleText || story.text || "";

  const prompt = sourceText
    ? `Story title: "${story.title}"\n\nArticle content (may be partial or malformed):\n${sourceText}\n\nInfer the single industry most relevant to this story, and write exactly two sentences explaining concretely why this story matters for that industry.`
    : `Story title: "${story.title}"\n\nNo article content is available. From the title alone, infer the single industry most relevant to this story, and write exactly two sentences giving your best guess at why this story matters for that industry.`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: INDUSTRY_RESPONSE_SCHEMA,
      },
    });
    const parsed = JSON.parse(response.text);
    if (!parsed.industry || !parsed.summary) {
      throw new Error("Gemini response was missing industry or summary");
    }
    return { industry: parsed.industry, summary: parsed.summary, summaryFailed: false };
  } catch (err) {
    console.error(`Analysis failed for story ${story.id}:`, err.message);
    return { industry: null, summary: null, summaryFailed: true };
  }
}

async function streamStoriesWithSummaries(res) {
  // fetchTopStories() runs before headers are sent, so a failure here can
  // still produce a proper error status instead of a broken stream.
  const stories = await fetchTopStories();
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  // Sequential, not Promise.all: analyzeStory() calls Gemini, and running all
  // 5 at once was bursting past the API's rate limit. Each story is written
  // to the response as soon as it's ready, so the page can render it
  // immediately instead of waiting for all 5 to finish.
  for (const story of stories) {
    const { industry, summary, summaryFailed } = await analyzeStory(story);
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
