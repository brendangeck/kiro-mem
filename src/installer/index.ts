/**
 * Installer — the `kiro-learn` CLI (init, start, stop, status, uninstall).
 *
 * v1: single-machine, global install. Writes the CLI agent at
 * `~/.kiro/agents/kiro-learn.json`, deploys scripts, starts the daemon.
 *
 * @see Requirements 1–18, Non-functional N1–N12
 */

import { execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// ── Constants ───────────────────────────────────────────────────────────

/** The install directory. Always under the user's home. */
export const INSTALL_DIR: string = path.join(homedir(), '.kiro-learn');

/** Minimum required Node.js major version. */
export const MIN_NODE_VERSION = 22;

/**
 * Project markers used by {@link detectScope} to identify a project root.
 * Checked in order at each directory during the upward walk; the first
 * match at the nearest directory wins.
 *
 * @see Requirements 15.2
 */
const PROJECT_MARKERS: readonly string[] = [
  '.kiro',
  '.git',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'deno.json',
  'deno.jsonc',
] as const;

// ── Types ───────────────────────────────────────────────────────────────

/** Detected install scope. */
export interface InstallScope {
  /** Always true — global agent configs are always written. */
  global: true;
  /** When a project is detected, the absolute path to the project root. */
  projectRoot: string | undefined;
  /** The project marker that triggered detection, or undefined if no project detected. */
  detectedMarker: string | undefined;
}

/** Options for the init command. */
export interface InitOptions {
  /** Whether to run `kiro-cli agent set-default kiro-learn`. Default true. */
  setDefault: boolean;
  /** Skip project scope confirmation prompt (auto-accept). Default false. */
  yes: boolean;
  /** Force global-only scope even if a project is detected. Default false. */
  globalOnly: boolean;
}

/** Options for the uninstall command. */
export interface UninstallOptions {
  /** When true, preserve database, settings, and logs. */
  keepData: boolean;
}

// ── Precondition checks ────────────────────────────────────────────────

/**
 * Verify Node.js version >= 22. Throws with a descriptive message if not.
 *
 * @see Non-functional N7
 */
export function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split('.')[0]!, 10);
  if (major < MIN_NODE_VERSION) {
    throw new Error(
      `[kiro-learn] Node.js ${MIN_NODE_VERSION} or later is required (found: ${process.versions.node})`,
    );
  }
}

/**
 * Verify kiro-cli is installed by running `kiro-cli --version`.
 * Throws with install instructions if not found or non-zero exit.
 *
 * @see Requirements 16.1–16.4
 */
export function checkKiroCli(): void {
  try {
    execSync('kiro-cli --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      "[kiro-learn] kiro-cli is not installed. kiro-learn depends on kiro-cli for memory extraction " +
        "(the collector spawns 'kiro-cli chat --no-interactive --agent kiro-learn-compressor' to " +
        "transform events into memory records). Install kiro-cli first, then re-run 'npx kiro-learn init'.",
    );
  }
}

// ── Scope detection ─────────────────────────────────────────────────────

/**
 * Walk from `cwd` upward looking for any project marker.
 *
 * - If cwd is above $HOME → throw (fail fast).
 * - If cwd is $HOME or no marker found before $HOME → global-only.
 * - If any marker found below $HOME → global + project scope, with the
 *   NEAREST marker (first match during upward walk) winning.
 * - Walk ceiling is $HOME (never traverses at or above it).
 *
 * @see Requirements 15.1–15.8
 */
export function detectScope(cwd: string): InstallScope {
  const home = homedir();
  const resolved = realpathSync(cwd);

  // Fail fast if cwd is above $HOME
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(
      `[kiro-learn] cannot install from outside the home directory tree (cwd: ${resolved})`,
    );
  }

  // If cwd is exactly $HOME, global-only
  if (resolved === home) {
    return { global: true, projectRoot: undefined, detectedMarker: undefined };
  }

  // Walk upward from cwd looking for any project marker
  let current = resolved;
  while (current !== home && current !== path.dirname(current)) {
    for (const marker of PROJECT_MARKERS) {
      const markerPath = path.join(current, marker);
      if (existsSync(markerPath)) {
        return {
          global: true,
          projectRoot: current,
          detectedMarker: marker,
        };
      }
    }
    current = path.dirname(current);
  }

  // No marker found before $HOME — global-only
  return { global: true, projectRoot: undefined, detectedMarker: undefined };
}

// ── Interactive prompts ──────────────────────────────────────────────────

