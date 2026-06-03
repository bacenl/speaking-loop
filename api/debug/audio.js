import {
  getAudioByKey,
  json,
  requireDebugAdmin,
} from "./storage.js";

export default async function handler(req, res) {
  if (!requireDebugAdmin(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  try {
    const url = new URL(req.url, "http://localhost");
    const key = url.searchParams.get("key");
    if (!key) return json(res, 400, { error: "Missing key." });
    const audio = await getAudioByKey(key);
    if (!audio?.blob_url) return json(res, 404, { error: "Audio not found." });

    const response = await fetch(audio.blob_url);
    if (!response.ok) {
      return json(res, response.status, { error: "Could not fetch audio." });
    }
    const arrayBuffer = await response.arrayBuffer();
    res.statusCode = 200;
    res.setHeader("Content-Type", audio.mime_type || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.end(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error("debug audio failed", error);
    return json(res, 500, { error: error.message || "Unexpected error." });
  }
}
