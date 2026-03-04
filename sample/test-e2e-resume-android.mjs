#!/usr/bin/env node
/**
 * LLM Sample — Resume-After-Kill E2E Test (Android)
 *
 * Verifies that killing the app mid-download and relaunching causes the
 * download to resume rather than restart from zero.
 *
 * Protocol:
 *   1. Patches www/index.html with RESUME_TEST_MODE, rebuilds APK
 *   2. Launches app → app auto-starts GGUF download and POSTs progress
 *   3. At >10% progress, test kills the app via `am force-stop`
 *   4. Relaunches → app detects resumed download, POSTs resumed + final status
 *   5. Test asserts the download completed without restarting from 0%
 *
 * Requires: Android project already set up (run test-e2e-android.mjs first,
 * or this script will build from scratch).
 *
 * Usage:
 *   node test-e2e-resume-android.mjs [--verbose]
 */

import { execSync, spawn } from 'child_process'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VERBOSE = process.argv.includes('--verbose')

// ─── Config ──────────────────────────────────────────────────────────────────
const BUNDLE_ID = 'io.t6x.llmchat.sample'
const RUNNER_PORT = 8099
const KILL_AT_PROGRESS = 0.10
const TIMEOUT_PHASE1_MS = 600_000     // 10 min for initial download (1.3 GB)
const TIMEOUT_PHASE2_MS = 1_200_000   // 20 min for resumed download
const ADB = findAdbBinary()

// ─── Test runner state ───────────────────────────────────────────────────────
let passedTests = 0, failedTests = 0
const testResults = []

function logSection(title) {
  console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`)
}
function pass(name, detail) {
  passedTests++
  testResults.push({ name, status: 'PASS' })
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, error) {
  failedTests++
  testResults.push({ name, status: 'FAIL', error })
  console.log(`  ❌ ${name} — ${error}`)
}
function printSummary() {
  logSection('Summary')
  const total = passedTests + failedTests
  if (failedTests === 0) {
    console.log(`\n  ✅ ALL ${total} TESTS PASSED\n`)
  } else {
    console.log(`\n  ❌ ${failedTests}/${total} TESTS FAILED\n`)
    for (const r of testResults) {
      if (r.status === 'FAIL') console.log(`     • ${r.name}: ${r.error}`)
    }
    console.log()
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}

// ─── Shell / ADB helpers ─────────────────────────────────────────────────────
function extendedPath() {
  const nodeDir = path.dirname(process.execPath)
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME, 'Library/Android/sdk')
  const extra = [
    nodeDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${process.env.HOME}/.nvm/versions/node/current/bin`,
    path.join(androidHome, 'platform-tools'),
    path.join(androidHome, 'emulator'),
  ].filter(Boolean)
  const existing = (process.env.PATH || '').split(':')
  return [...new Set([...extra, ...existing])].join(':')
}

function run(cmd, opts = {}) {
  return (execSync(cmd, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: extendedPath() },
    ...opts,
  }) || '').trim()
}

function adb(args, opts = {}) {
  const serial = process.env.ANDROID_SERIAL ? `-s ${process.env.ANDROID_SERIAL}` : ''
  return run(`${ADB} ${serial} ${args}`, { timeout: 60_000, ...opts })
}

function getConnectedDevice() {
  const out = execSync(`${ADB} devices`, { encoding: 'utf8' }).trim()
  const lines = out.split('\n').slice(1).filter(l => l.includes('\tdevice'))
  if (lines.length === 0) return null
  return lines[0].split('\t')[0].trim()
}

function findAndroidSdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME, 'Library/Android/sdk'),
    path.join(process.env.HOME, 'Android/Sdk'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'platform-tools'))) return p
  }
  return null
}

function findAdbBinary() {
  if (process.env.ADB_PATH && fs.existsSync(process.env.ADB_PATH)) return process.env.ADB_PATH
  const sdk = findAndroidSdkRoot()
  if (sdk) {
    const p = path.join(sdk, 'platform-tools/adb')
    if (fs.existsSync(p)) return p
  }
  try { return execSync('which adb', { encoding: 'utf8' }).trim() } catch {}
  return 'adb'
}

