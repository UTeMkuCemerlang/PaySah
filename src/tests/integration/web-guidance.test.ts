import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guidanceFor,storyLine,type GuidanceInput} from '../../apps/web/src/guidance.js';

const base:GuidanceInput={payment_state:'UNPAID',fulfillment_state:'ON_HOLD',receipt:{extraction_state:'COMPLETED',fields_provider:'CPU_OCR'},current:true,eligible:false,required_role:'OWNER',flags:[],pending_approval:false,rejected:false,role:'CASHIER',owner_must_release:false};
const guide=(change:Partial<GuidanceInput>)=>guidanceFor({...base,...change});

test('every state names what is happening and the next step',()=>{
  assert.equal(guide({receipt:{extraction_state:'RUNNING',fields_provider:'CPU_OCR'}}).category,'Reading');
  assert.equal(guide({receipt:{extraction_state:'ERROR',fields_provider:'CPU_OCR'}}).category,'Reading failed');
  assert.equal(guide({flags:['RECIPIENT_UNCERTAIN','AMBIGUOUS_MATCH','BANK_NOT_FOUND']}).category,'Missing details');
  assert.equal(guide({flags:['BANK_NOT_FOUND']}).category,'No bank match');
  assert.equal(guide({flags:['PARTIAL_PAYMENT']}).category,'Evidence problem');
  assert.equal(guide({eligible:true,flags:['HIGH_VALUE']}).next,'Request Owner review.');
  assert.equal(guide({eligible:true,pending_approval:true}).category,'Waiting for the Owner');
  assert.equal(guide({eligible:true,pending_approval:true,role:'OWNER'}).category,'Owner decision');
  assert.equal(guide({rejected:true,current:false}).category,'Rejected');
  assert.equal(guide({payment_state:'PAID'}).category,'Waiting for release');
  assert.equal(guide({payment_state:'PAID',owner_must_release:true}).next,'Ask an Owner to release this order.');
  assert.equal(guide({fulfillment_state:'RELEASED',payment_state:'PAID'}).category,'Complete');
});

test('wording never says paid while evidence is blocked',()=>{
  for(const flags of [['BANK_NOT_FOUND'],['WRONG_RECIPIENT'],['MONEY_REQUEST'],['DUPLICATE_IMAGE'],['INVALID_RECEIPT'],['UNLISTED_CODE']]){
    const words=guide({flags});assert.equal(words.tone,'fix');assert.doesNotMatch(words.next,/confirm payment|approve/i);
  }
});

test('order story is readable and drops repeats',()=>{
  const event=(action:string,actor_name='Demo Owner',payload={})=>({action,actor_name,payload});
  assert.deepEqual(storyLine([event('order.created'),event('receipt.image_saved'),event('receipt.extracted'),event('approval.requested','Demo Cashier'),event('approval.decided','Demo Owner',{decision:'APPROVED'}),event('payment.confirmed'),event('fulfillment.released')]),['Order created','Receipt received','Demo Cashier requested Owner review','Demo Owner approved','Payment confirmed','Demo Owner released the order']);
  assert.deepEqual(storyLine([event('verification.completed'),event('verification.completed')]),['Evidence checked']);
});
