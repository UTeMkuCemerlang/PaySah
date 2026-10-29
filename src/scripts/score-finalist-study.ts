import {readFile} from 'node:fs/promises';
import {scoreStudy} from './finalist-study-scoring.js';
if(process.argv.length!==3)throw Error('Usage: npm run score:finalist -- path/to/observed-records.json');
console.log(JSON.stringify(scoreStudy(JSON.parse(await readFile(process.argv[2],'utf8'))),null,2));
