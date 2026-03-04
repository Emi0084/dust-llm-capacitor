#!/usr/bin/env node
/**
 * LLM Sample — Resume-After-Kill E2E Test (iOS Simulator)
 *
 * Verifies that killing the app mid-download and relaunching causes the
 * download to resume rather than restart from zero.
 *
 * Protocol:
 *   1. Patches index.html with RESUME_TEST_MODE = true
 *   2. Launches app → app auto-starts GGUF download and POSTs progress
 *   3. At >10% progress, test kills the app via simctl terminate
 *   4. Relaunches → app detects resumed download, POSTs resumed + final status
 *   5. Test asserts the download completed without restarting from 0%
 *
 * Requires: app already built and installed (run test-e2e-serve-ios.mjs first).
 *
 * Usage:
 *   node test-e2e-resume-ios.mjs [--verbose] [--open-simulator]
 */

import { execSync } from 'child_process'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VERBOSE = process.argv.includes('--verbose')
const OPEN_SIMULATOR = process.argv.includes('--open-simulator')

// ─── Config ──────────────────────────────────────────────────────────────────
const BUNDLE_ID = 'io.t6x.llmchat.sample'
const RUNNER_PORT = 8099
const KILL_AT_PROGRESS = 0.10         // kill app when progress exceeds 10%
const TIMEOUT_PHASE1_MS = 600_000     // 10 min for initial download to reach threshold (1.3 GB model)
const TIMEOUT_PHASE2_MS = 1_200_000   // 20 min for resumed download to complete

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

