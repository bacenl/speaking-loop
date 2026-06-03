import {
  getDebugSummary,
  json,
  requireDebugAdmin,
} from "./storage.js";

export default async function handler(req, res) {
  if (!requireDebugAdmin(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  try {
    const summary = await getDebugSummary();
    return json(res, 200, summary);
  } catch (error) {
    console.error("debug summary failed", error);
    return json(res, 500, { error: error.message || "Unexpected error." });
  }
}
