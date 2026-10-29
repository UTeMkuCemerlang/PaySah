import {test} from 'node:test';
import {withFinalistEnvironment} from '../../scripts/finalist-environment.js';
import {demonstrateGate} from '../../scripts/demo-gate.js';

test('Finalist direct API gate, denied audit, order timeline and incremental activity isolation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 await withFinalistEnvironment(demonstrateGate);
});
