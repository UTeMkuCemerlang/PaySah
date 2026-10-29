import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
let commit='unknown';
try{
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 const dirty=execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8',windowsHide:true}).trim();
 if(!dirty&&/^[0-9a-f]{40}$/.test(sha))commit=sha;
}catch{}
await mkdir('dist/apps/api/src',{recursive:true});
await writeFile('dist/apps/api/src/build-version.json',JSON.stringify({commit})+'\n');
console.log(`Build commit: ${commit}`);
