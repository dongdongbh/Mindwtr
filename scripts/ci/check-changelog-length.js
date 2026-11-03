#!/usr/bin/env node


const fs = require('fs');
const path = require('path');

const MAX_CHARS = 500;

process.on('uncaughtException', (error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const metadataDir = path.resolve(process.env.METADATA_DIR || 'metadata');

const collectFiles = () => {
  const files = [];
  for (const locale of fs.readdirSync(metadataDir)) {
    const localeDir = path.join(metadataDir, locale);
    if (!fs.statSync(localeDir).isDirectory()) continue;
    const releaseNotes = path.join(localeDir, 'release_notes.txt');
    if (fs.existsSync(releaseNotes)) files.push(releaseNotes);
    const changelogDir = path.join(localeDir, 'changelogs');
    if (fs.existsSync(changelogDir) && fs.statSync(changelogDir).isDirectory()) {
      for (const name of fs.readdirSync(changelogDir)) {
        if (name.endsWith('.txt')) files.push(path.join(changelogDir, name));
      }
    }
  }
  return files;
};

const files = collectFiles();
if (files.length === 0) {
  throw new Error(`No changelog or release-notes files found under ${metadataDir}`);
}

const overLimit = [];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8').replace(/\s+$/u, '');
  const chars = [...content].length;
  if (chars > MAX_CHARS) {
    overLimit.push({ file: path.relative(process.cwd(), file), chars });
  }
}

if (overLimit.length > 0) {
  for (const entry of overLimit) {
    console.error(`::error file=${entry.file}::${entry.file} has ${entry.chars} characters; store changelogs are truncated at ${MAX_CHARS}.`);
  }
  process.exit(1);
}

console.log(`Checked ${files.length} store changelog/release-notes files; all within ${MAX_CHARS} characters.`);
