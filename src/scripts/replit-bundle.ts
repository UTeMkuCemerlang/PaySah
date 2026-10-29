import {cp,mkdir,rm,stat,writeFile} from 'node:fs/promises';
import {detectBuildVersion} from './build-provenance.js';
import {spawnSync} from 'node:child_process';
import {resolve,join,sep,basename} from 'node:path';
import assert from 'node:assert/strict';

// Builds .local/replit-bundle/paysah-source.zip for upload to a Replit project when there is no Git remote yet.
// Same source allowlist as verify:clean; only synthetic study/tasks.json from evaluation.
// Never .env, .local, reference, participant feedback, node_modules or dist.
const out=resolve('.local','replit-bundle'),stage=join(out,'paysah'),zip=join(out,'paysah-source.zip');
const version=await detectBuildVersion();
assert.notEqual(version.commit,'unknown','Cannot package unidentified source; commit clean code or explicitly provide PAYSAH_BUILD_COMMIT');
assert.ok(out.startsWith(resolve('.local')+sep)&&basename(out)==='replit-bundle');
await rm(out,{recursive:true,force:true});await mkdir(stage,{recursive:true});
for(const directory of ['apps','packages','db','scripts','tests','fixtures','integrations'])await cp(resolve(directory),join(stage,directory),{recursive:true});
for(const file of ['package.json','package-lock.json','tsconfig.json','.env.example','.replit','README.md','LICENSE'])await cp(resolve(file),join(stage,file));
// Flat app archive: this marker lives at src/.build-commit in a full checkout.
await writeFile(join(stage,'.build-commit'),version.commit+'\n');
await mkdir(join(stage,'evaluation/study'),{recursive:true});
await cp(resolve('evaluation/study/tasks.json'),join(stage,'evaluation/study/tasks.json'));
// Windows' own bsdtar writes zip with -a (Git Bash's GNU tar cannot, so call it by full path); elsewhere use zip.
const windowsTar=join(process.env.SystemRoot??'C:\\Windows','System32','tar.exe');
const result=process.platform==='win32'?spawnSync(windowsTar,['-a','-c','-f',zip,'-C',out,'paysah'],{stdio:'inherit'}):spawnSync('zip',['-qr',zip,'paysah'],{cwd:out,stdio:'inherit'});
assert.equal(result.status,0,'zip failed');
await rm(stage,{recursive:true,force:true});
console.log(`Bundle: ${zip} (${Math.round((await stat(zip)).size/1024)} KiB), source ${version.commit} (${version.source}). Upload it to the Replit project, then in the Shell: unzip paysah-source.zip && cp -r paysah/. . && rm -r paysah paysah-source.zip`);
