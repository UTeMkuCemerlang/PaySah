// Pointer depth for the V5 glass look: cards lean toward the cursor and a spotlight follows it.
// Visual only. It writes CSS variables and two classes, never touches app state, and stays off for
// touch input, reduced motion and the no-blur fallback.
const tilted='.orders-overview>div:not(.overview-label),.next-task,.quick-guide,.login-card';
const lit=tilted+',.panel,.orders-surface';
const maxDeg=(el:Element)=>el.matches('.login-card,.quick-guide')?3:14;

function enabled(){
  return matchMedia('(hover:hover) and (pointer:fine)').matches&&!matchMedia('(prefers-reduced-motion:reduce)').matches&&!document.documentElement.hasAttribute('data-no-blur');
}

let active:HTMLElement|null=null,paper:HTMLElement|null=null,frame=0,last:PointerEvent|null=null;

function release(){
  if(!active)return;
  active.classList.remove('fx-tilt','fx-lit');active.style.removeProperty('--rx');active.style.removeProperty('--ry');
  active=null;
}

function update(){
  frame=0;const e=last;if(!e)return;
  const target=(e.target as Element|null)?.closest?.(lit) as HTMLElement|null;
  if(target!==active){release();active=target;}
  if(active){
    const r=active.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
    active.style.setProperty('--mx',`${(x*100).toFixed(1)}%`);active.style.setProperty('--my',`${(y*100).toFixed(1)}%`);active.classList.add('fx-lit');
    if(active.matches(tilted)){const d=maxDeg(active);active.style.setProperty('--rx',`${((.5-y)*d).toFixed(2)}deg`);active.style.setProperty('--ry',`${((x-.5)*d).toFixed(2)}deg`);active.classList.add('fx-tilt');}
  }
  // The login receipt follows the pointer across the whole window, like a parallax layer.
  if(!paper?.isConnected)paper=document.querySelector<HTMLElement>('.login-paper');
  if(paper){paper.style.setProperty('--rx',`${((.5-e.clientY/innerHeight)*10).toFixed(2)}deg`);paper.style.setProperty('--ry',`${((e.clientX/innerWidth-.5)*14).toFixed(2)}deg`);}
}

addEventListener('pointermove',e=>{
  if(e.pointerType!=='mouse'||!enabled()){release();return;}
  last=e;if(!frame)frame=requestAnimationFrame(update);
},{passive:true});
document.addEventListener('pointerleave',release);
addEventListener('blur',release);
