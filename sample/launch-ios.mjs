#!/usr/bin/env node
/**
 * LLM Sample — iOS Launcher
 *
 * Builds and launches the sample app on an iOS Simulator or physical
 * device for interactive use. No tests are run — the app starts in
 * normal mode with the download screen (or cached-model flow).
 *
 * Prerequisites:
 *   - macOS with Xcode + at least one iPhone simulator installed
 *
 * Usage:
 *   node launch-ios.mjs [--verbose] [--open-simulator] [--clean]
 *
 * Flags:
 *   --clean           Wipe cached model from the simulator before launch
 *   --open-simulator  Open the Simulator.app window
 *   --verbose         Show full build output
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const VERBOSE = process.argv.includes("--verbose");
const OPEN_SIMULATOR = process.argv.includes("--open-simulator");
const CLEAN = process.argv.includes("--clean");

// ─── Config ───────────────────────────────────────────────────────────────────
const BUNDLE_ID = "io.t6x.llmchat.sample";
const IOS_MIN_VERSION = "17";

// ─── Logging ──────────────────────────────────────────────────────────────────
function logSection(title) {
  console.log(
    `\n${"═".repeat(60)}\n  ${title}\n${"═".repeat(60)}`,
  );
}

// ─── simctl helpers ───────────────────────────────────────────────────────────
function simctl(args, opts = {}) {
  return execSync(`xcrun simctl ${args}`, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function getBootedUDID() {
  const json = simctl("list devices booted -j");
  const data = JSON.parse(json);
  for (const devices of Object.values(data.devices)) {
    for (const d of devices) {
      if (d.state === "Booted") return d.udid;
    }
  }
  return null;
}

function findAvailableIPhone() {
  const json = simctl("list devices available -j");
  const data = JSON.parse(json);
  for (const [runtime, devices] of Object.entries(data.devices)) {
    if (!runtime.includes("iOS")) continue;
    for (const d of devices) {
      if (d.name.includes("iPhone") && d.isAvailable) return d.udid;
    }
  }
  return null;
}

function bootSimulator(udid) {
  console.log(`  → Booting simulator ${udid}...`);
  simctl(`boot ${udid}`);

  if (OPEN_SIMULATOR) {
    try {
      execSync("open -a Simulator", { stdio: "ignore" });
    } catch (e) {}
  }

  for (let i = 0; i < 30; i++) {
    const booted = getBootedUDID();
    if (booted) return booted;
    execSync("sleep 1");
  }
  throw new Error("Simulator failed to boot within 30s");
}

// ─── Xcode version helper ────────────────────────────────────────────────────
function getXcodeMajorVersion() {
  try {
    const out = execSync("xcodebuild -version", { encoding: "utf8" });
    const m = out.match(/Xcode (\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

// ─── Shell helper ────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  const nodePath = execSync("which node", { encoding: "utf8" }).trim();
  const result = execSync(cmd, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(nodePath)}:${process.env.PATH}`,
    },
    ...opts,
  });
  return (result || "").trim();
}

function npx(args, opts = {}) {
  const npmPath = execSync("which npm", { encoding: "utf8" }).trim();
  const npxPath = path.join(path.dirname(npmPath), "npx");
  return run(`${npxPath} ${args}`, opts);
}

// ─── auto-signing helper ──────────────────────────────────────────────────────
function getDeveloperTeamId() {
  if (process.env.DEVELOPMENT_TEAM) return process.env.DEVELOPMENT_TEAM;
  try {
    const out = execSync(
      "defaults read com.apple.dt.Xcode IDEProvisioningTeamManagerLastSelectedTeamID",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (out && out.length === 10) return out;
  } catch (e) {}
  try {
    const out = execSync("security find-identity -v -p codesigning", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out.split("\n");
    let fallback = null;
    for (const line of lines) {
      if (line.includes("Apple Development")) {
        const match = line.match(/\(([A-Z0-9]{10})\)/);
        if (match) {
          fallback = fallback || match[1];
          if (!line.includes("@")) return match[1];
        }
      }
    }
    return fallback;
  } catch (e) {}
  return null;
}

function getConnectedDevice() {
  try {
    execSync("xcrun devicectl list devices -j /tmp/devices.json", {
      stdio: "ignore",
    });
    const data = JSON.parse(fs.readFileSync("/tmp/devices.json", "utf8"));
    if (data && data.result && data.result.devices) {
      for (const hw of data.result.devices) {
        const props = hw.hardwareProperties || {};
        const st = hw.connectionProperties || {};
        if (props.platform === "iOS" && st.tunnelState === "connected") {
          return {
            udid: props.udid,
            name: hw.deviceProperties.name || props.marketingName,
          };
        }
      }
    }
  } catch (e) {}
  return null;
}

// ─── Project setup (idempotent) ──────────────────────────────────────────────
function ensureIosPlatform() {
  const iosDir = path.join(__dirname, "ios");
  if (fs.existsSync(iosDir)) return;
  console.log("  → cap add ios...");
  npx("cap add ios", {
    cwd: __dirname,
    stdio: VERBOSE ? [0, 1, 2] : ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function fixDeploymentTarget() {
  const pbxproj = path.join(
    __dirname,
    "ios/App/App.xcodeproj/project.pbxproj",
  );
  const teamId = getDeveloperTeamId();
  if (fs.existsSync(pbxproj)) {
    let content = fs.readFileSync(pbxproj, "utf8");
    const re = /IPHONEOS_DEPLOYMENT_TARGET = \d+\.\d+/g;
    if (!content.match(re)?.[0]?.includes(`= ${IOS_MIN_VERSION}.0`)) {
      content = content.replace(
        re,
        `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_MIN_VERSION}.0`,
      );
    }
    if (teamId) {
      if (
        content.includes("DEVELOPMENT_TEAM = ") &&
        !content.includes('DEVELOPMENT_TEAM = "";')
      ) {
        if (process.env.DEVELOPMENT_TEAM) {
          content = content.replace(
            /DEVELOPMENT_TEAM = [A-Z0-9]+;/g,
            `DEVELOPMENT_TEAM = ${teamId};`,
          );
        }
      } else {
        if (content.includes('DEVELOPMENT_TEAM = "";')) {
          content = content.replace(
            /DEVELOPMENT_TEAM = "";/g,
            `DEVELOPMENT_TEAM = ${teamId};`,
          );
        } else {
          content = content.replace(
            /PRODUCT_BUNDLE_IDENTIFIER = io\.t6x\.llmchat\.sample;/g,
            `PRODUCT_BUNDLE_IDENTIFIER = io.t6x.llmchat.sample;\n\t\t\t\tDEVELOPMENT_TEAM = ${teamId};`,
          );
        }
      }
    }
    fs.writeFileSync(pbxproj, content);
  }
  const capSpm = path.join(__dirname, "ios/App/CapApp-SPM/Package.swift");
  if (fs.existsSync(capSpm)) {
    let content = fs.readFileSync(capSpm, "utf8");
    content = content.replace(
      /\.iOS\(\.v\d+\)/,
      `.iOS(.v${IOS_MIN_VERSION})`,
    );
    fs.writeFileSync(capSpm, content);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("\n🔵 LLM Sample — iOS Launcher\n");

  // ─── Section 0: Project Setup ──────────────────────────────────────────
  logSection("0 — Project Setup");

  try {
    ensureIosPlatform();
    fixDeploymentTarget();
    console.log("  ✅ iOS platform ready");
  } catch (err) {
    console.error("  ❌ iOS platform setup failed:", err.message);
    process.exit(1);
  }

  // ─── Section 1: Device Setup ──────────────────────────────────────────
  logSection("1 — Device Setup");

  let udid;
  let isPhysical = false;
  const connectedDevice = getConnectedDevice();

  try {
    if (connectedDevice) {
      udid = connectedDevice.udid;
      isPhysical = true;
      console.log(
        `  ✅ Physical device: ${connectedDevice.name} (${udid})`,
      );
    } else {
      udid = getBootedUDID();
      if (!udid) {
        const available = findAvailableIPhone();
        if (!available)
          throw new Error(
            "No available iPhone simulator — install one via Xcode",
          );
        udid = bootSimulator(available);
      } else if (OPEN_SIMULATOR) {
        try {
          execSync("open -a Simulator", { stdio: "ignore" });
        } catch (e) {}
      }
      console.log(`  ✅ Simulator ready: ${udid}`);
    }
  } catch (err) {
    console.error("  ❌ No device or simulator available:", err.message);
    process.exit(1);
  }

  // ─── Section 2: Build & Install ──────────────────────────────────────
  logSection("2 — Build & Install");

  // cap sync
  try {
    console.log("  → cap sync ios...");
    npx("cap sync ios", {
      cwd: __dirname,
      timeout: 60000,
      stdio: VERBOSE ? [0, 1, 2] : ["ignore", "pipe", "pipe"],
    });
    fixDeploymentTarget();
    console.log("  ✅ cap sync ios");
  } catch (err) {
    try {
      execSync(
        `cp -r "${path.join(__dirname, "www")}/." "${path.join(__dirname, "ios/App/App/public")}/"`,
      );
      console.log("  ✅ web assets copied (manual)");
    } catch (e2) {
      console.error("  ❌ web assets:", e2.message);
      process.exit(1);
    }
  }

  // Build
  try {
    console.log("  → Building (xcodebuild)…");
    const xcodeMajor = getXcodeMajorVersion();
    const explicitModulesFlag =
      xcodeMajor >= 26 ? " SWIFT_ENABLE_EXPLICIT_MODULES=NO" : "";
    const targetSdk = isPhysical ? "iphoneos" : "iphonesimulator";
    const deviceDestination = isPhysical
      ? `id=${udid}`
      : `platform=iOS Simulator,id=${udid}`;

    const derivedDataPath = path.join(__dirname, "ios/App/DerivedData");
    const sharedOpts = {
      cwd: path.join(__dirname, "ios/App"),
      encoding: "utf8",
      timeout: 1200_000,
      maxBuffer: 200 * 1024 * 1024,
      stdio: VERBOSE ? [0, 1, 2] : ["ignore", "pipe", "pipe"],
    };
    const baseFlags =
      `-scheme App -sdk ${targetSdk} -destination "${deviceDestination}" -derivedDataPath "${derivedDataPath}"` +
      (isPhysical ? " -allowProvisioningUpdates" : "");

    // Resolve SPM
    console.log("  → Resolving SPM dependencies…");
    try {
      execSync(
        `xcodebuild ${baseFlags} -resolvePackageDependencies`,
        sharedOpts,
      );
    } catch (_resolveErr) {}

    // Init llama.cpp submodule
    const checkoutsDir = path.join(
      derivedDataPath,
      "SourcePackages/checkouts",
    );
    try {
      if (fs.existsSync(checkoutsDir)) {
        const entries = fs.readdirSync(checkoutsDir);
        const dustLlmDir = entries.find((e) =>
          e.startsWith("dust-llm-swift"),
        );
        if (dustLlmDir) {
          const dustLlmPath = path.join(checkoutsDir, dustLlmDir);
          console.log("  → Initializing llama.cpp submodule…");
          execSync("git submodule update --init --recursive", {
            cwd: dustLlmPath,
            encoding: "utf8",
            timeout: 300_000,
            stdio: VERBOSE ? [0, 1, 2] : ["ignore", "pipe", "pipe"],
          });
        }
      }
    } catch (_subErr) {}

    // Build
    execSync(
      `xcodebuild ${baseFlags} -configuration Debug build${explicitModulesFlag}`,
      sharedOpts,
    );
    console.log("  ✅ Build succeeded");
  } catch (err) {
    const output = err.stdout || err.stderr || err.message || "";
    const lines = output.split("\n");
    const errorLines = lines
      .filter((l) => /error:|FAILED/.test(l))
      .slice(0, 5)
      .join(" | ");
    console.error(
      "  ❌ Build failed:",
      errorLines || "re-run with --verbose for details",
    );
    process.exit(1);
  }

  // Install
  try {
    const fixedDerivedData = path.join(__dirname, "ios/App/DerivedData");
    const ddOut = execSync(
      `find "${fixedDerivedData}" ~/Library/Developer/Xcode/DerivedData -name "App.app" -path "*Debug-${isPhysical ? "iphoneos" : "iphonesimulator"}*" -not -path "*PlugIns*" -exec stat -f '%m %N' {} \\; 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-`,
      { encoding: "utf8", shell: true },
    ).trim();
    if (!ddOut) throw new Error("App.app not found in DerivedData");

    if (isPhysical) {
      execSync(
        `xcrun devicectl device install app --device ${udid} "${ddOut}"`,
        { stdio: "ignore" },
      );
    } else {
      try {
        simctl(`terminate ${udid} ${BUNDLE_ID}`);
      } catch {}
      simctl(`install ${udid} "${ddOut}"`);
    }
    console.log("  ✅ App installed");
  } catch (err) {
    console.error("  ❌ Install failed:", err.message);
    process.exit(1);
  }

  // ─── Clean cached models (optional) ──────────────────────────────────
  if (CLEAN) {
    logSection("2b — Clean Model Cache");
    try {
      if (isPhysical) {
        console.log("  → Cleaning model cache on device...");
        // Cannot easily delete files from physical device containers;
        // uninstall + reinstall is the cleanest approach
        try {
          execSync(
            `xcrun devicectl device uninstall app --device ${udid} ${BUNDLE_ID}`,
            { stdio: "ignore" },
          );
        } catch {}
        // Re-install
        const fixedDD = path.join(__dirname, "ios/App/DerivedData");
        const ddOut2 = execSync(
          `find "${fixedDD}" -name "App.app" -path "*Debug-iphoneos*" -not -path "*PlugIns*" -exec stat -f '%m %N' {} \\; 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-`,
          { encoding: "utf8", shell: true },
        ).trim();
        if (ddOut2) {
          execSync(
            `xcrun devicectl device install app --device ${udid} "${ddOut2}"`,
            { stdio: "ignore" },
          );
        }
        console.log("  ✅ Device app data wiped (reinstalled)");
      } else {
        const dataDir = simctl(
          `get_app_container ${udid} ${BUNDLE_ID} data`,
        );
        const docsDir = path.join(dataDir, "Documents");
        if (fs.existsSync(docsDir)) {
          const files = fs.readdirSync(docsDir);
          let cleaned = 0;
          for (const f of files) {
            if (f.endsWith(".gguf") || f.endsWith("-8bit") || f.endsWith("-4bit")) {
              const fp = path.join(docsDir, f);
              const stat = fs.statSync(fp);
              if (stat.isDirectory()) {
                fs.rmSync(fp, { recursive: true });
              } else {
                fs.unlinkSync(fp);
              }
              cleaned++;
              console.log(`  → Removed ${f}`);
            }
          }
          if (cleaned === 0) {
            console.log("  → No cached models found");
          }
        }
        console.log("  ✅ Model cache cleaned");
      }
    } catch (err) {
      console.warn("  ⚠️  Clean failed (non-fatal):", err.message);
    }
  }

  // ─── Section 3: Launch ─────────────────────────────────────────────────
  logSection("3 — Launch");

  try {
    if (isPhysical) {
      execSync(
        `xcrun devicectl device process launch --device ${udid} ${BUNDLE_ID}`,
        { stdio: "ignore" },
      );
    } else {
      try {
        simctl(`terminate ${udid} ${BUNDLE_ID}`);
      } catch {}
      simctl(`launch ${udid} ${BUNDLE_ID}`);
    }
    console.log("  ✅ App launched — enjoy!");
    console.log(
      `\n  The app is running on ${isPhysical ? "your device" : "the simulator"}.`,
    );
    console.log(
      "  The download screen will appear — click to download or load.\n",
    );
  } catch (err) {
    console.error("  ❌ Launch failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
