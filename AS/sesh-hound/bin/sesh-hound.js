#!/usr/bin/env node
/**
 * sesh-hound — given a cwd, sniff out every Claude Code, Codex, and
 * VS Code Copilot Chat session ever spawned from that folder.
 *
 * Verified sources of truth (2026-08-29), each confirmed by direct
 * inspection on a real machine, not assumed:
 *
 *   - Claude Code: ~/.claude/projects/<escaped-cwd>/*.jsonl — every event
 *     carries a plain "cwd" field. Grepping content is more robust than
 *     reverse-engineering the folder-name escaping scheme (handles
 *     unicode/edge cases the escaping might mangle).
 *
 *   - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — directory
 *     structure is DATE-based, not cwd-based. First line is a session_meta
 *     event with a plain "cwd" field. The file's own UUID (from its
 *     filename) is the reliable session id — a "session_id" field found
 *     elsewhere in content can refer to a parent/original session after a
 *     resume/fork, not the file itself.
 *
 *   - VS Code Copilot Chat (Code and Code - Insiders, both checked, OS-
 *     appropriate config dir): <vscode-config-dir>/User/workspaceStorage/
 *     <hash>/workspace.json has a "folder" or "workspace" field with a
 *     file:// URI (URL-encoded) to the real folder or a .code-workspace
 *     file (strip via dirname if so). Matching hash's sibling chatSessions/
 *     dir holds the session *.jsonl files — NOT .json, a real gotcha.
 *
 * Usage:
 *   sesh-hound [cwd] [--json] [--stats] [--min-turns N]
 *
 * [cwd] defaults to the current directory if omitted. Matched as an exact
 * string OR as a path prefix (pointing at a parent folder finds sessions
 * from subfolders too) — path separators and case are normalized before
 * comparing, so this works the same on Windows, macOS, and Linux.
 *
 * --stats        Read each Claude Code session's full JSONL to emit per-session
 *                counts: userTurns, assistantTurns, compactions, first/last
 *                timestamps. Slower than the default metadata-only scan.
 *
 * --min-turns N  Suppress sessions with fewer than N user turns (requires
 *                --stats). Useful for filtering single-exchange noise from
 *                Q-semver lineage counts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const statsMode = args.includes('--stats');
const helpFlag = args.includes('--help') || args.includes('-h');
const targetArg = args.find(a => !a.startsWith('-')) || process.cwd();

let minTurns = 0;
const minTurnsIdx = args.indexOf('--min-turns');
if (minTurnsIdx !== -1 && args[minTurnsIdx + 1]) {
  minTurns = parseInt(args[minTurnsIdx + 1], 10) || 0;
}

if (helpFlag) {
  console.log(`sesh-hound — sniff out Claude Code / Codex / VS Code Copilot sessions from a folder

Usage:
  sesh-hound [cwd] [--json] [--stats] [--min-turns N]

  [cwd]          Folder to search from. Defaults to the current directory.
  --json         Print machine-readable JSON instead of the friendly report.
  --stats        Read full JSONL to count turns, compactions, timestamps.
                 (Claude Code only; slower than the default metadata scan.)
  --min-turns N  Hide sessions with fewer than N user turns. Requires --stats.

Matches the folder exactly, or as a path prefix — pointing at a parent
folder also finds sessions from every subfolder underneath it.`);
  process.exit(0);
}

function normalize(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const target = normalize(path.resolve(targetArg));

function matches(cwd) {
  if (!cwd) return false;
  const n = normalize(cwd);
  return n === target || n.startsWith(target + '/') || target.startsWith(n + '/');
}

function fileTimes(p) {
  try {
    const s = fs.statSync(p);
    // birthtimeMs is 0 on filesystems that don't support birth time — fall back to mtime.
    const birthtime = s.birthtimeMs > 0 ? s.birthtime : s.mtime;
    return { mtime: s.mtime, birthtime };
  } catch { return { mtime: null, birthtime: null }; }
}

/**
 * Read a Claude Code JSONL file and return per-session stats.
 *
 * Compaction detection mirrors identify-instance-event-aware.js (v4, 2026-09-07):
 * compact events are type="user" records whose message.content (string) includes
 * "Compacted (ctrl+o to see full summary)". Legacy system/compact_boundary formats
 * are intentionally not checked — they caused triple-counting in earlier versions.
 */
function readClaudeCodeStats(filePath) {
  let userTurns = 0;
  let assistantTurns = 0;
  let compactions = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;

  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    const ts = rec.timestamp;
    if (ts) {
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }

    if (rec.type === 'assistant') {
      assistantTurns++;
      continue;
    }

    if (rec.type === 'user') {
      const content = rec.message && rec.message.content;
      if (typeof content === 'string' &&
          content.includes('Compacted (ctrl+o to see full summary)')) {
        compactions++;
      } else {
        userTurns++;
      }
    }
  }

  return { userTurns, assistantTurns, compactions, firstTimestamp, lastTimestamp };
}

const results = [];

// ---------- Claude Code ----------
function scanClaudeCode() {
  const projectsDir = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return;
  for (const dir of fs.readdirSync(projectsDir)) {
    const dirPath = path.join(projectsDir, dir);
    let stat;
    try { stat = fs.statSync(dirPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fullPath = path.join(dirPath, f);
      let cwd = null;
      try {
        // Only need to find one cwd field — read the first 8KB, which is
        // plenty since Claude Code stamps cwd on nearly every event.
        const buf = fs.readFileSync(fullPath, { encoding: 'utf8', flag: 'r' }).slice(0, 8000);
        const m = buf.match(/"cwd":"([^"]*)"/);
        if (m) cwd = m[1].replace(/\\\\/g, '\\');
      } catch { continue; }
      if (matches(cwd)) {
        const entry = {
          tool: 'claude-code',
          sessionId: f.replace(/\.jsonl$/, ''),
          cwd,
          file: fullPath,
          ...fileTimes(fullPath),
        };
        if (statsMode) {
          const stats = readClaudeCodeStats(fullPath);
          if (stats) Object.assign(entry, stats);
        }
        results.push(entry);
      }
    }
  }
}

