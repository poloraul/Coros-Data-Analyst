#!/usr/bin/env node
/**
 * download-fit.js — 通过 MCP 获取 FIT 文件下载地址并下载
 *
 * 读取 daily JSON 中的 sportRecords，对每条跑步记录调用
 * coros-mcp 的 queryActivityFitFileDownloadUrls 工具获取下载 URL，
 * 保存到 data/fit/{labelId}.fit。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");
const FIT_DIR = path.join(PROJECT_ROOT, "data", "fit");
const TOKEN_FILE = path.join(process.env.HOME, ".coros-mcp-skill-gateway-ts", "cn", "token.json");
const ISSUER = "https://mcpcn.coros.com";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { date: null, all: false, force: false, labelId: null, check: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) parsed.date = args[++i];
    if (args[i] === "--all") parsed.all = true;
    if (args[i] === "--force") parsed.force = true;
    if (args[i] === "--labelId" && args[i + 1]) parsed.labelId = args[++i];
    if (args[i] === "--check") parsed.check = true;
  }
  return parsed;
}

function getDailyFiles() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(f => path.join(DATA_DIR, f));
}

function readDailyFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function collectActivities(dateStr) {
  const activities = [];

  if (dateStr) {
    const fp = path.join(DATA_DIR, `${dateStr}.json`);
    if (!existsSync(fp)) {
      console.error(`  [ERROR] Daily file not found: ${dateStr}.json`);
      process.exit(1);
    }
    const data = readDailyFile(fp);
    if (data?.sportRecords) {
      for (const r of data.sportRecords) {
        if (r.labelId && r.sportType != null) {
          activities.push({ labelId: r.labelId, sportType: String(r.sportType), sourceFile: fp });
        }
      }
    }
    return activities;
  }

  for (const fp of getDailyFiles()) {
    const data = readDailyFile(fp);
    if (data?.sportRecords) {
      for (const r of data.sportRecords) {
        if (r.labelId && r.sportType != null) {
          activities.push({ labelId: r.labelId, sportType: String(r.sportType), sourceFile: fp });
        }
      }
    }
  }
  return activities;
}

function deduplicate(activities) {
  const seen = new Set();
  const result = [];
  for (const a of activities) {
    const key = a.labelId;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(a);
    }
  }
  return result;
}

function updateDailyJson(sourceFile, labelId, tcxRelPath) {
  const data = readDailyFile(sourceFile);
  if (!data) return;
  const detail = data.activityDetails?.find(d => d.labelId === labelId);
  if (detail && !detail.tcxPath) {
    detail.tcxPath = tcxRelPath;
    writeFileSync(sourceFile, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ============================================================
// MCP 直连调用（与 fetch.js 的 directMcpCall 一致）
// ============================================================
async function mcpCall(toolName, args) {
  if (!existsSync(TOKEN_FILE)) {
    return { status: "error", labelId: "", error: `MCP token not found at ${TOKEN_FILE}` };
  }
  const tokenData = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  const mcpUrl = `${ISSUER}/mcp`;
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    Authorization: "Bearer " + tokenData.access_token,
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Initialize
      const initRes = await fetch(mcpUrl, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "download-fit", version: "1.0" } },
        }),
      });
      if (!initRes.ok) { console.error(`  [WARN] MCP init failed: ${initRes.status}`); continue; }
      await initRes.text();

      // Notify
      await fetch(mcpUrl, { method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });

      // Call tool
      const callRes = await fetch(mcpUrl, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });
      const text = await callRes.text();
      let json;
      try { json = JSON.parse(text); } catch { continue; }
      if (json.error) { console.error(`  [WARN] MCP error: ${json.error.message}`); continue; }
      return json.result;
    } catch (e) {
      if (attempt < 3) console.error(`  [WARN] MCP call failed, retrying (${attempt}/3): ${e.message}`);
      else return { error: e.message };
    }
  }
  return { error: "MCP call failed after 3 attempts" };
}

async function downloadFIT(activity, force) {
  const fitPath = path.join(FIT_DIR, `${activity.labelId}.fit`);

  if (!force && existsSync(fitPath)) {
    return { status: "skipped", labelId: activity.labelId };
  }

  const logPrefix = `  [${activity.labelId.slice(0, 6)}..]`;
  console.log(`${logPrefix} Getting FIT download URL via MCP...`);

  let result;
  try {
    result = await mcpCall("queryActivityFitFileDownloadUrls", {
      labelId: activity.labelId,
      sportType: parseInt(activity.sportType),
    });
  } catch (e) {
    return { status: "error", labelId: activity.labelId, error: `MCP call failed: ${e.message}` };
  }

  if (result.error) {
    return { status: "error", labelId: activity.labelId, error: result.error };
  }

  // Extract URL from MCP result (may be direct text or content array)
  let url = null;
  if (typeof result === "string") {
    url = result.trim();
  } else if (result.content?.[0]?.text) {
    url = result.content[0].text.trim();
  } else if (Array.isArray(result)) {
    url = result[0]?.url || result[0];
  }

  if (!url || url === "[]") {
    return { status: "error", labelId: activity.labelId, error: "no download URL returned" };
  }

  console.log(`${logPrefix} Downloading FIT...`);
  try {
    mkdirSync(FIT_DIR, { recursive: true });
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(fitPath, buf);
  } catch (e) {
    return { status: "error", labelId: activity.labelId, error: `download failed: ${e.message}` };
  }

  const relPath = path.relative(PROJECT_ROOT, fitPath);
  const size = existsSync(fitPath) ? ` (${(readFileSync(fitPath).length / 1024).toFixed(0)} KB)` : "";
  console.log(`${logPrefix} Downloaded to ${relPath}${size}`);
  return { status: "downloaded", labelId: activity.labelId, path: relPath };
}

// --- Main ---

async function main() {
  const args = parseArgs();

  if (!existsSync(DATA_DIR)) {
    console.error("No data directory found. Run fetch.js first.");
    process.exit(1);
  }

  mkdirSync(FIT_DIR, { recursive: true });

  console.log("Collecting activities...");
  let activities;
  if (args.labelId) {
    const sportType = "100";
    activities = [{ labelId: args.labelId, sportType, sourceFile: null }];
  } else if (args.date) {
    activities = collectActivities(args.date);
  } else if (args.all) {
    activities = collectActivities(null);
  } else {
    const files = getDailyFiles();
    const latest = files[files.length - 1];
    if (!latest) {
      console.error("No daily data files found.");
      process.exit(1);
    }
    const dateMatch = latest.match(/(\d{8})\.json$/);
    activities = collectActivities(dateMatch ? dateMatch[1] : null);
    if (dateMatch) console.log(`Target: ${dateMatch[1]}`);
  }

  const unique = deduplicate(activities);
  console.log(`  Found ${activities.length} records, ${unique.length} unique activities`);

  if (args.check) {
    console.log("\nActivities to process:");
    for (const a of unique) {
      const exists = existsSync(path.join(FIT_DIR, `${a.labelId}.fit`));
      console.log(`  ${a.labelId} (type: ${a.sportType}) ${exists ? "[already exists]" : ""}`);
    }
    console.log(`\nTotal: ${unique.length} activities`);
    return;
  }

  console.log(`\nDownloading FIT files via MCP...`);
  let downloaded = 0, skipped = 0, errors = 0;
  for (const activity of unique) {
    const result = await downloadFIT(activity, args.force);
    if (result.status === "downloaded") downloaded++;
    else if (result.status === "skipped") skipped++;
    else {
      errors++;
      if (result.error && !result.error.startsWith("no download URL")) {
        console.error(`  [ERROR] ${result.labelId}: ${result.error}`);
      }
    }
  }

  console.log(`\nDone. Downloaded: ${downloaded}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(e => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
