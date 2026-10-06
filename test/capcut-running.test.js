// regression tests for capcutRunning(): capcut_save must refuse to write while CapCut is open
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-mcp-test-'));
const ROOT = path.join(SANDBOX, 'drafts');
fs.mkdirSync(ROOT);
process.env.CAPCUT_DRAFTS_DIR = ROOT;               // must be set before core.js is loaded
const { capcutRunning, CapCutDraft, _probe } = await import('../src/core.js');
const REAL = { ..._probe };

// fake process probes
const calls = [];
const execOk = out => (cmd, opts) => { calls.push(cmd); return out; };
const execFail = (status, code) => cmd => { calls.push(cmd); const e = new Error('fail'); e.status = status; if (code) e.code = code; throw e; };
const use = (platform, exec) => { _probe.platform = platform; _probe.exec = exec; };
afterEach(() => { Object.assign(_probe, REAL); calls.length = 0; });

const DRAFT = 'Save Me';
const draftFile = path.join(ROOT, DRAFT, 'draft_info.json');
const content = { id: 'TL', duration: 1_000_000, fps: 30, materials: {}, tracks: [{ id: 'T', type: 'video', segments: [] }] };
before(() => { fs.mkdirSync(path.join(ROOT, DRAFT)); fs.writeFileSync(draftFile, JSON.stringify(content)); });
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

// ---- macOS ----
test('macOS: CapCut running -> true (exact executable name, not "CapCut Helper")', () => {
  use('darwin', execOk('99639\n'));
  assert.equal(capcutRunning(), true);
  assert.deepEqual(calls, ['pgrep -x CapCut']);
});

test('macOS: CapCut quit (pgrep exit 1) -> false', () => {
  use('darwin', execFail(1));
  assert.equal(capcutRunning(), false);
});

test('macOS: probe error (pgrep missing / exit 2+) -> assume open, so save never writes blind', () => {
  use('darwin', execFail(2));
  assert.equal(capcutRunning(), true);
  use('darwin', execFail(undefined, 'ENOENT'));
  assert.equal(capcutRunning(), true);
});

// ---- Windows / Linux: behaviour unchanged ----
test('Windows: unchanged tasklist detection', () => {
  use('win32', execOk('CapCut.exe                   1234 Console    1   250 000 K\r\n'));
  assert.equal(capcutRunning(), true);
  assert.deepEqual(calls, ['tasklist /FI "IMAGENAME eq CapCut.exe" /NH']);
  use('win32', execOk('INFO: No tasks are running which match the specified criteria.\r\n'));
  assert.equal(capcutRunning(), false);
  use('win32', execFail(1));
  assert.equal(capcutRunning(), false);
});

test('Linux: unchanged (never reports running, runs no command)', () => {
  use('linux', execOk('1234\n'));
  assert.equal(capcutRunning(), false);
  assert.deepEqual(calls, []);
});

// ---- capcut_save guard ----
test('save refuses while CapCut is running on macOS and leaves the file untouched', () => {
  use('darwin', execOk('99639\n'));
  const before = fs.readFileSync(draftFile, 'utf8');
  const d = new CapCutDraft(DRAFT);
  d.content.duration = 42;
  assert.throws(() => d.save(), /CapCut is running/);
  assert.equal(fs.readFileSync(draftFile, 'utf8'), before);
  assert.equal(fs.existsSync(draftFile + '.mcpbak'), false);
});

test('save writes on macOS once CapCut is quit', () => {
  use('darwin', execFail(1));
  const d = new CapCutDraft(DRAFT);
  d.content.fps = 25;
  d.save();
  assert.equal(JSON.parse(fs.readFileSync(draftFile, 'utf8')).fps, 25);
});

test('save with force:true still writes while CapCut is running', () => {
  use('darwin', execOk('99639\n'));
  const d = new CapCutDraft(DRAFT);
  d.content.fps = 24;
  d.save({ force: true });
  assert.equal(JSON.parse(fs.readFileSync(draftFile, 'utf8')).fps, 24);
});

test('read_timeline reports capcutRunning from the same probe', () => {
  use('darwin', execOk('99639\n'));
  assert.equal(new CapCutDraft(DRAFT).timeline().capcutRunning, true);
  use('darwin', execFail(1));
  assert.equal(new CapCutDraft(DRAFT).timeline().capcutRunning, false);
});

// ---- real pgrep, with a stand-in process named "CapCut" ----
const realCapCut = () => { try { execSync('pgrep -x CapCut', { stdio: 'ignore' }); return true; } catch { return false; } };
test('macOS (real pgrep): detects a process named CapCut, and stops detecting it once it exits', { skip: process.platform !== 'darwin' && 'macOS only' }, async t => {
  // a symlink to node named "CapCut" (a copied system binary like /bin/sleep gets killed by macOS on launch)
  const bin = path.join(SANDBOX, 'CapCut');
  fs.symlinkSync(process.execPath, bin);
  const alreadyOpen = realCapCut();                   // the real app may be open on the dev machine
  const p = spawn(bin, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const exited = new Promise(r => p.once('exit', r));
  t.after(() => p.kill('SIGKILL'));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(p.exitCode, null, 'stand-in CapCut process did not stay up');
  assert.equal(capcutRunning(), true);
  p.kill(); await exited;
  if (alreadyOpen) t.diagnostic('real CapCut is open: "quit" half not checkable here');
  else assert.equal(capcutRunning(), false);
});
