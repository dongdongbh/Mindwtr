#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const QUERY_STRING_VERSION = '7.1.3';
const DECODE_URI_COMPONENT_VERSION = '0.5.0';
const ORIGINAL_IMPORT = "const decodeComponent = require('decode-uri-component');";
const COMPATIBLE_IMPORT = [
  "const decodeComponentModule = require('decode-uri-component');",
  'const decodeComponent = decodeComponentModule.default ?? decodeComponentModule;',
].join('\n');

const readPackageMetadata = (packageDirectory) =>
  JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));

const resolvePackageDirectory = (packageName, paths) => {
  const entrypoint = require.resolve(packageName, { paths });
  return path.dirname(entrypoint);
};

const patchQueryString = (mobileDirectory = path.resolve(__dirname, '..')) => {
  const queryStringDirectory = resolvePackageDirectory('query-string', [mobileDirectory]);
  const queryStringMetadata = readPackageMetadata(queryStringDirectory);

  if (queryStringMetadata.version !== QUERY_STRING_VERSION) {
    throw new Error(
      `Expected query-string@${QUERY_STRING_VERSION}, found ${queryStringMetadata.version}`,
    );
  }

  const decoderDirectory = resolvePackageDirectory('decode-uri-component', [queryStringDirectory]);
  const decoderMetadata = readPackageMetadata(decoderDirectory);
  if (
    decoderMetadata.version !== DECODE_URI_COMPONENT_VERSION ||
    decoderMetadata.type !== 'module'
  ) {
    throw new Error(
      `Expected ESM decode-uri-component@${DECODE_URI_COMPONENT_VERSION}, found ${decoderMetadata.version}`,
    );
  }

  const queryStringEntrypoint = path.join(queryStringDirectory, 'index.js');
  const source = fs.readFileSync(queryStringEntrypoint, 'utf8');
  if (!source.includes(COMPATIBLE_IMPORT)) {
    const occurrences = source.split(ORIGINAL_IMPORT).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Expected one CommonJS decoder import in ${queryStringEntrypoint}, found ${occurrences}`,
      );
    }
    fs.writeFileSync(
      queryStringEntrypoint,
      source.replace(ORIGINAL_IMPORT, COMPATIBLE_IMPORT),
    );
  }

  delete require.cache[queryStringEntrypoint];
  const queryString = require(queryStringEntrypoint);
  const parsed = queryString.parse('screen=Inbox%20Today&tag=next');
  if (parsed.screen !== 'Inbox Today' || parsed.tag !== 'next') {
    throw new Error('query-string compatibility smoke returned unexpected values');
  }
};

if (require.main === module) {
  patchQueryString();
}

module.exports = { patchQueryString };