/**
 * Prompt the user with a yes/no question on an interactive TTY.
 * Returns true for Y/y/empty (Enter), false for N/n.
 *
 * @see Requirements 18.1–18.3
 */
export function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

// ── Directory and file operations ───────────────────────────────────────

/**
 * Create the ~/.kiro-learn/ directory structure.
 * Creates bin/, lib/, logs/ subdirectories.
 * Creates ~/.kiro/agents/ for global agent configs.
 * Optionally creates <projectRoot>/.kiro/agents/ for project scope.
 *
 * @see Requirements 2.1–2.6, 17.3
 */
export function createLayout(scope: InstallScope): void {
  const dirs = [
    INSTALL_DIR,
    path.join(INSTALL_DIR, 'bin'),
    path.join(INSTALL_DIR, 'lib'),
    path.join(INSTALL_DIR, 'logs'),
    path.join(homedir(), '.kiro', 'agents'),
  ];

  if (scope.projectRoot !== undefined) {
    dirs.push(path.join(scope.projectRoot, '.kiro', 'agents'));
  }

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
}

/**
 * Copy the compiled dist/ payload into ~/.kiro-learn/lib/.
 * On upgrade, removes the existing lib/ first.
 * Source path is resolved relative to the installer's own location.
 *
 * @see Requirements 3.1–3.3
 */
export function deployPayload(): void {
  const libDir = path.join(INSTALL_DIR, 'lib');

  // Determine source: the dist/ directory of the npm package.
  // This file is at dist/installer/index.js, so dist/ is one level up.
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = path.resolve(path.dirname(thisFile), '..');

  // On upgrade, remove existing lib/
  if (existsSync(libDir)) {
    rmSync(libDir, { recursive: true, force: true });
  }

  mkdirSync(libDir, { recursive: true });

  // Copy each subdirectory: shim/, collector/, installer/, types/
  for (const subdir of ['shim', 'collector', 'installer', 'types']) {
    const src = path.join(distDir, subdir);
    const dst = path.join(libDir, subdir);
    cpSync(src, dst, { recursive: true });
  }
}

/**
 * Write a minimal package.json to ~/.kiro-learn/ listing only
 * production runtime dependencies with pinned versions.
 *
 * @see Requirements 3.4
 */
export function writePackageJson(): void {
  // Read version from the package's own package.json
  const thisFile = fileURLToPath(import.meta.url);
  const pkgPath = path.resolve(path.dirname(thisFile), '..', '..', 'package.json');
  const pkgRaw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw) as { version: string };

  const runtimePkg = {
    name: 'kiro-learn-runtime',
    version: pkg.version,
    private: true,
    type: 'module',
    dependencies: {
      'better-sqlite3': '12.0.0',
      ulidx: '2.4.1',
      zod: '3.23.0',
    },
  };

  writeFileSync(
    path.join(INSTALL_DIR, 'package.json'),
    JSON.stringify(runtimePkg, null, 2) + '\n',
  );
}

/**
 * Run `npm install --production` in ~/.kiro-learn/.
 * On upgrade, removes existing node_modules/ first.
 * Spawns npm synchronously via child_process.execSync.
 *
 * @see Requirements 4.1–4.4
 */
