import {
  getDebugMessages,
  json,
  requireDebugAdmin,
} from "./storage.js";

export default async function handler(req, res) {
  if (!requireDebugAdmin(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  try {
    const url = new URL(req.url, "http://localhost");
    const messages = await getDebugMessages({
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    return json(res, 200, { messages });
  } catch (error) {
    console.error("debug messages failed", error);
    return json(res, 500, { error: error.message || "Unexpected error." });
  }
}
