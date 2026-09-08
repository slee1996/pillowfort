#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('agent-package.json', root), 'utf8'));
const metadataResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
if (!metadataResponse.ok) throw new Error('Published agent release metadata is unavailable; publish the version before deploying its download.');
const metadata = await metadataResponse.json();
if (metadata.name !== manifest.name || metadata.version !== manifest.version || !metadata.dist?.integrity?.startsWith('sha512-')) throw new Error('Unexpected published release metadata.');
const url = new URL(metadata.dist.tarball);
if (url.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected release artifact origin.');
const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
if (!response.ok) throw new Error('Published agent artifact is unavailable.');
const bytes = Buffer.from(await response.arrayBuffer());
if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== metadata.dist.integrity) throw new Error('Published agent integrity mismatch.');
const filename = `pillowfort-agent-${manifest.version}.tgz`;
const directory = new URL('marketing/public/downloads/', root);
await mkdir(directory, { recursive: true });
await writeFile(new URL(filename, directory), bytes);
await writeFile(new URL(filename + '.sha256', directory), createHash('sha256').update(bytes).digest('hex') + '  ' + filename + '\n');
console.log(`Mirrored immutable npm release ${manifest.name}@${manifest.version}.`);
