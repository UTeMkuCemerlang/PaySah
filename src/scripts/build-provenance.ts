import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export type GitSource={state:'clean'|'dirty'|'unavailable'|'unverifiable';commit?:string};
const valid=(value:string|undefined)=>!!value&&/^[0-9a-f]{40}$/.test(value);
export function resolveBuildVersion(input:{explicit?:string;git:GitSource;archive?:string}){
 const explicit=input.explicit?.trim();
 if(explicit)return valid(explicit)?{commit:explicit,source:'env' as const}:{commit:'unknown',source:'unknown' as const};
 if(input.git.state==='clean'&&valid(input.git.commit))return {commit:input.git.commit!,source:'git' as const};
 // An archive marker cannot prove that a dirty checkout still matches its SHA.
 if(input.git.state!=='unavailable')return {commit:'unknown',source:'unknown' as const};
 const archive=input.archive?.trim();
 return valid(archive)?{commit:archive!,source:'file' as const}:{commit:'unknown',source:'unknown' as const};
}
export async function detectBuildVersion(cwd=process.cwd(),explicit=process.env.PAYSAH_BUILD_COMMIT){
 let git:GitSource={state:'unavailable'};
 try{
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();
  git={state:'unverifiable',commit};
  try{git={state:execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim()?'dirty':'clean',commit};}catch{}
 }catch{}
 let archive:string|undefined;try{archive=await readFile(join(cwd,'.build-commit'),'utf8');}catch{}
 return resolveBuildVersion({explicit,git,archive});
}