export function installDeps(): void {
  const nodeModulesDir = path.join(INSTALL_DIR, 'node_modules');

  // On upgrade, remove existing node_modules/
  if (existsSync(nodeModulesDir)) {
    rmSync(nodeModulesDir, { recursive: true, force: true });
  }

  try {
    execSync('npm install --production', {
      cwd: INSTALL_DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err: unknown) {
    const stderr =
      err !== null && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : '';
    throw new Error(
      `[kiro-learn] dependency installation failed${stderr ? `\n${stderr}` : ''}`,
    );
  }
}

/**
 * Write the three bin wrapper scripts (shim, collector, kiro-learn)
 * to ~/.kiro-learn/bin/ and chmod 0o755.
 *
 * @see Requirements 5.1–5.5, 17.1
 */
export function writeBinWrappers(): void {
  const binDir = path.join(INSTALL_DIR, 'bin');

  // Shim wrapper
  const shimContent = [
    '#!/usr/bin/env node',
    'import { main } from "../lib/shim/cli-agent/index.js";',
    'main().catch(() => {});',
  ].join('\n') + '\n';

  const shimPath = path.join(binDir, 'shim');
  writeFileSync(shimPath, shimContent);
  chmodSync(shimPath, 0o755);

  // Collector wrapper
  const collectorContent = [
    '#!/usr/bin/env node',
    'import { startCollector } from "../lib/collector/index.js";',
    'const handle = await startCollector();',
    'process.on("SIGTERM", async () => { await handle.close(); process.exit(0); });',
    'process.on("SIGINT", async () => { await handle.close(); process.exit(0); });',
  ].join('\n') + '\n';

  const collectorPath = path.join(binDir, 'collector');
  writeFileSync(collectorPath, collectorContent);
  chmodSync(collectorPath, 0o755);

  // CLI wrapper
  const cliContent = [
    '#!/usr/bin/env node',
    'import "../lib/installer/bin.js";',
  ].join('\n') + '\n';

  const cliPath = path.join(binDir, 'kiro-learn');
  writeFileSync(cliPath, cliContent);
  chmodSync(cliPath, 0o755);
}

/**
 * Write the default settings.json if it does not already exist.
 *
 * @see Requirements 14.1–14.3
 */
export function writeSettings(): void {
  const settingsPath = path.join(INSTALL_DIR, 'settings.json');

  if (existsSync(settingsPath)) {
    return;
  }

  const defaults = {
    collector: {
      host: '127.0.0.1',
      port: 21100,
    },
    shim: {
      timeoutMs: 2000,
    },
  };

  writeFileSync(settingsPath, JSON.stringify(defaults, null, 2) + '\n');
}

/**
 * Generate and write both agent config files at all applicable scopes.
 *
 * - kiro-learn.json: global always, project-scoped when detected.
 * - kiro-learn-compressor.json: global only.
 *
 * @see Requirements 6.1–6.11
 */
export function writeAgentConfigs(scope: InstallScope): void {
  const shimPath = path.join(INSTALL_DIR, 'bin', 'shim');

  // ── Agent 1: kiro-learn.json (hook-registering agent) ──

  const kiroLearnConfig = {
    name: 'kiro-learn',
    description:
      'Continuous learning for Kiro sessions. Captures tool-use events and injects prior context.',
    hooks: {
      agentSpawn: [{ command: shimPath + ' || true' }],
      userPromptSubmit: [{ command: shimPath + ' || true' }],
      postToolUse: [{ matcher: '*', command: shimPath + ' || true' }],
      stop: [{ command: shimPath + ' || true' }],
    },
  };

  // Write global
  const globalAgentsDir = path.join(homedir(), '.kiro', 'agents');
  writeFileSync(
    path.join(globalAgentsDir, 'kiro-learn.json'),
    JSON.stringify(kiroLearnConfig, null, 2) + '\n',
  );

  // Write project-scoped if detected
  if (scope.projectRoot !== undefined) {
    const projectAgentsDir = path.join(scope.projectRoot, '.kiro', 'agents');
    writeFileSync(
      path.join(projectAgentsDir, 'kiro-learn.json'),
      JSON.stringify(kiroLearnConfig, null, 2) + '\n',
    );
  }

  // ── Agent 2: kiro-learn-compressor.json (extraction agent) ──

  const compressorPrompt =
    'You are a memory extraction agent for kiro-learn. Your job is to distill the\n' +
    'provided event content into a structured memory record.\n' +
    '\n' +
    'Analyze the content and produce a JSON object with these fields:\n' +
    '- title: A concise title (max 200 chars) summarizing the key observation\n' +
    '- summary: A detailed summary (max 4000 chars) of what happened\n' +
    '- facts: An array of discrete factual statements extracted from the content\n' +
    '- concepts: An array of key concepts, technologies, or patterns mentioned\n' +
    '- observation_type: One of "tool_use", "decision", "error", "discovery", "pattern"\n' +
    '- files_touched: An array of file paths mentioned or modified\n' +
    '\n' +
    'Respond with ONLY the JSON object, no markdown fencing, no explanation.';

  const compressorConfig = {
    name: 'kiro-learn-compressor',
    description:
      'Memory record extraction agent for kiro-learn. Distills events into structured memory records.',
    prompt: compressorPrompt,
    tools: [] as string[],
    allowedTools: [] as string[],
  };

  writeFileSync(
    path.join(globalAgentsDir, 'kiro-learn-compressor.json'),
    JSON.stringify(compressorConfig, null, 2) + '\n',
  );
}

/**
 * Run `kiro-cli agent set-default kiro-learn`.
 * Logs a warning on failure but does not throw.
 *
 * @see Requirements 7.1–7.3
 */
export function setDefaultAgent(): void {
  try {
    execSync('kiro-cli agent set-default kiro-learn', { stdio: 'ignore' });
  } catch {
    process.stderr.write(
      '[kiro-learn] warning: failed to set kiro-learn as default agent\n',
    );
  }
}

// ── Daemon lifecycle ────────────────────────────────────────────────────

/**
 * Check if the collector daemon is running.
 * Reads the PID file and probes with process.kill(pid, 0).
 * Returns the PID if alive, null if not running or stale.
 * Cleans up stale PID files.
 *
 * @see Requirements 10.2, 9.5, 9.6, N5
 */
export function getDaemonPid(): number | null {
  const pidFile = path.join(INSTALL_DIR, 'collector.pid');

  if (!existsSync(pidFile)) {
    return null;
  }

  const pidStr = readFileSync(pidFile, 'utf8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    process.stderr.write('[kiro-learn] invalid PID file, removing\n');
    unlinkSync(pidFile);
    return null;
  }

  try {
    process.kill(pid, 0); // signal 0 = liveness check
    return pid;
  } catch {
    process.stderr.write(
      `[kiro-learn] removed stale PID file (process ${pid} not running)\n`,
    );
    unlinkSync(pidFile);
    return null;
  }
}

/**
 * Start the collector daemon as a detached background process.
 * Spawns ~/.kiro-learn/bin/collector with detached: true.
 * Writes PID to ~/.kiro-learn/collector.pid.
 * Redirects stdout/stderr to ~/.kiro-learn/logs/collector-YYYY-MM-DD.log.
 *
 * @see Requirements 8.1–8.7
 */
export function startDaemon(): void {
  // Check if already running
  const existingPid = getDaemonPid();
  if (existingPid !== null) {
    process.stdout.write(
      `[kiro-learn] daemon already running (PID ${existingPid})\n`,
    );
    return;
  }

  const collectorBin = path.join(INSTALL_DIR, 'bin', 'collector');
  const logsDir = path.join(INSTALL_DIR, 'logs');
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = path.join(logsDir, `collector-${dateStr}.log`);

  // Open log file for append
  const logFd = openSync(logFile, 'a');

  const child = spawn(process.execPath, [collectorBin], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  // Write PID file
  const pidFile = path.join(INSTALL_DIR, 'collector.pid');
  writeFileSync(pidFile, String(child.pid) + '\n');
  chmodSync(pidFile, 0o644);

  // Detach — let the daemon outlive the installer
  child.unref();
  closeSync(logFd);

  process.stdout.write(`[kiro-learn] daemon started (PID ${child.pid})\n`);
}

/**
 * Synchronous sleep using Atomics.wait on a SharedArrayBuffer.
 * Blocks the current thread for the specified number of milliseconds.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop the collector daemon.
 * SIGTERM → wait up to 5s → SIGKILL.
 * Removes the PID file after the process exits.
 *
 * @see Requirements 9.1–9.6
 */
export function stopDaemon(): void {
  const pidFile = path.join(INSTALL_DIR, 'collector.pid');

  if (!existsSync(pidFile)) {
    process.stdout.write('[kiro-learn] no PID file found, daemon is not running\n');
    return;
  }

  const pidStr = readFileSync(pidFile, 'utf8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    process.stdout.write('[kiro-learn] invalid PID file, removing\n');
    unlinkSync(pidFile);
    return;
  }

  // Check if process is alive
  try {
    process.kill(pid, 0); // signal 0 = liveness check
  } catch {
    process.stdout.write(
      `[kiro-learn] stale PID file (process ${pid} not running), removing\n`,
    );
    unlinkSync(pidFile);
    return;
  }

  // Send SIGTERM
  process.stdout.write(`[kiro-learn] stopping daemon (PID ${pid})...\n`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 5 seconds for exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // still alive?
      sleepSync(100); // busy-wait in 100ms increments
    } catch {
      // Process exited
      break;
    }
  }

  // If still alive after 5s, SIGKILL
  try {
    process.kill(pid, 0);
    process.stderr.write('[kiro-learn] daemon did not respond to SIGTERM, sent SIGKILL\n');
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited
  }

  // Remove PID file
  try {
    unlinkSync(pidFile);
  } catch {
    // Ignore — file may already be gone
  }

  process.stdout.write('[kiro-learn] daemon stopped\n');
}

// ── Command handlers ────────────────────────────────────────────────────

/**
 * The `init` command. Orchestrates the full install/upgrade flow.
 * Returns 0 on success, 1 on failure.
 *
 * @see Requirements 1.2, 2–8, 12, 13, 14, 15, 16, 17, 18
 */
export async function cmdInit(opts: InitOptions): Promise<number> {
  let isUpgrade = false;
  let layoutCreated = false;

  try {
    // ── Precondition checks (before any filesystem modifications) ──
    process.stdout.write('[kiro-learn] checking Node.js version...\n');
    checkNodeVersion();

    process.stdout.write('[kiro-learn] checking kiro-cli...\n');
    checkKiroCli();

    // ── Scope detection ──
    let scope = detectScope(process.cwd());

    // Apply --global-only override
    if (opts.globalOnly) {
      scope = { global: true, projectRoot: undefined, detectedMarker: undefined };
      process.stdout.write('[kiro-learn] forced global-only scope (--global-only)\n');
    } else if (scope.projectRoot !== undefined) {
      // Confirm project scope with user
      if (!opts.yes && process.stdout.isTTY) {
        const accepted = await promptYesNo(
          `Detected project at ${scope.projectRoot} (via ${scope.detectedMarker}). Install project-scoped agent config here? [Y/n] `,
        );
        if (!accepted) {
          scope = { global: true, projectRoot: undefined, detectedMarker: undefined };
          process.stdout.write('[kiro-learn] user declined project scope, using global-only\n');
        }
      } else {
        process.stdout.write(
          `[kiro-learn] project detected at ${scope.projectRoot} (via ${scope.detectedMarker})\n`,
        );
      }
    }

    process.stdout.write(
      `[kiro-learn] scope: ${scope.projectRoot ? `global + project (${scope.projectRoot})` : 'global-only'}\n`,
    );

    // ── Detect upgrade ──
    isUpgrade = existsSync(INSTALL_DIR);

    if (isUpgrade) {
      process.stdout.write('[kiro-learn] existing install detected, upgrading...\n');
      stopDaemon();
    }

    // ── Create directory structure ──
    process.stdout.write('[kiro-learn] creating ~/.kiro-learn/...\n');
    createLayout(scope);
    layoutCreated = true;

    // ── Deploy payload ──
    process.stdout.write('[kiro-learn] deploying payload...\n');
    deployPayload();

    // ── Write package.json for runtime deps ──
    writePackageJson();

    // ── Install runtime dependencies ──
    process.stdout.write('[kiro-learn] installing dependencies...\n');
    installDeps();

    // ── Write bin wrappers ──
    process.stdout.write('[kiro-learn] writing bin wrappers...\n');
    writeBinWrappers();

    // ── Write default settings (only if new install) ──
    writeSettings();

    // ── Write agent configs at all applicable scopes ──
    process.stdout.write('[kiro-learn] writing agent configs...\n');
    writeAgentConfigs(scope);

    // ── Optionally set default agent ──
    if (opts.setDefault) {
      setDefaultAgent();
    }

    // ── Start daemon ──
    process.stdout.write('[kiro-learn] starting collector daemon...\n');
    startDaemon();

    // ── Print summary ──
    const pid = getDaemonPid();
    const pkgPath = path.join(INSTALL_DIR, 'package.json');
    let version = 'unknown';
    try {
      const pkgRaw = readFileSync(pkgPath, 'utf8');
      version = (JSON.parse(pkgRaw) as { version: string }).version;
    } catch {
      // version stays 'unknown'
    }

    process.stdout.write('\n');
    process.stdout.write('[kiro-learn] install complete!\n');
    process.stdout.write(`[kiro-learn]   version:     ${version}\n`);
    process.stdout.write(`[kiro-learn]   install_dir: ${INSTALL_DIR}\n`);
    process.stdout.write(`[kiro-learn]   daemon PID:  ${pid ?? 'not running'}\n`);
    process.stdout.write(
      `[kiro-learn]   scope:       ${scope.projectRoot ? `global + project (${scope.projectRoot})` : 'global-only'}\n`,
    );
    process.stdout.write(
      `[kiro-learn]   agents:      ${path.join(homedir(), '.kiro', 'agents', 'kiro-learn.json')}`,
    );
    if (scope.projectRoot !== undefined) {
      process.stdout.write(
        `\n[kiro-learn]                ${path.join(scope.projectRoot, '.kiro', 'agents', 'kiro-learn.json')}`,
      );
    }
    process.stdout.write('\n');

    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] init failed: ${message}\n`);

    // Cleanup on fresh install failure (before payload deployment)
    if (!isUpgrade && layoutCreated) {
      try {
        rmSync(INSTALL_DIR, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    return 1;
  }
}

/**
 * The `start` command. Starts the daemon if not already running.
 * Returns 0 on success, 1 on failure.
 *
 * @see Requirements 8.2, 8.6, 8.7
 */
export function cmdStart(): number {
  if (!existsSync(INSTALL_DIR)) {
    process.stderr.write(
      "[kiro-learn] not installed. Run 'npx kiro-learn init' first.\n",
    );
    return 1;
  }

  try {
    startDaemon();
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] failed to start daemon: ${message}\n`);
    return 1;
  }
}

