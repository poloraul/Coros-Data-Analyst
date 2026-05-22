#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CorosApi, downloadFile, isDirectory, isFile } from "@nyt87/crs-connect";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "daily");
const TCX_DIR = path.join(PROJECT_ROOT, "data", "tcx");
const TOKEN_DIR = path.join(PROJECT_ROOT, "data", ".crs-token");
const ASIA_API_URL = "https://teamcnapi.coros.com";

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

function loadCredentials() {
  const envEmail = process.env.COROS_EMAIL;
  const envPass = process.env.COROS_PASSWORD;
  if (envEmail && envPass) return { email: envEmail, password: envPass };

  const configPath = path.join(PROJECT_ROOT, "coros.config.json");
  if (isFile(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }

  console.error("  [FATAL] No credentials found. Set COROS_EMAIL/COROS_PASSWORD or create coros.config.json");
  process.exit(1);
}

async function initClient() {
  const credentials = loadCredentials();
  const coros = new CorosApi(credentials);
  coros.config({ apiUrl: ASIA_API_URL });

  const tokenOk = isDirectory(TOKEN_DIR);
  if (tokenOk) {
    try {
      coros.loadTokenByFile(TOKEN_DIR);
      console.log("  Token loaded from cache");
    } catch {
      console.log("  No cached token, will login...");
    }
  }

  if (!coros._accessToken) {
    console.log("  Logging in...");
    try {
      await coros.login();
      mkdirSync(TOKEN_DIR, { recursive: true });
      coros.exportTokenToFile(TOKEN_DIR);
      console.log("  Login OK, token cached");
    } catch (e) {
      console.error(`  [FATAL] Login failed: ${e.message}`);
      process.exit(1);
    }
  }

  return coros;
}

async function fetchUrl(coros, activity, retried) {
  try {
    return await coros.getActivityDownloadFile({
      activityId: activity.labelId,
      fileType: "tcx",
      sportType: activity.sportType,
    });
  } catch (e) {
    if (!retried && e.message.includes("1019")) {
      console.log(`  Token expired, re-logging in...`);
      await coros.login();
      mkdirSync(TOKEN_DIR, { recursive: true });
      coros.exportTokenToFile(TOKEN_DIR);
      return fetchUrl(coros, activity, true);
    }
    throw e;
  }
}

async function downloadTcx(coros, activity, force) {
  const tcxPath = path.join(TCX_DIR, `${activity.labelId}.tcx`);

  if (!force && existsSync(tcxPath)) {
    return { status: "skipped", labelId: activity.labelId };
  }

  const logPrefix = `  [${activity.labelId.slice(0, 6)}..]`;
  console.log(`${logPrefix} Fetching download URL...`);

  let url;
  try {
    url = await fetchUrl(coros, activity, false);
  } catch (e) {
    return { status: "error", labelId: activity.labelId, error: `get URL failed: ${e.message}` };
  }

  if (!url) {
    return { status: "error", labelId: activity.labelId, error: "empty URL" };
  }

  console.log(`${logPrefix} Downloading...`);
  try {
    mkdirSync(TCX_DIR, { recursive: true });
    await downloadFile({ filePath: tcxPath, fileUrl: url });
  } catch (e) {
    return { status: "error", labelId: activity.labelId, error: `download failed: ${e.message}` };
  }

  const relPath = path.relative(PROJECT_ROOT, tcxPath);
  updateDailyJson(activity.sourceFile, activity.labelId, relPath);

  const size = existsSync(tcxPath) ? ` (${(readFileSync(tcxPath).length / 1024).toFixed(0)} KB)` : "";
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

  mkdirSync(TCX_DIR, { recursive: true });

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
      const exists = existsSync(path.join(TCX_DIR, `${a.labelId}.tcx`));
      console.log(`  ${a.labelId} (type: ${a.sportType}) ${exists ? "[already exists]" : ""}`);
    }
    console.log(`\nTotal: ${unique.length} activities`);
    return;
  }

  console.log("\nInitializing Coros client...");
  const coros = await initClient();

  let downloaded = 0, skipped = 0, errors = 0;
  for (const activity of unique) {
    const result = await downloadTcx(coros, activity, args.force);
    if (result.status === "downloaded") downloaded++;
    else if (result.status === "skipped") skipped++;
    else {
      errors++;
      console.error(`  [ERROR] ${result.labelId}: ${result.error}`);
    }
  }

  console.log(`\nDone. Downloaded: ${downloaded}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(e => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
