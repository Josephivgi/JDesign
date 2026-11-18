"use strict";

// The motion kit every code animation gets as window.JV. Authors can write
// CSS only and still stagger letters (data-split), or script with eases,
// springs, keyframes and counters without pasting a library into every job.
//
// It also makes Math.random repeatable. Long renders are split across
// several worker windows (lib/html-render.js), each loading the page on its
// own; an unseeded Math.random gave every worker different particles, so the
// picture jumped at each shard boundary. A fixed seed gives every window the
// same sequence. JV.random(seed) makes a separate stream.

const MOTION_RUNTIME = String.raw`(function(){
var seedState=0x9e3779b9;
function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
try{Math.random=mulberry(seedState);}catch(e){}
// Each seek restarts the sequence from a seed mixed with the frame time, so a
// Math.random() inside drawAt gives the same values for the same frame in
// every render window (shards start at different frames).
window.__jvReseed=function(t){try{Math.random=mulberry((seedState^Math.imul((Math.round(Number(t)||0)+1)|0,0x85ebca6b))|0);}catch(e){}};
var c1=1.70158,c2=c1*1.525,c3=c1+1,c4=(2*Math.PI)/3;
function bounceOut(x){var n=7.5625,d=2.75;if(x<1/d)return n*x*x;if(x<2/d)return n*(x-=1.5/d)*x+0.75;if(x<2.5/d)return n*(x-=2.25/d)*x+0.9375;return n*(x-=2.625/d)*x+0.984375;}
var ease={
linear:function(x){return x;},
inSine:function(x){return 1-Math.cos((x*Math.PI)/2);},outSine:function(x){return Math.sin((x*Math.PI)/2);},inOutSine:function(x){return -(Math.cos(Math.PI*x)-1)/2;},
inQuad:function(x){return x*x;},outQuad:function(x){return 1-(1-x)*(1-x);},inOutQuad:function(x){return x<0.5?2*x*x:1-Math.pow(-2*x+2,2)/2;},
inCubic:function(x){return x*x*x;},outCubic:function(x){return 1-Math.pow(1-x,3);},inOutCubic:function(x){return x<0.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;},
outQuart:function(x){return 1-Math.pow(1-x,4);},inOutQuart:function(x){return x<0.5?8*x*x*x*x:1-Math.pow(-2*x+2,4)/2;},
outQuint:function(x){return 1-Math.pow(1-x,5);},
inExpo:function(x){return x===0?0:Math.pow(2,10*x-10);},outExpo:function(x){return x===1?1:1-Math.pow(2,-10*x);},
inOutExpo:function(x){return x===0?0:x===1?1:x<0.5?Math.pow(2,20*x-10)/2:(2-Math.pow(2,-20*x+10))/2;},
outCirc:function(x){return Math.sqrt(1-Math.pow(x-1,2));},
inBack:function(x){return c3*x*x*x-c1*x*x;},outBack:function(x){return 1+c3*Math.pow(x-1,3)+c1*Math.pow(x-1,2);},
inOutBack:function(x){return x<0.5?(Math.pow(2*x,2)*((c2+1)*2*x-c2))/2:(Math.pow(2*x-2,2)*((c2+1)*(x*2-2)+c2)+2)/2;},
outElastic:function(x){return x===0?0:x===1?1:Math.pow(2,-10*x)*Math.sin((x*10-0.75)*c4)+1;},
outBounce:bounceOut
};
function pick(e){return typeof e==="function"?e:ease[e]||ease.outCubic;}
function clamp(v,a,b){return v<a?a:v>b?b:v;}
function lerp(a,b,p){return a+(b-a)*p;}
function progress(t,start,dur,e){var p=dur>0?clamp((t-start)/dur,0,1):t>=start?1:0;return pick(e||"linear")(p);}
function tween(t,start,dur,from,to,e){return lerp(from,to,progress(t,start,dur,e||"outCubic"));}
function map(v,a,b,c,d,noClamp){var p=b===a?0:(v-a)/(b-a);if(!noClamp)p=clamp(p,0,1);return c+(d-c)*p;}
function spring(t,start,o){o=o||{};var k=o.stiffness||170,dmp=o.damping||26,m=o.mass||1;var s=Math.max(0,(t-start)/1000);if(s<=0)return 0;
var w0=Math.sqrt(k/m),z=dmp/(2*Math.sqrt(k*m));
if(z<1){var wd=w0*Math.sqrt(1-z*z);return 1-Math.exp(-z*w0*s)*(Math.cos(wd*s)+(z*w0/wd)*Math.sin(wd*s));}
return 1-Math.exp(-w0*s)*(1+w0*s);}
function keyframes(t,frames,e){if(!frames||!frames.length)return 0;if(t<=frames[0][0])return frames[0][1];
for(var i=1;i<frames.length;i++){var a=frames[i-1],b=frames[i];if(t<=b[0]){var p=(t-a[0])/((b[0]-a[0])||1);return lerp(a[1],b[1],pick(b[2]||e||"inOutCubic")(p));}}
return frames[frames.length-1][1];}
function stagger(i,each,from){return (from||0)+i*(each==null?60:each);}
function fmt(n,dec){var s=Number(n).toFixed(dec||0);var parts=s.split(".");parts[0]=parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,",");return parts.join(".");}
function count(t,start,dur,to,o){o=o||{};return (o.prefix||"")+fmt(tween(t,start,dur,o.from||0,to,o.ease||"outExpo"),o.decimals)+(o.suffix||"");}
function split(target,mode){
var els=typeof target==="string"?Array.prototype.slice.call(document.querySelectorAll(target)):target&&target.length!=null?Array.prototype.slice.call(target):target?[target]:[];
var all=[];
els.forEach(function(el){if(el.__jvSplit)return;el.__jvSplit=true;var m=mode||el.getAttribute("data-split")||"chars";var text=el.textContent;el.setAttribute("aria-label",text);el.textContent="";
var words=text.split(/(\s+)/);var i=0,w=0;
words.forEach(function(word){if(!word)return;if(/^\s+$/.test(word)){el.appendChild(document.createTextNode(word));return;}
var ws=document.createElement("span");ws.className="jv-word";ws.style.setProperty("--w",w++);ws.style.display="inline-block";ws.style.whiteSpace="nowrap";
if(m==="words"){ws.style.setProperty("--i",i++);ws.textContent=word;all.push(ws);}
else{Array.from(word).forEach(function(ch){var s=document.createElement("span");s.className="jv-char";s.style.display="inline-block";s.style.setProperty("--i",i++);s.textContent=ch;ws.appendChild(s);all.push(s);});}
el.appendChild(ws);});
el.style.setProperty("--n",i);});
return all;}
function random(seed){return mulberry(seed==null?1:seed);}
window.JV={ease:ease,clamp:clamp,lerp:lerp,map:map,progress:progress,tween:tween,spring:spring,keyframes:keyframes,stagger:stagger,count:count,format:fmt,split:split,random:random};
function auto(){try{split("[data-split]");}catch(e){}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",auto);else auto();
})();`;

module.exports = { MOTION_RUNTIME };