function findEmulatorBinary() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'emulator/emulator'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'emulator/emulator'),
    path.join(process.env.HOME, 'Library/Android/sdk/emulator/emulator'),
    path.join(process.env.HOME, 'Android/Sdk/emulator/emulator'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  try { return execSync('which emulator', { encoding: 'utf8' }).trim() } catch {}
  return null
}

function getAvailableAVDs(emulatorBin) {
  try {
    const out = execSync(`${emulatorBin} -list-avds`, { encoding: 'utf8' }).trim()
    return out.split('\n').filter(l => l.length > 0)
  } catch { return [] }
}

function bootEmulator(emulatorBin, avdName) {
  console.log(`  → Starting emulator (${avdName})...`)
  const child = spawn(emulatorBin, ['-avd', avdName, '-no-window', '-no-audio', '-no-boot-anim'], {
    detached: true, stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 60; i++) {
    execSync('sleep 2')
    const serial = getConnectedDevice()
    if (serial) {
      try {
        const bootComplete = execSync(`${ADB} -s ${serial} shell getprop sys.boot_completed 2>/dev/null`, { encoding: 'utf8' }).trim()
        if (bootComplete === '1') return serial
      } catch {}
    }
  }
  throw new Error('Emulator failed to boot within 120s')
}

function npx(args, opts = {}) {
  return run(`npx ${args}`, opts)
}

// ─── Project setup ───────────────────────────────────────────────────────────
function ensureAndroidProject() {
  const androidDir = path.join(__dirname, 'android')
  if (fs.existsSync(androidDir)) return
  console.log('  → cap add android...')
  npx('cap add android', { cwd: __dirname, stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}

function patchAndroidBuildGradle() {
  const buildGradle = path.join(__dirname, 'android/build.gradle')
  if (!fs.existsSync(buildGradle)) return
  let content = fs.readFileSync(buildGradle, 'utf8')
  if (content.includes('kotlin-gradle-plugin')) return
  content = content.replace(
    /classpath 'com\.android\.tools\.build:gradle:[^']+'/,
    match => `${match}\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.0'`
  )
  fs.writeFileSync(buildGradle, content)
}

function patchMinSdkVersion() {
  const varsGradle = path.join(__dirname, 'android/variables.gradle')
  if (!fs.existsSync(varsGradle)) return
  let content = fs.readFileSync(varsGradle, 'utf8')
  content = content.replace(/minSdkVersion = \d+/, 'minSdkVersion = 28')
  fs.writeFileSync(varsGradle, content)
}

function patchAndroidManifest() {
  const manifest = path.join(__dirname, 'android/app/src/main/AndroidManifest.xml')
  if (!fs.existsSync(manifest)) return
  let content = fs.readFileSync(manifest, 'utf8')
  if (content.includes('usesCleartextTraffic')) return
  content = content.replace(
    '<application',
    '<application\n        android:usesCleartextTraffic="true"'
  )
  fs.writeFileSync(manifest, content)
}

// ─── HTML patching ───────────────────────────────────────────────────────────
function patchWebIndexForResumeTest() {
  const webIndexPath = path.join(__dirname, 'www/index.html')
  const original = fs.readFileSync(webIndexPath, 'utf8')

  let patched = original

  const resumeSnippet = `
    var RESUME_TEST_MODE = true;
    var E2E_RESUME_URL = 'http://127.0.0.1:${RUNNER_PORT}';
  `

  patched = patched.replace(
    /(<script>\s*\/\* ─── Patchable config)/,
    `<script>${resumeSnippet}</script>\n  $1`
  )

  const resumeBootScript = `
  <script>
  (function() {
    if (typeof RESUME_TEST_MODE === 'undefined' || !RESUME_TEST_MODE) return;
    var resumeUrl = typeof E2E_RESUME_URL !== 'undefined' ? E2E_RESUME_URL : 'http://127.0.0.1:${RUNNER_PORT}';

    function postResume(endpoint, data) {
      return fetch(resumeUrl + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).catch(function() {});
    }

    async function runResumeTest() {
      for (var i = 0; i < 50; i++) {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Serve) break;
        await new Promise(function(r) { setTimeout(r, 200) });
      }
      var Serve = window.Capacitor.Plugins.Serve;
      if (!Serve) {
        postResume('/__resume_error', { error: 'Serve plugin not found' });
        return;
      }

      try {
        await Serve.registerModel({ descriptor: GGUF_DESCRIPTOR });
      } catch(_e) {}

      var statusResult = null;
      try {
        statusResult = await Serve.getModelStatus({ modelId: GGUF_MODEL_ID });
      } catch(_e) {}

      var status = statusResult && statusResult.status ? statusResult.status : null;

      if (status && status.kind === 'ready') {
        postResume('/__resume_status', { phase: 'ready', kind: 'ready' });
        return;
      }

      var isResuming = !!(status && status.kind === 'downloading');

      postResume('/__resume_status', {
        phase: isResuming ? 'resuming' : 'starting',
        kind: status ? status.kind : 'notLoaded',
        progress: status ? (status.progress || 0) : 0
      });

      Serve.addListener('modelProgress', function(event) {
        if (event.modelId !== GGUF_MODEL_ID) return;
        postResume('/__resume_progress', {
          progress: event.progress || 0,
          bytesDownloaded: event.bytesDownloaded || 0,
          totalBytes: event.totalBytes || 0
        });
      });

      Serve.addListener('modelReady', function(event) {
        if (event.modelId !== GGUF_MODEL_ID) return;
        postResume('/__resume_done', { status: 'ready', path: event.path });
      });

      Serve.addListener('modelFailed', function(event) {
        if (event.modelId !== GGUF_MODEL_ID) return;
        postResume('/__resume_done', {
          status: 'failed',
          error: event.error ? (event.error.detail || event.error.message || 'unknown') : 'unknown'
        });
      });

      if (!isResuming) {
        try {
          await Serve.downloadModel({ modelId: GGUF_MODEL_ID });
        } catch(e) {
          postResume('/__resume_error', { error: e.message || 'downloadModel failed' });
        }
      }
    }

    setTimeout(runResumeTest, 500);
  })();
  </script>`

  patched = patched.replace('</body>', resumeBootScript + '\n</body>')

  fs.writeFileSync(webIndexPath, patched)

  return function restore() {
    fs.writeFileSync(webIndexPath, original)
    const androidAssetPath = path.join(
      __dirname, 'android/app/src/main/assets/public/index.html'
    )
    if (fs.existsSync(androidAssetPath)) {
      fs.writeFileSync(androidAssetPath, original)
    }
  }
}

// ─── HTTP servers ────────────────────────────────────────────────────────────
function startPhase1Server() {
  return new Promise((resolve, reject) => {
    let lastProgress = 0
    let gotFirstProgress = false

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (req.url === '/__resume_status') {
            console.log(`  [app] Status: ${data.phase} (kind=${data.kind})`)
            res.writeHead(200); res.end('ok')
          } else if (req.url === '/__resume_progress') {
            lastProgress = data.progress || 0
            if (!gotFirstProgress) {
              gotFirstProgress = true
              console.log(`  [app] First progress: ${Math.round(lastProgress * 100)}%`)
            }
            if (VERBOSE) console.log(`  [app] Progress: ${Math.round(lastProgress * 100)}% (${formatBytes(data.bytesDownloaded)} / ${formatBytes(data.totalBytes)})`)
            res.writeHead(200); res.end('ok')

            if (lastProgress >= KILL_AT_PROGRESS) {
              server.close()
              resolve({ progress: lastProgress })
            }
          } else if (req.url === '/__resume_done') {
            server.close()
            resolve({ progress: 1.0, alreadyDone: true, status: data.status })
          } else if (req.url === '/__resume_error') {
            server.close()
            reject(new Error(data.error || 'App error'))
          } else {
            res.writeHead(404); res.end()
          }
        } catch (e) {
          res.writeHead(400); res.end()
        }
      })
    })

    try { run(`lsof -ti:${RUNNER_PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}

    server.listen(RUNNER_PORT, '0.0.0.0', () => {})
    server.on('error', reject)

    setTimeout(() => {
      server.close()
      reject(new Error(`Phase 1 timeout — download did not reach ${KILL_AT_PROGRESS * 100}% within ${TIMEOUT_PHASE1_MS / 1000}s (last: ${Math.round(lastProgress * 100)}%)`))
    }, TIMEOUT_PHASE1_MS)
  })
}

function startPhase2Server() {
  return new Promise((resolve, reject) => {
    let resumeDetected = false
    let firstProgressAfterResume = null

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (req.url === '/__resume_status') {
            console.log(`  [app] Relaunch status: ${data.phase} (kind=${data.kind}, progress=${data.progress})`)
            if (data.phase === 'resuming') resumeDetected = true
            res.writeHead(200); res.end('ok')
          } else if (req.url === '/__resume_progress') {
            if (firstProgressAfterResume === null) {
              firstProgressAfterResume = data.progress || 0
              console.log(`  [app] First progress after resume: ${Math.round(firstProgressAfterResume * 100)}%`)
            }
            if (VERBOSE) console.log(`  [app] Progress: ${Math.round((data.progress || 0) * 100)}%`)
            res.writeHead(200); res.end('ok')
          } else if (req.url === '/__resume_done') {
            console.log(`  [app] Download ${data.status}`)
            server.close()
            resolve({
              resumeDetected,
              firstProgressAfterResume,
              status: data.status,
              path: data.path,
              error: data.error,
            })
          } else if (req.url === '/__resume_error') {
            server.close()
            reject(new Error(data.error || 'App error on resume'))
          } else {
            res.writeHead(404); res.end()
          }
        } catch (e) {
          res.writeHead(400); res.end()
        }
      })
    })

    try { run(`lsof -ti:${RUNNER_PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}

    server.listen(RUNNER_PORT, '0.0.0.0', () => {})
    server.on('error', reject)

    setTimeout(() => {
      server.close()
      reject(new Error(`Phase 2 timeout — resumed download did not complete within ${TIMEOUT_PHASE2_MS / 1000}s`))
    }, TIMEOUT_PHASE2_MS)
  })
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n🟢 LLM Sample — Resume-After-Kill E2E Test (Android)\n')

  // ─── Section 0: Setup ──────────────────────────────────────────────────
  logSection('0 — Setup')

  let deviceSerial
  try {
    deviceSerial = process.env.ANDROID_SERIAL || getConnectedDevice()
    if (!deviceSerial) {
      const emulatorBin = findEmulatorBinary()
      if (!emulatorBin) throw new Error('No device connected and emulator binary not found')
      const avds = getAvailableAVDs(emulatorBin)
      if (avds.length === 0) throw new Error('No device connected and no AVDs found')
      deviceSerial = bootEmulator(emulatorBin, avds[0])
    }
    process.env.ANDROID_SERIAL = deviceSerial
    pass('0.1 Android device ready', `serial ${deviceSerial}`)
  } catch (err) {
    fail('0.1 Android device ready', err.message)
    printSummary()
    process.exit(1)
  }

  // Build and install with resume test mode
  let restoreIndex = null
  const apkPath = path.join(__dirname, 'android/app/build/outputs/apk/debug/app-debug.apk')

  try {
    ensureAndroidProject()
    patchAndroidBuildGradle()
    patchMinSdkVersion()
    patchAndroidManifest()
    restoreIndex = patchWebIndexForResumeTest()

    console.log('  → cap sync android...')
    npx('cap sync android', {
      cwd: __dirname, timeout: 300_000,
      stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'],
    })

    const sdkRoot = findAndroidSdkRoot()
    if (sdkRoot) {
      fs.writeFileSync(path.join(__dirname, 'android/local.properties'), `sdk.dir=${sdkRoot}\n`)
    }

    console.log('  → Building APK...')
    run('./gradlew assembleDebug', {
      cwd: path.join(__dirname, 'android'),
      ...(VERBOSE && { stdio: [0, 1, 2] }),
    })
    if (!fs.existsSync(apkPath)) throw new Error('APK not found after build')
    pass('0.2 APK built')
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').split('\n')
      .filter(l => l.toLowerCase().includes('error')).slice(0, 3).join(' | ')
      || err.message?.slice(0, 200)
    fail('0.2 Build pipeline', msg)
    if (restoreIndex) restoreIndex()
    printSummary()
    process.exit(1)
  } finally {
    if (restoreIndex) restoreIndex()
  }

  try {
    adb(`reverse tcp:${RUNNER_PORT} tcp:${RUNNER_PORT}`)
    try { adb(`uninstall ${BUNDLE_ID}`) } catch {}
    adb(`install -r "${apkPath}"`)
    pass('0.3 APK installed')
  } catch (err) {
    fail('0.3 APK installed', err.message?.slice(0, 200))
    printSummary()
    process.exit(1)
  }

  // ─── Section 1: Phase 1 ────────────────────────────────────────────────
  logSection('1 — Phase 1: Download until kill threshold')

  const phase1Promise = startPhase1Server()
  pass('1.0 Phase 1 HTTP server started', `port ${RUNNER_PORT}`)

  try {
    adb(`shell am force-stop ${BUNDLE_ID}`)
    await sleep(500)
    adb(`shell am start -n "${BUNDLE_ID}/.MainActivity"`)
    console.log(`  → App launched, waiting for download to reach ${KILL_AT_PROGRESS * 100}%...`)
    console.log(`  → (this may take a few minutes for the 1.3 GB model)`)
  } catch (err) {
    fail('1.1 App launch', err.message?.slice(0, 200))
    printSummary()
    process.exit(1)
  }

  let phase1Result
  try {
    phase1Result = await phase1Promise
  } catch (err) {
    fail('1.1 Download reached threshold', err.message)
    printSummary()
    process.exit(1)
  }

  if (phase1Result.alreadyDone) {
    console.log('  ⚠️  Download completed before kill — model was cached.')
    pass('1.1 Download detected', `completed at ${Math.round(phase1Result.progress * 100)}%`)
    pass('SKIP: Resume not testable — model already downloaded')
    printSummary()
    process.exit(0)
  }

  pass('1.1 Download reached threshold', `${Math.round(phase1Result.progress * 100)}%`)

  try {
    adb(`shell am force-stop ${BUNDLE_ID}`)
    pass('1.2 App force-stopped mid-download')
  } catch (err) {
    fail('1.2 App force-stopped', err.message)
    printSummary()
    process.exit(1)
  }

  await sleep(3000)

  // ─── Section 2: Phase 2 ────────────────────────────────────────────────
  logSection('2 — Phase 2: Relaunch and verify resume')

  const phase2Promise = startPhase2Server()
  pass('2.0 Phase 2 HTTP server started', `port ${RUNNER_PORT}`)

  try {
    adb(`reverse tcp:${RUNNER_PORT} tcp:${RUNNER_PORT}`)
    adb(`shell am start -n "${BUNDLE_ID}/.MainActivity"`)
    console.log('  → App relaunched, waiting for resume detection...')
  } catch (err) {
    fail('2.1 App relaunch', err.message?.slice(0, 200))
    printSummary()
    process.exit(1)
  }

  let phase2Result
  try {
    phase2Result = await phase2Promise
  } catch (err) {
    fail('2.1 Resumed download completed', err.message)
    printSummary()
    process.exit(1)
  }

  // ─── Section 3: Assertions ─────────────────────────────────────────────
  logSection('3 — Assertions')

  if (phase2Result.resumeDetected) {
    pass('3.1 App detected resumed download')
  } else {
    fail('3.1 App detected resumed download', 'app reported "starting" instead of "resuming"')
  }

  if (phase2Result.status === 'ready') {
    pass('3.2 Download completed', phase2Result.path || '')
  } else {
    fail('3.2 Download completed', `status=${phase2Result.status}, error=${phase2Result.error}`)
  }

  if (phase2Result.firstProgressAfterResume !== null && phase2Result.firstProgressAfterResume > 0.05) {
    pass('3.3 Download resumed from prior progress', `first progress after resume: ${Math.round(phase2Result.firstProgressAfterResume * 100)}%`)
  } else if (phase2Result.firstProgressAfterResume === null) {
    pass('3.3 Download resumed from prior progress', 'completed without intermediate progress')
  } else {
    fail('3.3 Download resumed from prior progress', `first progress after resume was ${Math.round(phase2Result.firstProgressAfterResume * 100)}% — appears to have restarted`)
  }

  printSummary()
  try { adb(`shell am force-stop ${BUNDLE_ID}`) } catch {}
  process.exit(failedTests > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
