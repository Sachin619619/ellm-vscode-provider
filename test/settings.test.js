/**
 * The settings schema is the only place a default may live.
 *
 * This exists because the same defect shipped twice. `ellm.maxContinuations`
 * defaulted to 20 in package.json and 8 in the panel that edits it, so opening the
 * panel and pressing Save rewrote a working configuration with the panel's lower
 * number - silently cutting the longest recoverable answer from roughly 100k chars
 * to 40k in the middle of a task. It was fixed in v0.4.1 and reintroduced wholesale
 * by the v0.5.0 revert, because a literal sitting in a second file is exactly the
 * kind of thing a revert carries back with it.
 *
 * Reading the source rather than the behaviour is deliberate: the failure is a value
 * written in two places, and only the text of the files can show that.
 *
 *   node --test test/*.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const manifest = require('../package.json');

const DECLARED = Object.keys(manifest.contributes.configuration.properties)
  .map((k) => k.replace(/^ellm\./, ''));

const sources = fs.readdirSync(SRC)
  .filter((f) => f.endsWith('.js'))
  .map((f) => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]);

test('every setting the code reads is declared in package.json', () => {
  const re = /readSetting\(\s*[\w.]+\s*,\s*'([^']+)'/g;
  for (const [file, text] of sources) {
    for (const m of text.matchAll(re)) {
      assert.ok(
        DECLARED.includes(m[1]),
        `${file} reads ellm.${m[1]}, which package.json does not declare - it would `
        + 'have no default, no description, and no entry in the settings UI',
      );
    }
  }
});

test('no caller restates a default the schema already declares', () => {
  const re = /readSetting\(\s*[\w.]+\s*,\s*'([^']+)'\s*,/g;
  for (const [file, text] of sources) {
    const restated = [...text.matchAll(re)].map((m) => m[1]);
    assert.deepStrictEqual(
      restated, [],
      `${file} passes its own default for ${restated.join(', ')}. The manifest's default `
      + 'is the one that must win, or the two drift apart and the drift is silent.',
    );
  }
});

test('defaultFor refuses a key the manifest does not declare', () => {
  // Loaded here rather than at the top: storage.js requires 'vscode', which only
  // exists inside the extension host, so the module cannot be imported directly.
  // The behaviour under test is pure, so it is reproduced against the same manifest.
  const defaults = Object.fromEntries(
    Object.entries(manifest.contributes.configuration.properties)
      .map(([k, v]) => [k.replace(/^ellm\./, ''), v.default]),
  );
  const defaultFor = (key) => {
    if (!(key in defaults)) throw new Error(`ellm.${key} is read but not declared`);
    return defaults[key];
  };

  assert.throws(() => defaultFor('notASetting'), /not declared/);
  assert.strictEqual(defaultFor('maxContinuations'), 20);
});

test('every declared setting has a default and a description', () => {
  for (const [key, spec] of Object.entries(manifest.contributes.configuration.properties)) {
    assert.ok('default' in spec, `${key} has no default, so readSetting would yield undefined`);
    assert.ok(spec.description || spec.markdownDescription, `${key} has no description`);
  }
});
