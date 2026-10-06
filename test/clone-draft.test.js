// regression tests for cloneDraft: a clone must be a complete, independent CapCut project
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// drafts dir lives inside a sandbox, so a path-escape bug stays contained (and cleaned up)
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-mcp-test-'));
const ROOT = path.join(SANDBOX, 'drafts');
fs.mkdirSync(ROOT);
process.env.CAPCUT_DRAFTS_DIR = ROOT;               // must be set before core.js is loaded
const { cloneDraft, CapCutDraft, DRAFTS_DIR, _probe } = await import('../src/core.js');
// these tests are about cloning: behave as if CapCut were closed, even if it is open on this machine
_probe.exec = () => { const e = new Error('no match'); e.status = 1; throw e; };

const BASE = 'Base Draft';
const TL_ID = '330C4A38-19F1-4912-AB6F-D86ECD4BC164';
const PROJECT_ID = '84DC807D-844A-4B65-A55C-62F2236B776F';
const BASE_DRAFT_ID = '33200A08-25ED-49A9-845E-4C0455DA7972';

const content = () => ({
  id: TL_ID, duration: 2_000_000, fps: 30,
  canvas_config: { width: 1080, height: 1920, ratio: 'original' },
  materials: {
    videos: [{ id: 'V1', type: 'video', path: '', material_name: 'clip.mov' }],
    texts: [{ id: 'T1', type: 'text', content: '{"text":"HELLO"}' }],
  },
  tracks: [
    { id: 'TRK1', type: 'video', segments: [{ id: 'S1', material_id: 'V1', render_index: 0, target_timerange: { start: 0, duration: 2_000_000 }, source_timerange: { start: 0, duration: 2_000_000 }, extra_material_refs: [] }] },
    { id: 'TRK2', type: 'text', segments: [{ id: 'S2', material_id: 'T1', render_index: 14000, target_timerange: { start: 0, duration: 1_000_000 }, extra_material_refs: [] }] },
  ],
});

function write(rel, data) {
  const p = path.join(ROOT, BASE, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

// every file under dir -> sha1, keyed by relative path
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  })(dir);
  return out;
}
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const metaOf = name => readJSON(path.join(DRAFTS_DIR, name, 'draft_meta_info.json'));

