/**
 * briefing — on session start, generate a repo map + test map + git log
 * and inject it as dynamic context. Cached to .pi-harness/briefing.md;
 * regenerated when git HEAD moves.
 *
 * Shells out to scripts/briefing.py (the same self-contained script used
 * in the benchmark harness). Falls back to a git-log-only briefing if
 * Python is unavailable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

function loadConfig(cwd: string): Record<string, boolean> {
  const configPath = join(cwd, "pi-harness.config.json");
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  // Walk up to find it (package may be installed globally)
  const pkgConfig = join(dirname(__dirname), "pi-harness.config.json");
  if (existsSync(pkgConfig)) {
    return JSON.parse(readFileSync(pkgConfig, "utf-8"));
  }
  return {};
}

function currentHead(cwd: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function generateBriefing(cwd: string): string {
  // Try shelling out to the Python script first.
  const scriptPath = join(dirname(__dirname), "scripts", "briefing.py");
  if (existsSync(scriptPath)) {
    try {
      execSync(`python3 "${scriptPath}" "${cwd}"`, {
        cwd,
        timeout: 30_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const generated = join(cwd, "briefing.md");
      if (existsSync(generated)) {
        return readFileSync(generated, "utf-8");
      }
    } catch {
      // Python unavailable or script failed — fall through to git-only.
    }
  }

  // Fallback: git log only.
  let gitLog = "(no git history)";
  try {
    gitLog = execSync("git log --oneline -10", {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
  } catch {
    // Not a git repo or git unavailable.
  }

  return [
    "# briefing.md — pre-computed context\n",
    "Read this first. Go directly to editing.\n",
    "## Recent commits",
    gitLog,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.briefing === false) {
      return {};
    }

    const cacheDir = join(ctx.cwd, ".pi-harness");
    const cachePath = join(cacheDir, "briefing.md");
    const headPath = join(cacheDir, "briefing.head");

    const head = currentHead(ctx.cwd);

    // Check if cached briefing is still valid (HEAD hasn't moved).
    let briefing: string | null = null;
    if (existsSync(cachePath) && existsSync(headPath)) {
      const cachedHead = readFileSync(headPath, "utf-8").trim();
      if (cachedHead === head) {
        briefing = readFileSync(cachePath, "utf-8");
      }
    }

    // Regenerate if stale or missing.
    if (!briefing) {
      briefing = generateBriefing(ctx.cwd);
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }
      writeFileSync(cachePath, briefing);
      if (head) {
        writeFileSync(headPath, head);
      }
    }

    return {
      message: {
        customType: "pi-harness-briefing",
        content: briefing,
        display: false,
      },
    };
  });
}
