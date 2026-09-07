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
 *   sesh-hound [cwd] [--json]
 *
 * [cwd] defaults to the current directory if omitted. Matched as an exact
 * string OR as a path prefix (pointing at a parent folder finds sessions
 * from subfolders too) — path separators and case are normalized before
 * comparing, so this works the same on Windows, macOS, and Linux.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const helpFlag = args.includes('--help') || args.includes('-h');
const targetArg = args.find(a => !a.startsWith('-')) || process.cwd();

if (helpFlag) {
  console.log(`sesh-hound — sniff out Claude Code / Codex / VS Code Copilot sessions from a folder

Usage:
  sesh-hound [cwd] [--json]

  [cwd]    Folder to search from. Defaults to the current directory.
  --json   Print machine-readable JSON instead of the friendly report.

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

function fileMTime(p) {
  try { return fs.statSync(p).mtime; } catch { return null; }
}

// ---------- Title resolution ----------
// Each harness stores its live, user/agent-renamable session title
// differently (see SKILL-OF/local-agent-discovery memory on this). Resolve
// it here so a caller never has to guess which session a bare UUID is —
// resemblance (rank/suit/deck) is not identity; a real title, or an honest
// "still default" flag, is.
const TITLE_HEAD_BYTES = 65536;
const TITLE_TAIL_BYTES = 65536;

function resolveClaudeTitle(fullPath) {
  // customTitle can be set at launch (near the top) or renamed mid-session
  // (appended later) — check both ends without reading the whole file,
  // same bounded-read discipline as the cwd scan above. A later occurrence
  // wins if both ends carry one.
  let head = '', tail = '';
  try {
    const size = fs.statSync(fullPath).size;
    const fd = fs.openSync(fullPath, 'r');
    const headBuf = Buffer.alloc(Math.min(TITLE_HEAD_BYTES, size));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    head = headBuf.toString('utf8');
    if (size > TITLE_HEAD_BYTES) {
      const tailLen = Math.min(TITLE_TAIL_BYTES, size);
      const tailBuf = Buffer.alloc(tailLen);
      fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen);
      tail = tailBuf.toString('utf8');
    }
    fs.closeSync(fd);
  } catch { return null; }
  const re = /"customTitle":"([^"]*)"/g;
  let last = null, m;
  for (const chunk of [head, tail]) {
    re.lastIndex = 0;
    while ((m = re.exec(chunk))) last = m[1];
  }
  return last;
}

let _codexTitleDb = undefined; // undefined = not yet attempted, null = unavailable
function resolveCodexTitle(threadId) {
  if (_codexTitleDb === undefined) {
    _codexTitleDb = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(HOME, '.codex', 'sqlite', 'codex-dev.db');
      if (fs.existsSync(dbPath)) _codexTitleDb = new DatabaseSync(dbPath, { readOnly: true });
    } catch { _codexTitleDb = null; }
  }
  if (!_codexTitleDb) return null;
  try {
    const row = _codexTitleDb
      .prepare('SELECT display_title FROM local_thread_catalog WHERE thread_id = ?')
      .get(threadId);
    return row ? row.display_title : null;
  } catch { return null; }
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
        const title = resolveClaudeTitle(fullPath);
        results.push({
          tool: 'claude-code',
          sessionId: f.replace(/\.jsonl$/, ''),
          cwd,
          file: fullPath,
          mtime: fileMTime(fullPath),
          title,
          needsReview: !title,
        });
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
          const title = resolveCodexTitle(sessionId);
          results.push({
            tool: 'codex',
            sessionId: sessionId || path.basename(full),
            cwd,
            file: full,
            mtime: fileMTime(full),
            title,
            needsReview: !title,
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
          mtime: fileMTime(full),
          title: null, // no known title store found yet for this tool
          needsReview: true,
        });
      }
    }
  }
}

scanClaudeCode();
scanCodex();
scanVSCodeCopilot();

results.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

if (jsonOut) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`🐕 sesh-hound sniffing: ${targetArg}\n`);
  if (results.length === 0) {
    console.log('  Nothing here — no scent trail from this folder.');
  }
  for (const r of results) {
    const mtimeStr = r.mtime ? r.mtime.toISOString() : 'unknown';
    console.log(`  [${r.tool}] ${r.sessionId}  (last active: ${mtimeStr})`);
    if (r.title) {
      console.log(`      title: ${r.title}`);
    } else {
      console.log(`      title: (none set — needs chat analysis to identify)`);
    }
    console.log(`      cwd:  ${r.cwd}`);
    console.log(`      file: ${r.file}`);
  }
  const needingReview = results.filter(r => r.needsReview).length;
  console.log(`\n${results.length} session${results.length === 1 ? '' : 's'} found` +
    (needingReview ? `, ${needingReview} with no title (identity needs chat analysis).` : '.'));
}
