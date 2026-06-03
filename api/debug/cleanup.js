import {
  cleanupDebugLogs,
  json,
  requireDebugAdmin,
} from "./storage.js";

export default async function handler(req, res) {
  if (!requireDebugAdmin(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  try {
    const result = await cleanupDebugLogs(30);
    return json(res, 200, result);
  } catch (error) {
    console.error("debug cleanup failed", error);
    return json(res, 500, { error: error.message || "Unexpected error." });
  }
}
