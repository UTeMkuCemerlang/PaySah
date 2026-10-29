import {mkdir,writeFile} from 'node:fs/promises';
import {detectBuildVersion} from './build-provenance.js';
const version=await detectBuildVersion();
await mkdir('dist/apps/api/src',{recursive:true});
await writeFile('dist/apps/api/src/build-version.json',JSON.stringify(version)+'\n');
console.log(`Build commit: ${version.commit} (source: ${version.source})`);
