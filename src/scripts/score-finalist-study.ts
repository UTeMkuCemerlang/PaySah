import {readFile} from 'node:fs/promises';
import {scoreStudy,parseStudyCsv} from './finalist-study-scoring.js';
if(process.argv.length!==3)throw Error('Usage: npm run score:finalist -- path/to/observed-records.json|.csv');
const text=await readFile(process.argv[2],'utf8');
console.log(JSON.stringify(scoreStudy(process.argv[2].toLowerCase().endsWith('.csv')?parseStudyCsv(text):JSON.parse(text)),null,2));
