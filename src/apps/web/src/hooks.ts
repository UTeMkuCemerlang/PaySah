import {useEffect,useState,type DependencyList} from 'react';
export function useResource<T>(load:(signal:AbortSignal)=>Promise<T>,deps:DependencyList,pollMs=0){
  const [value,setValue]=useState<T>(),[error,setError]=useState<unknown>(),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0),[updatedAt,setUpdatedAt]=useState<string>();
  useEffect(()=>{
    let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,stopped=false,failures=0,running=false;
    async function fetchValue(initial=false){
      if(stopped||running||(!initial&&document.hidden))return;
      running=true;controller=new AbortController();if(initial)setLoading(true);
      try{const data=await load(controller.signal);if(!stopped&&!controller.signal.aborted){setValue(data);setUpdatedAt(new Date().toISOString());setError(undefined);failures=0;}}
      catch(e){if(!stopped&&!controller.signal.aborted){setError(e);failures++;}}
      finally{running=false;if(!stopped){setLoading(false);if(pollMs&&!document.hidden)timer=setTimeout(()=>void fetchValue(),Math.min(pollMs*2**Math.min(failures,3),60000));}}
    }
    const visibility=()=>{clearTimeout(timer);if(document.hidden)controller?.abort();else if(!running)void fetchValue();else timer=setTimeout(()=>void fetchValue(),pollMs);};
    if(pollMs)document.addEventListener('visibilitychange',visibility);
    void fetchValue(true);
    return()=>{stopped=true;controller?.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
  },[...deps,revision,pollMs]);
  return {value,error,loading,updatedAt,refresh:()=>setRevision(n=>n+1)};
}
