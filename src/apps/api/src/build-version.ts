import {readFileSync} from 'node:fs';
export function buildCommit(){
 try{const value=JSON.parse(readFileSync(new URL('./build-version.json',import.meta.url),'utf8')).commit;return typeof value==='string'&&/^[0-9a-f]{40}$/.test(value)?value:'unknown';}catch{return 'unknown';}
}