// ---------- Codex ----------
function scanCodex() {
  const sessionsDir = path.join(HOME, '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) {
        let cwd = null;
        const nameMatch = e.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
        const sessionId = nameMatch ? nameMatch[1] : e.name.replace(/\.jsonl$/, '');
        try {
          const fh = fs.openSync(full, 'r');
          const buf = Buffer.alloc(4096);
          const bytes = fs.readSync(fh, buf, 0, 4096, 0);
          fs.closeSync(fh);
          const text = buf.slice(0, bytes).toString('utf8');
          const cwdM = text.match(/"cwd":"([^"]*)"/);
          if (cwdM) cwd = cwdM[1].replace(/\\\\/g, '\\');
        } catch { continue; }
        if (matches(cwd)) {
          results.push({
            tool: 'codex',
            sessionId: sessionId || path.basename(full),
            cwd,
            file: full,
            ...fileTimes(full),
          });
        }
      }
    }
  }
  walk(sessionsDir);
}

// ---------- VS Code Copilot Chat (Code + Code - Insiders, any OS) ----------
function vscodeConfigDirs() {
  // Real, OS-specific config roots — checked for existence, never assumed.
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return [path.join(appData, 'Code'), path.join(appData, 'Code - Insiders')];
  }
  if (process.platform === 'darwin') {
    const base = path.join(HOME, 'Library', 'Application Support');
    return [path.join(base, 'Code'), path.join(base, 'Code - Insiders')];
  }
  // Linux and other XDG-compliant systems
  const base = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  return [path.join(base, 'Code'), path.join(base, 'Code - Insiders')];
}

function scanVSCodeCopilot() {
  for (const configDir of vscodeConfigDirs()) {
    const variant = path.basename(configDir);
    const wsStorageDir = path.join(configDir, 'User', 'workspaceStorage');
    if (!fs.existsSync(wsStorageDir)) continue;
    for (const hash of fs.readdirSync(wsStorageDir)) {
      const hashDir = path.join(wsStorageDir, hash);
      const wsJsonPath = path.join(hashDir, 'workspace.json');
      let folderPath = null;
      try {
        const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
        const uri = wsJson.folder || wsJson.workspace;
        if (uri && uri.startsWith('file:///')) {
          folderPath = decodeURIComponent(uri.replace('file:///', ''));
          if (process.platform === 'win32') {
            // file:///c%3A/... decodes to c:/... on Windows; other OSes
            // don't have a drive letter to worry about.
            folderPath = folderPath.replace(/^([a-zA-Z])%3A/i, '$1:');
          } else {
            folderPath = '/' + folderPath;
          }
          if (folderPath.endsWith('.code-workspace')) folderPath = path.dirname(folderPath);
        }
      } catch { continue; }
      if (!matches(folderPath)) continue;
      const chatSessionsDir = path.join(hashDir, 'chatSessions');
      if (!fs.existsSync(chatSessionsDir)) continue;
      for (const f of fs.readdirSync(chatSessionsDir)) {
        if (!/\.jsonl?$/.test(f)) continue;
        const full = path.join(chatSessionsDir, f);
        results.push({
          tool: `vscode-copilot (${variant})`,
          sessionId: f.replace(/\.jsonl?$/, ''),
          cwd: folderPath,
          file: full,
          ...fileTimes(full),
        });
      }
    }
  }
}

scanClaudeCode();
scanCodex();
scanVSCodeCopilot();

results.sort((a, b) => {
  const at = a.birthtime || a.mtime;
  const bt = b.birthtime || b.mtime;
  return (bt || 0) - (at || 0);
});

// Apply --min-turns filter (only meaningful with --stats)
const filtered = (statsMode && minTurns > 0)
  ? results.filter(r => (r.userTurns || 0) >= minTurns)
  : results;

if (jsonOut) {
  console.log(JSON.stringify(filtered, null, 2));
} else {
  console.log(`🐕 sesh-hound sniffing: ${targetArg}\n`);
  if (filtered.length === 0) {
    console.log('  Nothing here — no scent trail from this folder.');
  }
  for (const r of filtered) {
    const created = r.birthtime ? r.birthtime.toISOString() : 'unknown';
    const active  = r.mtime    ? r.mtime.toISOString()     : 'unknown';
    console.log(`  [${r.tool}] ${r.sessionId}  (created: ${created}  last active: ${active})`);
    console.log(`      cwd:  ${r.cwd}`);
    console.log(`      file: ${r.file}`);
    if (statsMode && r.userTurns !== undefined) {
      const compact = r.compactions > 0 ? `  compactions: ${r.compactions}` : '';
      const trivial = r.userTurns <= 1 && r.compactions === 0 ? '  [trivial]' : '';
      console.log(`      turns: user=${r.userTurns}  assistant=${r.assistantTurns}${compact}${trivial}`);
    }
  }
  const suffix = (statsMode && minTurns > 0) ? ` (${results.length - filtered.length} trivial filtered)` : '';
  console.log(`\n${filtered.length} session${filtered.length === 1 ? '' : 's'} found.${suffix}`);
}
