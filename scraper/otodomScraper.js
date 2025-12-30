import fetch from "node-fetch";
import { JSDOM } from "jsdom";

export default async function scrapeOtodom(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
    },
  });

  const html = await res.text();
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const text = document.body.textContent;

  const surfaceMatch = text.match(/Surface\s*(\d+)\s*m²/i);
  const roomsMatch = text.match(/Number of rooms\s*(\d+)/i);

  const title =
    document.querySelector("h1")?.textContent?.trim() || "Unknown title";

  return {
    title,
    surface: surfaceMatch ? Number(surfaceMatch[1]) : null,
    rooms: roomsMatch ? Number(roomsMatch[1]) : null,
  };
}
