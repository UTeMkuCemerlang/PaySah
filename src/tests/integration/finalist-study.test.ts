import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreStudy,parseStudyCsv} from '../../scripts/finalist-study-scoring.js';
test('study calculations retain negative gains, unmatched observations and failed tasks',()=>{
 const row={participant:'P01',case_id:'synthetic-calculation-only',pair_id:'pair1',commit:'a'.repeat(40),elapsed_seconds:200,manual_file_actions:2,correct:false,team_member:true};
 const records=[{...row,condition:'MANUAL',active_seconds:100},{...row,condition:'PAYSAH',active_seconds:140,manual_file_actions:0}];
 assert.equal(scoreStudy(records).active_time_reduction_percent,-40);assert.equal(scoreStudy(records).incorrect,2);
 assert.equal(scoreStudy(records.slice(0,1)).active_time_reduction_percent,null);
 assert.throws(()=>scoreStudy([...records,records[0]]),/Duplicate/);
 assert.throws(()=>scoreStudy([{...records[0],active_seconds:201}]),/Active/);
 assert.throws(()=>scoreStudy([]));
});
test('study CSV export scores the same as JSON and ignores extra note columns',()=>{
 const c='a'.repeat(40),csv=`﻿participant,pair_id,case_id,condition,commit,active_seconds,elapsed_seconds,manual_file_actions,correct,team_member,notes\r\nP01,pair1,U01,manual,${c},100,120,2,yes,TRUE,first\r\nP01,pair1,U01b,PAYSAH,${c},60,70,0,y,true,\r\n,,,,,,,,,,\r\n`;
 const rows=parseStudyCsv(csv);
 assert.equal(rows.length,2);assert.equal(scoreStudy(rows).active_time_reduction_percent,40);assert.equal(scoreStudy(rows).manual_file_actions,2);
 assert.throws(()=>scoreStudy(parseStudyCsv(csv.replace(',100,',',,'))));
});
