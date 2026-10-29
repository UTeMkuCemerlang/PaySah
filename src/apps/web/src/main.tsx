import React,{lazy,Suspense,useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ApiClient,errorMessage} from './api.js';
import {useResource} from './hooks.js';
import {Login,Orders,NewOrder,Approvals,Activity} from './pages.js';
import {OrderDetail} from './review.js';
import {text} from './copy.js';
import type {Actor,Session,Health} from './types.js';
import './style.css';
import './v4.css';
import './v5.css';
import './v6.css';
import './effects.js';

const Story=lazy(()=>import('./story/StoryPage.js'));

const tokenKey='paysah.demo.session';
function storedToken(){try{return sessionStorage.getItem(tokenKey);}catch{return null;}}
function saveToken(token:string|null){try{if(token)sessionStorage.setItem(tokenKey,token);else sessionStorage.removeItem(tokenKey);}catch{}}
function useRoute(){const [route,setRoute]=useState(location.hash.slice(1)||'orders');useEffect(()=>{const change=()=>setRoute(location.hash.slice(1)||'orders');addEventListener('hashchange',change);return()=>removeEventListener('hashchange',change);},[]);return route;}
function App(){
  const route=useRoute();
  const [session,setSession]=useState<Session|null>(null),[restoring,setRestoring]=useState(true),[message,setMessage]=useState('');
  const health=useResource(s=>new ApiClient('').get<Health>('/health',s),[]);
  useEffect(()=>{
    const token=storedToken(),controller=new AbortController();
    if(!token){setRestoring(false);return;}
    new ApiClient(token).get<{actor:Actor}>('/session',controller.signal).then(result=>{if(!controller.signal.aborted)setSession({token,actor:result.actor});}).catch(e=>{if(!controller.signal.aborted){saveToken(null);setMessage(errorMessage(e));}}).finally(()=>{if(!controller.signal.aborted)setRestoring(false);});
    return()=>controller.abort();
  },[]);
  const api=useMemo(()=>new ApiClient(session?.token??'',()=>{
    const old=session?.token;setSession(current=>current?.token===old?null:current);if(storedToken()===old)saveToken(null);setMessage('Your session expired. Choose an account to continue.');
  }),[session?.token]);
  async function logout(){let notice='';try{await api.logout();}catch{notice='Signed out of this tab. The server could not close the previous session; it will expire automatically.';}saveToken(null);setSession(null);setMessage(notice);location.hash='orders';}
  if(route==='story')return <Suspense fallback={<main className="restoring" role="status">Opening the PaySah story… <a href="#orders">Open workspace</a></main>}><Story/></Suspense>;
  if(restoring)return <main className="restoring" role="status"><span className="brand-symbol">p</span>Opening your workspace…</main>;
  if(!session)return <Login message={message} onLogin={next=>{saveToken(next.token);setSession(next);setMessage('');location.hash='orders';}}/>;
  return <Workspace key={session.token} api={api} actor={session.actor} health={health.value} logout={logout}/>;
}
function Workspace({api,actor,health,logout}:{api:ApiClient;actor:Actor;health?:Health;logout:()=>Promise<void>}){
  const route=useRoute(),[leaving,setLeaving]=useState(false);
  const orderId=/^orders\/([a-f0-9-]{36})$/i.exec(route)?.[1];
  const active=route.startsWith('orders')?'orders':route;
  const mode=!health?'Receipt mode unavailable':health.extractor_mode==='cpu_ocr'?'CPU receipt reading':health.extractor_mode==='runpod'?'GPU receipt reading (RunPod, CPU fallback)':health?.extractor_mode==='manual'?'Manual fields':'Predefined demo fields';
  useEffect(()=>{window.scrollTo({top:0});},[route]);
  return <div className="app-shell">
    <a className="skip-link" href="#workspace-content" onClick={e=>{e.preventDefault();document.getElementById('workspace-content')?.focus();}}>Skip to content</a>
    <header className="app-header"><a className="brand" href="#orders"><span className="brand-symbol" aria-hidden="true">p</span>PaySah</a>
      <nav className="main-nav" aria-label="Main navigation">{[['orders',text.orders],...(actor.role==='OWNER'?[['approvals',text.approvals]]:[]),['activity',text.activity]].map(([key,name],index)=><a key={key} className={active===key?'active':''} aria-current={active===key?'page':undefined} href={`#${key}`}><span aria-hidden="true">{['▤','◇','◷'][index]}</span>{name}</a>)}</nav><a className="story-entry" href="#story">The PaySah story <span aria-hidden="true">↗</span></a>
      <div className="account-menu"><div><strong>{actor.display_name}</strong><span>{actor.role==='OWNER'?'Owner':'Cashier'}</span></div><button className="button ghost small" disabled={leaving} onClick={async()=>{setLeaving(true);await logout();setLeaving(false);}}>{leaving?'Signing out…':text.switchAccount}</button><span className="account-avatar" aria-hidden="true">{actor.role==='OWNER'?'O':'C'}</span></div>
    </header>
    <div className="workspace"><div className="workspace-meta"><span className="demo-pill">Synthetic demo</span><span className="mode-label"><span className={`mode-dot ${health?'available':'unknown'}`} aria-hidden="true"/>{mode}</span><span className="workspace-region">MYR · Malaysia</span></div>
      <main className="workspace-content" id="workspace-content" tabIndex={-1}>{orderId?<OrderDetail key={orderId} api={api} actor={actor} id={orderId}/>:route==='orders/new'?<NewOrder api={api}/>:route==='approvals'?<Approvals api={api} actor={actor}/>:route==='activity'?<Activity api={api} actor={actor}/>:<Orders api={api}/>}</main>
      <footer className="workspace-footer">Synthetic information only · No real payments · Times in MYT</footer>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