/**
 * The `stop` command. Stops the daemon if running.
 * Returns 0 on success (including "not running"), 1 on failure.
 *
 * @see Requirements 9.1–9.6
 */
export function cmdStop(): number {
  if (!existsSync(INSTALL_DIR)) {
    process.stdout.write('[kiro-learn] not installed, nothing to stop\n');
    return 0;
  }

  try {
    stopDaemon();
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] failed to stop daemon: ${message}\n`);
    return 1;
  }
}

/**
 * The `status` command. Prints install and daemon status.
 * Returns 0 if installed, 1 if not installed.
 *
 * @see Requirements 10.1–10.7
 */
export function cmdStatus(): number {
  if (!existsSync(INSTALL_DIR)) {
    process.stderr.write('[kiro-learn] not installed\n');
    return 1;
  }

  // Daemon status
  const pid = getDaemonPid();
  if (pid !== null) {
    process.stdout.write('status: running\n');
    process.stdout.write(`pid: ${pid}\n`);
  } else {
    process.stdout.write('status: stopped\n');
  }

  // Install info
  process.stdout.write(`install_dir: ${INSTALL_DIR}\n`);

  // Database
  const dbPath = path.join(INSTALL_DIR, 'kiro-learn.db');
  process.stdout.write(`database: ${dbPath}\n`);
  process.stdout.write(`database_exists: ${existsSync(dbPath)}\n`);

  // Version
  try {
    const pkgRaw = readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8');
    const version = (JSON.parse(pkgRaw) as { version: string }).version;
    process.stdout.write(`version: ${version}\n`);
  } catch {
    process.stdout.write('version: unknown\n');
  }

  return 0;
}

/**
 * The `uninstall` command. Removes kiro-learn from the system.
 * Returns 0 on success (including "not installed"), 1 on failure.
 *
 * @see Requirements 11.1–11.7
 */
export function cmdUninstall(opts: UninstallOptions): number {
  if (!existsSync(INSTALL_DIR)) {
    process.stdout.write('[kiro-learn] not installed, nothing to uninstall\n');
    return 0;
  }

  try {
    // Stop daemon
    stopDaemon();

    // Detect scope for project-level cleanup
    let scope: InstallScope;
    try {
      scope = detectScope(process.cwd());
    } catch {
      scope = { global: true, projectRoot: undefined, detectedMarker: undefined };
    }

    // Remove global agent configs
    const globalAgentsDir = path.join(homedir(), '.kiro', 'agents');
    for (const name of ['kiro-learn.json', 'kiro-learn-compressor.json']) {
      const agentPath = path.join(globalAgentsDir, name);
      if (existsSync(agentPath)) {
        unlinkSync(agentPath);
      }
    }

    // Remove project-scoped agent config if applicable
    if (scope.projectRoot !== undefined) {
      const projectAgent = path.join(
        scope.projectRoot,
        '.kiro',
        'agents',
        'kiro-learn.json',
      );
      if (existsSync(projectAgent)) {
        unlinkSync(projectAgent);
      }
    }

    // Remove install directory
    if (opts.keepData) {
      // Remove bin/, lib/, node_modules/ but keep db, settings, logs
      for (const subdir of ['bin', 'lib', 'node_modules']) {
        const dirPath = path.join(INSTALL_DIR, subdir);
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true });
        }
      }
      // Remove PID file and package.json
      for (const file of ['collector.pid', 'package.json']) {
        const filePath = path.join(INSTALL_DIR, file);
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      }
    } else {
      rmSync(INSTALL_DIR, { recursive: true, force: true });
    }

    process.stdout.write('[kiro-learn] uninstalled successfully\n');
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] uninstall failed: ${message}\n`);
    return 1;
  }
}
