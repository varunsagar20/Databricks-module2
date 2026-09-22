import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

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

async function summarizeStory(story) {
  const articleText = story.url ? await fetchArticleText(story.url) : null;
  const sourceText = articleText || story.text || "";

  const prompt = sourceText
    ? `Story title: "${story.title}"\n\nArticle content (may be partial or malformed):\n${sourceText}\n\nWrite a single concise 1-2 sentence summary of what this story is about, for someone deciding whether to click through.`
    : `Story title: "${story.title}"\n\nNo article content is available. Write a single concise sentence guessing what this story is about, based only on the title.`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });
    const text = response.text;
    return text ? text.trim() : "Summary unavailable.";
  } catch (err) {
    console.error(`Summary failed for story ${story.id}:`, err.message);
    return "Summary unavailable.";
  }
}

async function getStoriesWithSummaries() {
  const stories = await fetchTopStories();
  return Promise.all(
    stories.map(async (story) => ({
      id: story.id,
      title: story.title,
      url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
      score: story.score,
      by: story.by,
      descendants: story.descendants || 0,
      summary: await summarizeStory(story),
    }))
  );
}

const CONTENT_TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/stories") {
    try {
      const stories = await getStoriesWithSummaries();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stories));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
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