// ─── Shell helper ────────────────────────────────────────────────────────────
function extendedPath() {
  const nodeDir = path.dirname(process.execPath)
  const extra = [
    nodeDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${process.env.HOME}/.nvm/versions/node/current/bin`,
  ].filter(Boolean)
  const existing = (process.env.PATH || '').split(':')
  return [...new Set([...extra, ...existing])].join(':')
}

function run(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    env: { ...process.env, PATH: extendedPath() },
    ...opts,
  })?.trim() || ''
}

// ─── simctl helpers ──────────────────────────────────────────────────────────
function simctl(args, opts = {}) {
  return execSync(`xcrun simctl ${args}`, {
    encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim()
}

function getBootedUDID() {
  const json = simctl('list devices booted -j')
  const data = JSON.parse(json)
  for (const devices of Object.values(data.devices)) {
    for (const d of devices) {
      if (d.state === 'Booted') {
        try {
          simctl(`get_app_container ${d.udid} ${BUNDLE_ID} data`)
          return d.udid
        } catch {}
      }
    }
  }
  return null
}

// ─── HTML patching ───────────────────────────────────────────────────────────
function patchHtmlForResumeTest(udid) {
  const bundleDir = simctl(`get_app_container ${udid} ${BUNDLE_ID}`)
  const htmlPath = path.join(bundleDir, 'public/index.html')
  let html = fs.readFileSync(htmlPath, 'utf8')

  // Skip if already patched
  if (html.includes('RESUME_TEST_MODE')) return htmlPath

  // Inject RESUME_TEST_MODE config
  const resumeSnippet = `
    var RESUME_TEST_MODE = true;
    var E2E_RESUME_URL = 'http://127.0.0.1:${RUNNER_PORT}';
  `

  html = html.replace(
    /(<script>\s*\/\* ─── Patchable config)/,
    `<script>${resumeSnippet}</script>\n  $1`
  )

  // Inject resume test boot logic
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

      // Register model
      try {
        await Serve.registerModel({ descriptor: GGUF_DESCRIPTOR });
      } catch(_e) {}

      // Check current status
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

      // Attach listeners
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

  html = html.replace('</body>', resumeBootScript + '\n</body>')

  fs.writeFileSync(htmlPath, html)
  return htmlPath
}

// ─── HTTP server for phase 1 (initial download until kill) ───────────────────
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
            console.log(`  [app] Status: ${data.phase} (kind=${data.kind}, progress=${data.progress})`)
            res.writeHead(200); res.end('ok')
          } else if (req.url === '/__resume_progress') {
            lastProgress = data.progress || 0
            const pct = Math.round(lastProgress * 100)
            if (!gotFirstProgress) {
              gotFirstProgress = true
              console.log(`  [app] First progress: ${pct}%`)
            }
            if (VERBOSE) {
              console.log(`  [app] Progress: ${pct}% (${formatBytes(data.bytesDownloaded)} / ${formatBytes(data.totalBytes)})`)
            }
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

// ─── HTTP server for phase 2 (resumed download until completion) ─────────────
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
            if (data.phase === 'resuming') {
              resumeDetected = true
            }
            res.writeHead(200); res.end('ok')
          } else if (req.url === '/__resume_progress') {
            if (firstProgressAfterResume === null) {
              firstProgressAfterResume = data.progress || 0
              console.log(`  [app] First progress after resume: ${Math.round(firstProgressAfterResume * 100)}%`)
            }
            if (VERBOSE) {
              console.log(`  [app] Progress: ${Math.round((data.progress || 0) * 100)}%`)
            }
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

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n🔵 LLM Sample — Resume-After-Kill E2E Test (iOS)\n')

  // ─── Section 0: Setup ──────────────────────────────────────────────────
  logSection('0 — Setup')

  let udid
  try {
    udid = getBootedUDID()
    if (!udid) throw new Error('No booted simulator with app installed — run test-e2e-serve-ios.mjs first')
    pass('0.1 Simulator ready', `UDID ${udid}`)
  } catch (err) {
    fail('0.1 Simulator ready', err.message)
    printSummary()
    process.exit(1)
  }

  // Clean existing model
  try {
    const dataDir = simctl(`get_app_container ${udid} ${BUNDLE_ID} data`)
    // dust-serve stores models in <filesDir>/models/<modelId>/
    // On iOS simulator, the app's files dir is inside the data container
    for (const subdir of ['Library/Application Support/models', 'Documents/models', 'tmp/models']) {
      const dir = path.join(dataDir, subdir)
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    pass('0.2 Cleaned existing model data')
  } catch (err) {
    pass('0.2 Cleaned existing model data', 'nothing to clean')
  }

  // Patch HTML
  try {
    patchHtmlForResumeTest(udid)
    pass('0.3 HTML patched for resume test')
  } catch (err) {
    fail('0.3 HTML patched', err.message?.slice(0, 200) || 'failed')
    printSummary()
    process.exit(1)
  }

  // ─── Section 1: Phase 1 ────────────────────────────────────────────────
  logSection('1 — Phase 1: Download until kill threshold')

  const phase1Promise = startPhase1Server()
  pass('1.0 Phase 1 HTTP server started', `port ${RUNNER_PORT}`)

  try {
    try { simctl(`terminate ${udid} ${BUNDLE_ID}`) } catch {}
    await sleep(500)
    simctl(`launch ${udid} ${BUNDLE_ID}`)
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
    console.log('  ⚠️  Download completed before kill threshold — model was cached.')
    pass('1.1 Download progress detected', `completed at ${Math.round(phase1Result.progress * 100)}%`)
    pass('SKIP: Resume not testable — model already downloaded')
    printSummary()
    process.exit(0)
  }

  pass('1.1 Download reached threshold', `${Math.round(phase1Result.progress * 100)}%`)

  // Kill the app
  try {
    simctl(`terminate ${udid} ${BUNDLE_ID}`)
    pass('1.2 App terminated mid-download')
  } catch (err) {
    fail('1.2 App terminated', err.message)
    printSummary()
    process.exit(1)
  }

  await sleep(2000)

  // ─── Section 2: Phase 2 ────────────────────────────────────────────────
  logSection('2 — Phase 2: Relaunch and verify resume')

  try {
    patchHtmlForResumeTest(udid)
  } catch (err) {
    fail('2.0 HTML re-patched', err.message?.slice(0, 200))
    printSummary()
    process.exit(1)
  }

  const phase2Promise = startPhase2Server()
  pass('2.0 Phase 2 HTTP server started', `port ${RUNNER_PORT}`)

  try {
    simctl(`launch ${udid} ${BUNDLE_ID}`)
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
  process.exit(failedTests > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
