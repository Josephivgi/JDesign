"use strict";

// Ready-made code animations. Each preset is a small, finished design an
// agent can render as is or use as the starting code and change: the result
// is plain html, css and js for jeditor_render_animation, nothing hidden.
//
// Sizes are in vmin so one preset reads well at 16/9, 9/16, 1/1 and 4/5.
// Colors come from the render's colors ({primary, secondary, text} become
// var(--primary), var(--secondary), var(--text)), so a brand palette applies
// without touching the code. Text params are escaped; nothing loads from the
// network.

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function str(value, fallback, max) {
  const text = String(value == null ? "" : value).trim();
  return (text || fallback).slice(0, max || 120);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback, max) {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[|,\n]/) : [];
  const out = arr.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "" && x != null);
  return (out.length ? out : fallback).slice(0, max || 8);
}

const FULL = "html,body{background:var(--primary)}.stage{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden;color:var(--text)}";

const PRESETS = {
  "kinetic-title": {
    label: "Kinetic title",
    description: "A big headline whose letters rise in one after another, a subtitle that fades up, and an accent bar that wipes under it. For intros and title cards.",
    durationMs: 3500,
    minMs: 2200,
    params: { title: "Headline, 1 to 4 words", subtitle: "Short line under it (optional)" },
    build(p, ctx) {
      const titleText = str(p.title, "Make it move", 60);
      const title = esc(titleText);
      const subtitle = esc(str(p.subtitle, "", 90));
      // Each letter rises over 0.7 s, so the last one has to start early enough
      // to land inside the clip: a long headline gets a shorter stagger instead
      // of an entrance that is cut off (0.045 was fixed, and 63 characters then
      // needed 3.7 s at any length).
      const step = Math.max(12, Math.min(45, Math.floor((ctx.durationMs - 1200) / Math.max(1, titleText.length))));
      const riseEnd = 200 + Math.max(0, titleText.length - 1) * step + 700;
      // The rule and the subtitle follow the headline instead of racing it.
      const barDelay = Math.max(900, riseEnd - 500);
      const subDelay = Math.max(1250, riseEnd - 350);
      return {
        html:
          '<div class="stage"><div class="wrap">' +
          '<h1 data-split="chars">' + title + "</h1>" +
          '<div class="bar"></div>' +
          (subtitle ? '<p class="sub">' + subtitle + "</p>" : "") +
          "</div></div>",
        css:
          FULL +
          ".wrap{text-align:center;padding:0 8vmin;max-width:100%}" +
          "h1{margin:0;font:800 13vmin/1 'Segoe UI',system-ui,sans-serif;letter-spacing:-0.03em}" +
          ".jv-char{opacity:0;transform:translateY(0.6em) rotate(6deg);animation:rise .7s cubic-bezier(.2,.9,.25,1.2) both;animation-delay:calc(200ms + var(--i) * " + step + "ms)}" +
          "@keyframes rise{to{opacity:1;transform:none}}" +
          ".bar{height:1.2vmin;width:34vmin;margin:3.2vmin auto 0;background:var(--secondary);border-radius:1vmin;transform:scaleX(0);transform-origin:left;animation:wipe .6s cubic-bezier(.65,0,.35,1) " + barDelay + "ms both}" +
          "@keyframes wipe{to{transform:scaleX(1)}}" +
          ".sub{margin:3vmin 0 0;font:500 4.4vmin/1.3 'Segoe UI',system-ui,sans-serif;opacity:0;transform:translateY(2vmin);animation:up .6s ease-out " + subDelay + "ms both;color:var(--text)}" +
          "@keyframes up{from{opacity:0;transform:translateY(2vmin)}to{opacity:.85;transform:none}}",
        js: "",
      };
    },
  },

  "logo-sting": {
    label: "Logo sting",
    description: "A short brand sting: a ring bursts out with sparks, the name punches in, the tagline settles under it. For the first or last 3 seconds of a video.",
    durationMs: 3000,
    minMs: 2000,
    params: { text: "Brand or channel name", tagline: "Short tagline (optional)" },
    build(p) {
      const text = esc(str(p.text, "JV", 30));
      const tagline = esc(str(p.tagline, "", 60));
      return {
        html:
          '<div class="stage"><div class="halo"></div><canvas id="fx"></canvas><div class="ring"></div><div class="ring2"></div>' +
          '<div class="mark"><div class="name">' + text + "</div>" +
          (tagline ? '<div class="tag">' + tagline + "</div>" : "") +
          "</div></div>",
        css:
          FULL +
          "#fx{position:absolute;inset:0;width:100%;height:100%}" +
          ".ring{position:absolute;width:30vmin;height:30vmin;border-radius:50%;border:1.4vmin solid var(--secondary);opacity:0;animation:ring 1.1s cubic-bezier(.2,.8,.2,1) .15s both}" +
          "@keyframes ring{0%{opacity:1;transform:scale(.2)}70%{opacity:.9}100%{opacity:0;transform:scale(2.4)}}" +
          ".ring2{position:absolute;width:44vmin;height:44vmin;border-radius:50%;border:.5vmin solid var(--secondary);opacity:0;transform:scale(.6);animation:settle .9s cubic-bezier(.2,.9,.3,1.2) .6s both}" +
          "@keyframes settle{to{opacity:.45;transform:none}}" +
          ".halo{position:absolute;width:90vmin;height:90vmin;border-radius:50%;background:radial-gradient(circle,color-mix(in oklab,var(--secondary) 35%,transparent),transparent 62%);opacity:0;animation:halo 1.2s ease-out .4s both}" +
          "@keyframes halo{to{opacity:1}}" +
          ".mark{position:relative;text-align:center}" +
          ".name{font:900 16vmin/1 'Segoe UI',system-ui,sans-serif;letter-spacing:-0.04em;opacity:0;transform:scale(1.6);filter:blur(2vmin);animation:punch .55s cubic-bezier(.2,.9,.3,1.1) .45s both}" +
          "@keyframes punch{to{opacity:1;transform:none;filter:none}}" +
          ".tag{margin-top:2.4vmin;font:600 3.8vmin/1.2 'Segoe UI',system-ui,sans-serif;letter-spacing:.32em;text-transform:uppercase;color:var(--secondary);opacity:0;animation:tag .6s ease-out 1.05s both}" +
          "@keyframes tag{from{opacity:0;letter-spacing:.7em}to{opacity:1;letter-spacing:.32em}}",
        js:
          "var c=document.getElementById('fx'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;" +
          "var sec=getComputedStyle(document.body).getPropertyValue('--secondary').trim()||'#fff';" +
          "var R=JV.random(7),parts=[];for(var i=0;i<46;i++){parts.push({a:R()*Math.PI*2,v:0.35+R()*0.65,s:5+R()*9});}" +
          "window.drawAt=function(t){x.clearRect(0,0,c.width,c.height);var m=Math.min(c.width,c.height);" +
          "var p=JV.progress(t,200,1300,'outCubic');if(p<=0||p>=1)return;x.fillStyle=sec;x.globalAlpha=1-p;" +
          "for(var i=0;i<parts.length;i++){var q=parts[i],r=m*0.12+q.v*m*0.42*p;x.beginPath();x.arc(c.width/2+Math.cos(q.a)*r,c.height/2+Math.sin(q.a)*r,q.s*(1-p*0.6)*m/1080,0,Math.PI*2);x.fill();}x.globalAlpha=1;};",
      };
    },
  },

  "lower-third": {
    label: "Lower third",
    description: "A name and role bar that slides in at the bottom left, holds, and slides out. Renders on the brand color; to show it over footage, put the same html and css on an overlay card and drop the .bg element.",
    about: "A name and role bar that slides in at the bottom left, holds, and slides out. For introducing a speaker.",
    durationMs: 4500,
    minMs: 2400,
    params: { name: "Person or topic", role: "Role or detail (optional)" },
    build(p, ctx) {
      const name = esc(str(p.name, "Alex Rivera", 40));
      // The bar leaves 0.7 s before the end, whatever the length.
      const outAt = Math.max(1600, ctx.durationMs - 700);
      const role = esc(str(p.role, "", 60));
      return {
        html:
          '<div class="bg"></div><div class="lt"><div class="plate"><div class="accent"></div><div class="txt"><div class="name">' + name + "</div>" +
          (role ? '<div class="role">' + role + "</div>" : "") +
          "</div></div></div>",
        css:
          // The backdrop is its own element, so the same html and css on an
          // overlay card shows only the bar over footage (delete .bg there).
          ".bg{position:absolute;inset:0;background:radial-gradient(120% 90% at 20% 100%, color-mix(in oklab, var(--secondary) 22%, var(--primary)), var(--primary))}" +
          ".lt{position:absolute;left:6vmin;bottom:max(12vmin,18vh);animation:out .5s cubic-bezier(.7,0,.84,0) " + outAt + "ms both}" +
          "@keyframes out{to{opacity:0;transform:translateX(-6vmin)}}" +
          ".plate{display:flex;align-items:stretch;background:rgba(10,12,20,.82);border-radius:1.4vmin;overflow:hidden;clip-path:inset(0 100% 0 0);animation:open .7s cubic-bezier(.16,1,.3,1) .2s both}" +
          "@keyframes open{to{clip-path:inset(0 0 0 0)}}" +
          ".accent{width:1.4vmin;background:var(--secondary)}" +
          ".txt{padding:2.2vmin 3.6vmin 2.4vmin 2.6vmin;color:#fff}" +
          ".name{font:750 5.2vmin/1.1 'Segoe UI',system-ui,sans-serif;opacity:0;transform:translateY(1.4vmin);animation:in .5s ease-out .55s both}" +
          ".role{margin-top:.8vmin;font:500 3vmin/1.2 'Segoe UI',system-ui,sans-serif;opacity:0;animation:in .5s ease-out .75s both;color:rgba(255,255,255,.78)}" +
          "@keyframes in{to{opacity:1;transform:none}}",
        js: "",
      };
    },
  },

  "counter-stat": {
    label: "Counter stat",
    description: "A big number that counts up with a ring filling around it and a label under it. For one striking statistic.",
    durationMs: 3500,
    minMs: 2500,
    params: { value: "Number to count to", label: "What the number means", prefix: "Before the number, like $", suffix: "After the number, like % or K" },
    build(p) {
      // Agents pass "1,200" or "$2.5" as often as 1200: keep only the number.
      const raw = String(p.value == null ? "" : p.value).replace(/[^0-9.\-]/g, "");
      const value = num(raw === "" ? NaN : raw, 1000000);
      const decimals = Math.min(2, Math.max(0, (raw.split(".")[1] || "").length));
      const label = esc(str(p.label, "people reached", 60));
      // "$2,450,000" or "98%" carry their own symbols when no prefix or
      // suffix is given.
      const given = String(p.value == null ? "" : p.value).trim();
      const prefix = str(p.prefix, (given.match(/^[^\d.\-]+/) || [""])[0].trim(), 6);
      const suffix = str(p.suffix, (given.match(/[^\d.,\s]+$/) || [""])[0].trim(), 6);
      // The final text sets the type size so the longest number still fits
      // inside the ring.
      const finalText = prefix + Number(value).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suffix;
      const fontVmin = Math.min(12, Math.max(5, 46 / Math.max(1, finalText.length * 0.6)));
      return {
        html:
          '<div class="stage"><div class="box"><svg viewBox="0 0 200 200" class="ring"><circle cx="100" cy="100" r="88" class="track"/><circle cx="100" cy="100" r="88" class="fill" id="arc"/></svg>' +
          '<div class="num" id="num">0</div></div><div class="label">' + label + "</div></div>",
        css:
          FULL +
          ".stage{grid-template-rows:auto auto;align-content:center;gap:4vmin}" +
          ".box{position:relative;width:62vmin;height:62vmin;display:grid;place-items:center}" +
          ".ring{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}" +
          ".track{fill:none;stroke:color-mix(in oklab,var(--text) 14%,transparent);stroke-width:10}" +
          ".fill{fill:none;stroke:var(--secondary);stroke-width:10;stroke-linecap:round;stroke-dasharray:553;stroke-dashoffset:553}" +
          ".num{font:850 " + fontVmin.toFixed(2) + "vmin/1 'Segoe UI',system-ui,sans-serif;letter-spacing:-0.03em;font-variant-numeric:tabular-nums}" +
          ".label{font:600 4.6vmin/1.2 'Segoe UI',system-ui,sans-serif;text-align:center;opacity:0;animation:up .6s ease-out 1.6s both;max-width:80vw}" +
          "@keyframes up{from{opacity:0;transform:translateY(2vmin)}to{opacity:.9;transform:none}}",
        js:
          "var V=" + JSON.stringify(value) + ",D=" + decimals + ",PRE=" + JSON.stringify(prefix) + ",SUF=" + JSON.stringify(suffix) + ";" +
          "var n=document.getElementById('num'),a=document.getElementById('arc');" +
          "window.drawAt=function(t){n.textContent=JV.count(t,250,1800,V,{decimals:D,prefix:PRE,suffix:SUF});a.style.strokeDashoffset=String(553*(1-JV.progress(t,250,1800,'outExpo')));};",
      };
    },
  },

  "bar-chart": {
    label: "Bar chart",
    description: "Bars that grow one after another with their values counting up and labels under them. For comparing up to 6 numbers.",
    durationMs: 4500,
    minMs: 2400,
    params: { title: "Chart title", items: "List of {label, value}, up to 6" },
    build(p) {
      let items = Array.isArray(p.items) ? p.items : [];
      items = items
        .map((it) => ({ label: str(it && it.label, "", 20), value: num(it && it.value, NaN) }))
        .filter((it) => it.label && Number.isFinite(it.value))
        .slice(0, 6);
      if (!items.length) items = [{ label: "Mon", value: 12 }, { label: "Tue", value: 19 }, { label: "Wed", value: 15 }, { label: "Thu", value: 27 }, { label: "Fri", value: 34 }];
      const max = Math.max(...items.map((it) => it.value), 1);
      const title = esc(str(p.title, "Growth this week", 60));
      const bars = items
        .map((it, i) =>
          '<div class="col" style="--i:' + i + ";--h:" + (it.value / max).toFixed(4) + '"><div class="val" data-v="' + it.value + '">0</div><div class="bar"></div><div class="lab">' + esc(it.label) + "</div></div>",
        )
        .join("");
      return {
        html: '<div class="stage"><div class="chart"><h2>' + title + '</h2><div class="cols">' + bars + "</div></div></div>",
        css:
          FULL +
          ".chart{width:min(86vw,150vmin);display:grid;gap:5vmin}" +
          "h2{margin:0;font:800 6.4vmin/1.1 'Segoe UI',system-ui,sans-serif;opacity:0;animation:fade .5s ease-out .1s both}" +
          "@keyframes fade{from{opacity:0;transform:translateY(1.5vmin)}to{opacity:1;transform:none}}" +
          ".cols{display:flex;align-items:flex-end;gap:3vmin;height:52vmin}" +
          ".col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:1.4vmin}" +
          ".bar{width:100%;height:calc(var(--h) * (100% - 12vmin));min-height:1vmin;background:var(--secondary);border-radius:1.2vmin 1.2vmin .4vmin .4vmin;transform:scaleY(0);transform-origin:bottom;animation:grow .9s cubic-bezier(.2,.9,.25,1) both;animation-delay:calc(500ms + var(--i) * 140ms)}" +
          "@keyframes grow{to{transform:scaleY(1)}}" +
          ".val{font:750 4vmin/1 'Segoe UI',system-ui,sans-serif;font-variant-numeric:tabular-nums}" +
          ".lab{font:600 3.2vmin/1 'Segoe UI',system-ui,sans-serif;opacity:.8}",
        js:
          "var vals=[].slice.call(document.querySelectorAll('.val'));" +
          "window.drawAt=function(t){vals.forEach(function(el,i){var v=Number(el.getAttribute('data-v'));var d=(String(v).split('.')[1]||'').length;el.textContent=JV.count(t,500+i*140,900,v,{decimals:Math.min(d,2),ease:'outCubic'});});};",
      };
    },
  },

  "word-slam": {
    label: "Word slam",
    description: "Short words slam onto the screen one at a time, each replacing the last, with a camera shake on impact. For a punchy list like Fast. Simple. Yours.",
    durationMs: 3600,
    minMs: 2000,
    params: { words: "2 to 5 short words" },
    build(p, ctx) {
      // "Fast. Simple. Yours." typed as one line splits on spaces too.
      let raw = list(p.words, ["Fast.", "Simple.", "Yours."], 5);
      if (raw.length === 1 && typeof raw[0] === "string" && /\s/.test(raw[0].trim())) raw = raw[0].trim().split(/\s+/).slice(0, 5);
      const words = raw.map((w) => str(w, "", 18));
      // Words share the length (less a short end hold), at most 1.6 s each so
      // a long render does not drag.
      const per = Math.min(1600, Math.floor(Math.max(1200, ctx.durationMs - 600) / words.length));
      const spans = words
        .map((w, i) => '<span class="w" style="--s:' + (150 + i * per) + "ms;--e:" + (150 + (i + 1) * per) + 'ms">' + esc(w) + "</span>")
        .join("");
      return {
        html: '<div class="stage"><div class="shake">' + spans + "</div></div>",
        css:
          FULL +
          ".shake{position:relative;width:100%;height:100%;display:grid;place-items:center}" +
          ".w{grid-area:1/1;font:900 17vmin/1 'Segoe UI',system-ui,sans-serif;letter-spacing:-0.04em;text-transform:uppercase;opacity:0}" +
          ".w:nth-child(even){color:var(--secondary)}",
        js:
          "var ws=[].slice.call(document.querySelectorAll('.w')),sh=document.querySelector('.shake');" +
          "var last=ws.length-1;" +
          "window.drawAt=function(t){var kick=0;ws.forEach(function(w,i){var s=parseFloat(w.style.getPropertyValue('--s')),e=parseFloat(w.style.getPropertyValue('--e'));" +
          "if(t<s||(i<last&&t>=e)){w.style.opacity=0;return;}var p=JV.progress(t,s,220,'outBack');w.style.opacity=1;w.style.transform='scale('+JV.lerp(2.4,1,p)+')';" +
          "var k=1-JV.progress(t,s+120,260,'outQuad');if(t>=s+120&&k>kick)kick=k;});" +
          "sh.style.transform='translate('+(Math.sin(t*0.09)*kick*14)+'px,'+(Math.cos(t*0.11)*kick*10)+'px)';};",
      };
    },
  },

  "typewriter-quote": {
    label: "Typewriter quote",
    description: "A quote typed out letter by letter with a blinking cursor, then the author's name fades in. For testimonials and quotes.",
    durationMs: 5000,
    minMs: 3200,
    params: { quote: "The quote, up to about 120 characters", author: "Who said it (optional)" },
    build(p, ctx) {
      const quote = str(p.quote, "Good design is as little design as possible.", 160);
      const author = esc(str(p.author, "", 50));
      return {
        html:
          // The whole quote is laid out from the start and the untyped part
          // is only hidden, so the block never re-centers or jumps on a wrap.
          '<div class="stage"><figure><div class="mark">“</div><blockquote><span id="q"></span><span class="cur"></span><span id="rest" class="rest">' + esc(quote) + "</span></blockquote>" +
          (author ? '<figcaption id="a">' + author + "</figcaption>" : "") +
          "</figure></div>",
        css:
          FULL +
          "figure{margin:0;padding:0 9vmin;max-width:150vmin}" +
          ".mark{font:900 26vmin/0.6 Georgia,serif;color:var(--secondary);opacity:0;animation:pop .5s ease-out .1s both}" +
          "@keyframes pop{from{opacity:0;transform:translateY(3vmin)}to{opacity:1;transform:none}}" +
          "blockquote{margin:2vmin 0 0;font:600 6.6vmin/1.28 Georgia,'Times New Roman',serif}" +
          ".cur{display:inline-block;width:.08em;height:1em;margin-left:.06em;margin-right:-.14em;vertical-align:-.12em;background:var(--secondary)}" +
          ".rest{visibility:hidden}" +
          "figcaption{margin-top:4vmin;font:600 3.8vmin/1.2 'Segoe UI',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;opacity:0}",
        js:
          "var Q=" + JSON.stringify(quote) + ",q=document.getElementById('q'),cur=document.querySelector('.cur'),a=document.getElementById('a');" +
          "var start=500,per=Math.min(55," + Math.max(1200, ctx.durationMs - 1700) + "/Math.max(1,Q.length)),done=start+Q.length*per;" +
          "var rest=document.getElementById('rest');" +
          "window.drawAt=function(t){var n=Math.max(0,Math.min(Q.length,Math.floor((t-start)/per)));q.textContent=Q.slice(0,n);rest.textContent=Q.slice(n);" +
          "cur.style.opacity=(t<done?1:(Math.floor(t/450)%2?0:1));" +
          "if(a){var p=JV.progress(t,done+200,600,'outCubic');a.style.opacity=p*0.85;a.style.transform='translateY('+((1-p)*20)+'px)';}};",
      };
    },
  },

  "end-card": {
    label: "End card",
    description: "A closing card: a call to action, a handle, and a button that pops in and pulses. For the last 3 to 5 seconds.",
    durationMs: 4000,
    minMs: 2200,
    params: { cta: "Call to action, like Follow for more", handle: "Handle or website", button: "Button text (optional)" },
    build(p, ctx) {
      // Whole pulses only, each 1.2 s, and the last ends 0.3 s before the cut.
      // A card too short for one whole pulse gets none, instead of a pulse that
      // runs off the end (at minMs 2200 the old value ran to 3100 ms).
      const pulses = Math.max(0, Math.floor((ctx.durationMs - 1900 - 300) / 1200));
      const pulseCss = pulses > 0 ? ",pulse 1.2s ease-in-out 1.9s " + pulses : "";
      const cta = esc(str(p.cta, "Follow for more", 50));
      const handle = esc(str(p.handle, "@yourchannel", 40));
      const button = esc(str(p.button, "Subscribe", 24));
      return {
        html:
          '<div class="stage"><div class="card"><h2 data-split="words">' + cta + '</h2><div class="handle">' + handle + '</div><div class="btn">' + button + "</div></div></div>",
        css:
          FULL +
          ".card{text-align:center;padding:0 8vmin}" +
          "h2{margin:0;font:850 10vmin/1.05 'Segoe UI',system-ui,sans-serif;letter-spacing:-0.03em}" +
          ".jv-word{opacity:0;transform:translateY(.5em);animation:w .55s cubic-bezier(.2,.9,.3,1.15) both;animation-delay:calc(150ms + var(--i) * 110ms)}" +
          "@keyframes w{to{opacity:1;transform:none}}" +
          ".handle{margin-top:3vmin;font:600 4.6vmin/1.2 'Segoe UI',system-ui,sans-serif;opacity:0;animation:f .5s ease-out .9s both}" +
          "@keyframes f{to{opacity:.85}}" +
          ".btn{display:inline-block;margin-top:5vmin;padding:2.4vmin 6vmin;border-radius:99vmin;background:var(--secondary);color:var(--primary);font:800 4.4vmin/1 'Segoe UI',system-ui,sans-serif;opacity:0;transform:scale(.4);animation:b .5s cubic-bezier(.2,.9,.3,1.4) 1.3s both" + pulseCss + "}" +
          "@keyframes b{to{opacity:1;transform:none}}" +
          "@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}",
        js: "",
      };
    },
  },
};