let baseSnap;
before(() => {
  write('draft_info.json', content());
  write('draft_info.json.bak', content());
  write('draft_meta_info.json', {
    draft_id: BASE_DRAFT_ID, draft_name: BASE, draft_cover: 'draft_cover.jpg',
    draft_fold_path: path.join(ROOT, BASE), draft_root_path: ROOT,
    tm_draft_create: 1, tm_draft_modified: 2, tm_duration: 2_000_000, extra_field: 'kept',
  });
  write('draft_cover.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
  write('Timelines/project.json', { id: PROJECT_ID, main_timeline_id: TL_ID, timelines: [{ id: TL_ID, name: 'Chronologie 01' }] });
  write(`Timelines/${TL_ID}/draft_info.json`, content());
  write(`Timelines/${TL_ID}/common_attachment/attachment.json`, { a: 1 });
  write('Resources/digitalHuman/asset.bin', Buffer.from([1, 2, 3]));
  write('matting/mask.dat', 'mask');
  fs.mkdirSync(path.join(ROOT, BASE, 'adjust_mask'), { recursive: true });   // empty dir must survive too
  write('.locked', '');                                                       // CapCut lock: must NOT be copied
  baseSnap = snapshot(path.join(ROOT, BASE));
});
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test('clone copies every subfolder (Timelines/, Resources/, …) byte for byte', () => {
  cloneDraft(BASE, 'Full Copy');
  const dst = path.join(ROOT, 'Full Copy');
  const snap = snapshot(dst);
  for (const [rel, sha] of Object.entries(baseSnap)) {
    if (rel === '.locked' || rel === 'draft_meta_info.json') continue;
    assert.equal(snap[rel], sha, `missing or altered in clone: ${rel}`);
  }
  assert.ok(fs.statSync(path.join(dst, 'adjust_mask')).isDirectory(), 'empty subfolder not copied');
});

test('clone does not copy the CapCut .locked file', () => {
  cloneDraft(BASE, 'No Lock');
  assert.equal(fs.existsSync(path.join(ROOT, 'No Lock', '.locked')), false);
});

test('clone gets its own draft_id, name and paths; other meta is kept', () => {
  cloneDraft(BASE, 'Own Id');
  const m = metaOf('Own Id');
  assert.notEqual(m.draft_id, BASE_DRAFT_ID);
  assert.match(m.draft_id, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(m.draft_name, 'Own Id');
  assert.equal(path.resolve(m.draft_fold_path), path.join(ROOT, 'Own Id'));
  assert.equal(path.resolve(m.draft_root_path), path.resolve(ROOT));
  assert.ok(m.tm_draft_create > 2 && m.tm_draft_modified >= m.tm_draft_create);
  assert.equal(m.extra_field, 'kept');
  assert.equal(m.draft_cover, 'draft_cover.jpg');
  assert.equal(m.tm_duration, 2_000_000);
});

test('two clones of the same base get different draft_ids', () => {
  cloneDraft(BASE, 'Twin A'); cloneDraft(BASE, 'Twin B');
  assert.notEqual(metaOf('Twin A').draft_id, metaOf('Twin B').draft_id);
});

test('clone keeps timeline ids consistent (project.json ↔ Timelines/<id> ↔ draft_info.json)', () => {
  cloneDraft(BASE, 'Consistent');
  const dst = path.join(ROOT, 'Consistent');
  const pj = readJSON(path.join(dst, 'Timelines/project.json'));
  const main = readJSON(path.join(dst, 'draft_info.json'));
  const mirror = readJSON(path.join(dst, 'Timelines', pj.main_timeline_id, 'draft_info.json'));
  assert.equal(main.id, pj.main_timeline_id);
  assert.deepEqual(mirror, main);
});

test('the original draft is never modified', () => {
  cloneDraft(BASE, 'Orig Check');
  cloneDraft(BASE, 'Orig Check Empty', { empty: true });
  assert.deepEqual(snapshot(path.join(ROOT, BASE)), baseSnap);
});

test('empty:true clears both timeline files and keeps them in sync', () => {
  cloneDraft(BASE, 'Empty Copy', { empty: true });
  const dst = path.join(ROOT, 'Empty Copy');
  const main = readJSON(path.join(dst, 'draft_info.json'));
  const mirror = readJSON(path.join(dst, 'Timelines', TL_ID, 'draft_info.json'));
  assert.equal(main.duration, 0);
  assert.ok(main.tracks.every(t => t.segments.length === 0));
  assert.ok(Object.values(main.materials).every(v => !Array.isArray(v) || v.length === 0));
  assert.equal(main.id, TL_ID, 'timeline id must still match Timelines/<id>');
  assert.deepEqual(mirror, main);
  assert.notEqual(metaOf('Empty Copy').draft_id, BASE_DRAFT_ID);
});

test('a clone opens and saves as a normal draft (both timeline files written)', () => {
  cloneDraft(BASE, 'Editable');
  const d = new CapCutDraft('Editable');
  d.content.tracks[0].segments[0].target_timerange.duration = 1_500_000;
  d.save();
  const dst = path.join(ROOT, 'Editable');
  const main = readJSON(path.join(dst, 'draft_info.json'));
  assert.equal(main.tracks[0].segments[0].target_timerange.duration, 1_500_000);
  assert.deepEqual(readJSON(path.join(dst, 'Timelines', TL_ID, 'draft_info.json')), main);
  assert.deepEqual(snapshot(path.join(ROOT, BASE)), baseSnap);
});

test('refuses to overwrite an existing draft', () => {
  cloneDraft(BASE, 'Exists');
  const before = snapshot(path.join(ROOT, 'Exists'));
  assert.throws(() => cloneDraft(BASE, 'Exists'), /already exists/);
  assert.deepEqual(snapshot(path.join(ROOT, 'Exists')), before);
});

test('rejects names that would escape the drafts folder', () => {
  for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', '']) {
    assert.throws(() => cloneDraft(BASE, bad), /invalid draft name/, `accepted: ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.existsSync(path.join(SANDBOX, 'evil')), false);
});

test('a missing base leaves nothing behind', () => {
  assert.throws(() => cloneDraft('Nope', 'From Nope'), /base draft not found/);
  assert.equal(fs.existsSync(path.join(ROOT, 'From Nope')), false);
  assert.deepEqual(fs.readdirSync(ROOT).filter(n => n.includes('From Nope')), []);
});
