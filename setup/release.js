#!/usr/bin/env node
'use strict';

// Cuts a release: creates the GitHub release first, then has electron-builder
// upload into it.
//
//   npm run release
//
// Doing it in that order matters. Left to itself, electron-builder uploads the
// installer and the blockmap in parallel and each upload independently decides
// the release "doesn't exist" and creates it — which produced two releases per
// tag, one holding the installer and feed, the other holding only a blockmap.
// Creating the release up front removes the race.

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { version } = require('../package.json');
const TAG = `v${version}`;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();

function ghToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return sh('gh', ['auth', 'token']);
  } catch {
    return null;
  }
}

function main() {
  const token = ghToken();
  if (!token) {
    console.error('No GitHub token. Run `gh auth login`, or set GH_TOKEN with `repo` scope.');
    process.exit(1);
  }

  // Refuse to publish a version that is not committed and tagged, otherwise the
  // release points at a tree nobody can reproduce.
  const dirty = sh('git', ['status', '--porcelain']);
  if (dirty) {
    console.error('Working tree is dirty. Commit before releasing:\n' + dirty);
    process.exit(1);
  }
  let tagged = false;
  try {
    sh('git', ['rev-parse', '--verify', `refs/tags/${TAG}`], { stdio: 'pipe' });
    tagged = true;
  } catch {
    /* tag does not exist yet */
  }
  if (!tagged) {
    console.error(`No tag ${TAG}. Run \`npm version patch|minor|major\` first.`);
    process.exit(1);
  }

  console.log(`Releasing ${TAG}…`);
  sh('git', ['push', 'origin', 'main', '--follow-tags']);

  // Create the release up front if it is not already there.
  let exists = true;
  try {
    sh('gh', ['release', 'view', TAG], { stdio: 'pipe' });
  } catch {
    exists = false;
  }
  if (exists) {
    console.log(`  release ${TAG} already exists — uploading into it`);
  } else {
    sh('gh', ['release', 'create', TAG, '--title', version, '--generate-notes']);
    console.log(`  created release ${TAG}`);
  }

  const res = spawnSync('npx', ['electron-builder', '--publish', 'always'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, GH_TOKEN: token },
  });
  if (res.status !== 0) process.exit(res.status || 1);

  const assets = sh('gh', ['release', 'view', TAG, '--json', 'assets', '--jq', '[.assets[].name]']);
  console.log(`\nAssets on ${TAG}: ${assets}`);
  if (!assets.includes('latest.yml')) {
    console.error('WARNING: latest.yml is missing — installed copies will not see this update.');
    process.exit(1);
  }
  console.log('Installed copies will pick this up within six hours, or on next launch.');
}

main();