// What each design shows when a field is left blank (the build() fallbacks),
// so the form can say it instead of hiding it.
const SAMPLES = {
  "kinetic-title": { title: "Make it move" },
  "logo-sting": { text: "JV" },
  "lower-third": { name: "Alex Rivera" },
  "counter-stat": { value: "1000000", label: "people reached" },
  "bar-chart": { title: "Growth this week", items: "Mon, 12\nTue, 19\nWed, 15\nThu, 27\nFri, 34" },
  "word-slam": { words: "Fast, Simple, Yours" },
  "typewriter-quote": { quote: "Good design is as little design as possible." },
  "end-card": { cta: "Follow for more", handle: "@yourchannel", button: "Subscribe" },
};

function listPresets() {
  return Object.keys(PRESETS).map((name) => {
    const preset = PRESETS[name];
    return {
      name,
      label: preset.label,
      description: preset.description,
      about: preset.about || preset.description,
      durationMs: preset.durationMs,
      minMs: preset.minMs || 1000,
      transparent: preset.transparent === true,
      params: preset.params,
      samples: SAMPLES[name] || {},
    };
  });
}

// Returns the code plus the settings it was designed for. Unknown names throw
// with the list so the agent can correct itself.
// opts.durationMs: the render's length, so exits and pacing land on it.
function buildPreset(name, params, opts) {
  const key = String(name || "").trim().toLowerCase();
  const preset = PRESETS[key];
  if (!preset) throw new Error("Unknown animation preset \"" + key + "\". Presets: " + Object.keys(PRESETS).join(", ") + ".");
  const durationMs = Math.max(preset.minMs || 1000, Number(opts && opts.durationMs) || preset.durationMs);
  const code = preset.build(params && typeof params === "object" ? params : {}, { durationMs });
  return Object.assign({ preset: key, durationMs, minMs: preset.minMs || 1000, transparent: preset.transparent === true }, code);
}

module.exports = { listPresets, buildPreset, PRESET_NAMES: Object.keys(PRESETS) };
