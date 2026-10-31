import type {ReceiptFields} from '../../../../../packages/contracts/src/index.js';
import type {Config} from '../../config.js';
import {RunpodError,RunpodVisionExtractor,type VisionExtractor} from './runpod.js';

// Optional third reading of a receipt, only when the GPU and CPU readings disagree. It is advice for the Owner:
// it never changes the stored fields, a rule, a role or a payment, and its failure never stops the review.
export function createThirdReader(config:Config):VisionExtractor|undefined{
  if(!config.THIRD_READER_BASE_URL||!config.THIRD_READER_API_KEY||!config.THIRD_READER_MODEL)return undefined;
  const base=config.THIRD_READER_BASE_URL.replace(/\/+$/,'');
  // The extractor builds RunPod's /v2/<endpoint>/openai/v1/... URLs; map them onto this provider's /v1/... base.
  const rewrite:typeof fetch=(input,init)=>fetch(String(input).replace(/^.*?\/openai\/v1/,base),init);
  return new RunpodVisionExtractor({apiKey:config.THIRD_READER_API_KEY,endpointId:'third-reader',model:config.THIRD_READER_MODEL,timeoutMs:config.THIRD_READER_TIMEOUT_MS,fetch:rewrite});
}

export type ThirdReading={status:'OK';model:string;fields:Record<string,{gpu:unknown;cpu:unknown;third:unknown;supports:'GPU'|'CPU'|'NEITHER'}>}|{status:'UNAVAILABLE';reason:string};
const unread=(value:unknown)=>value===null||value==='UNKNOWN';

export async function readThird(reader:VisionExtractor|undefined,bytes:Buffer,mime:string,gpu:ReceiptFields,cpu:ReceiptFields,disputed:readonly (keyof ReceiptFields)[]):Promise<ThirdReading|undefined>{
  if(!reader||!disputed.length)return undefined;
  try{
    const result=await reader.extractFields(bytes,mime);
    return {status:'OK',model:result.model,fields:Object.fromEntries(disputed.map(key=>{
      const third=result.fields[key];
      return [key,{gpu:gpu[key],cpu:cpu[key],third,supports:unread(third)?'NEITHER' as const:third===gpu[key]?'GPU' as const:third===cpu[key]?'CPU' as const:'NEITHER' as const}];
    }))};
  }catch(e){return {status:'UNAVAILABLE',reason:e instanceof RunpodError?e.reason:'UNAVAILABLE'};}
}
