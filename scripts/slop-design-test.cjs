"use strict";

// Tests for lib/slop/design-lint.js. Plain node, no window:
//   node scripts/slop-design-test.cjs
// Prints PASS or FAIL per case and exits 1 when any case fails.
// SLOP_CORPUS=<folder> points the corpus run at saved real designs
// (good-*.json must come back ok, slop-*.json must not).

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const { lintDesign, RULES, parseColor } = require(path.join(root, "lib", "slop", "design-lint.js"));

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail ? "\n       " + detail : ""));
}
const ids = (r) => r.problems.map((p) => p.rule);
const brief = (r) => r.verdict + " [" + r.problems.map((p) => (p.hard ? "!" : "") + p.rule).join(", ") + "]" + (r.stats.error ? " ERROR " + r.stats.error : "");
const all = [];
function lint(input, opts) {
  const r = lintDesign(input, opts || {});
  all.push(r);
  return r;
}

// ------------------------------------------------------------------- fixtures

const SLOP = [
  {
    name: "saas hero: stock gradient, Inter, emoji, glass, glow",
    expect: ["default-gradient", "font-missing", "emoji", "glass", "glow"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="hero"><span class="badge">\u2728 New</span><h1>Supercharge your workflow</h1><p>The all-in-one platform that helps teams ship faster.</p><a class="btn">Get Started \u{1F680}</a></div>',
      css: "body{font-family:Inter,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}.hero{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;text-align:center;color:#fff}.badge{padding:8px 20px;border-radius:999px;background:rgba(255,255,255,.15);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.3);font-size:24px}h1{font-size:96px;font-weight:800;margin:24px 0}p{font-size:34px}.btn{margin-top:40px;padding:20px 48px;border-radius:999px;background:#fff;color:#764ba2;font-size:30px;box-shadow:0 0 40px rgba(118,75,162,.6)}",
    },
  },
  {
    name: "dark dashboard: gradient text, cyan on black, glow, stat row",
    expect: ["gradient-text", "neon-on-dark", "glow", "stat-row", "font-default"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="wrap"><h1 class="title">Realtime analytics</h1><div class="stats"><div class="stat"><div class="num">99.9%</div><div class="lbl">Uptime</div></div><div class="stat"><div class="num">12ms</div><div class="lbl">Latency</div></div><div class="stat"><div class="num">4.8M</div><div class="lbl">Events a day</div></div></div></div>',
      css: "body{background:#0a0a0f;color:#e5e7eb;font-family:system-ui,sans-serif}.wrap{padding:120px}.title{font-size:110px;background:linear-gradient(90deg,#00f0ff,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.stats{display:flex;gap:40px;margin-top:80px}.stat{flex:1;padding:40px;border:1px solid rgba(0,240,255,.4);box-shadow:0 0 30px rgba(0,240,255,.3)}.num{font-size:88px;font-weight:800;color:#00f0ff}.lbl{font-size:30px}",
    },
  },
  {
    name: "three feature cards: equal boxes, icon tiles, big radius, shadows, eyebrow",
    expect: ["font-missing", "equal-boxes", "radius", "shadow-everywhere", "hairline-shadow", "icon-tile", "eyebrow", "tracking"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="page"><div class="eyebrow">Features</div><h2>Everything you need</h2><div class="grid"><div class="card"><div class="icon"><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg></div><h3>Fast</h3><p>Built for speed from day one.</p></div><div class="card"><div class="icon"><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg></div><h3>Secure</h3><p>Your data stays yours.</p></div><div class="card"><div class="icon"><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg></div><h3>Simple</h3><p>No setup, no manual.</p></div></div></div>',
      css: "body{background:#f8fafc;font-family:Poppins,sans-serif;color:#0f172a}.page{padding:100px 140px}.eyebrow{font-size:22px;letter-spacing:.2em;text-transform:uppercase;color:#2563eb}h2{font-size:84px;margin:12px 0 60px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:32px}.card{background:#fff;border-radius:24px;padding:40px;border:1px solid #eee;box-shadow:0 10px 40px rgba(0,0,0,.08)}.icon{width:64px;height:64px;border-radius:16px;background:#dbeafe;display:grid;place-items:center}h3{font-size:40px;margin:24px 0 8px}.card p{font-size:26px;margin:0}",
    },
  },
  {
    name: "cream editorial default: centered italic serif from the web, tracked eyebrow",
    expect: ["font-missing", "cream-default", "italic-serif-hero", "eyebrow", "tracking"],
    input: {
      kind: "card", width: 1080, height: 1920,
      html: '<div class="c"><div class="kicker">The collection</div><h1>Quiet luxury, redefined</h1><p>Discover pieces made to last.</p></div>',
      css: "body{background:#F5F0E8;color:#2b2b2b}.c{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 90px}.kicker{font:500 26px 'Montserrat',sans-serif;letter-spacing:.3em;text-transform:uppercase}h1{font-family:'Playfair Display',serif;font-style:italic;font-weight:400;font-size:120px;margin:30px 0}p{font:400 38px Georgia,serif}",
    },
  },
  {
    name: "soft tells only: violet page, system font, four centered blocks, pills",
    expect: ["purple-main", "font-default", "centered", "radius"],
    input: {
      kind: "card", width: 1080, height: 1920,
      html: '<div class="c"><span class="pill">Webinar</span><h1>Scale with confidence</h1><p>Join the live session this Friday.</p><span class="pill b">Save my seat</span></div>',
      css: "body{background:#6D28D9;color:#fff;font-family:system-ui}.c{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:36px}.pill{padding:14px 34px;border-radius:9999px;background:#fff;color:#6D28D9;font-size:30px}h1{font-size:110px;margin:0}p{font-size:40px;margin:0}",
    },
  },
  {
    name: "animation: bounce on type, fade+slide+scale, stagger, pulse loop, width tween",
    expect: ["motion-bounce", "motion-triple", "motion-stagger", "motion-loop", "motion-layout"],
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 2400,
      html: '<div class="s"><h1>Big news today</h1><p class="line a">We rebuilt the editor.</p><p class="line b">It opens in a second.</p><p class="line c">Your files stay local.</p><div class="progress">80% done</div><div class="cta">Read the notes</div></div>',
      css: "body{background:#14213D;color:#fff}.s{padding:120px}h1{font:900 150px/1 'Segoe UI Black','Arial Black',sans-serif;margin:0 0 40px;animation:bounceIn .9s both}@keyframes bounceIn{0%{transform:scale(.3);opacity:0}50%{transform:scale(1.1)}70%{transform:scale(.9)}100%{transform:scale(1);opacity:1}}.line{font:400 48px/1.3 Corbel,'Segoe UI',sans-serif;margin:0;opacity:0;animation:fadeUp .6s ease-out both}.a{animation-delay:.2s}.b{animation-delay:.4s}.c{animation-delay:.6s}@keyframes fadeUp{from{opacity:0;transform:translateY(40px) scale(.9)}to{opacity:1;transform:none}}.progress{margin-top:50px;background:#FCA311;color:#14213D;font:700 40px Corbel,sans-serif;padding:10px 20px;animation:grow 1s ease-out both}@keyframes grow{from{width:0}to{width:60%}}.cta{margin-top:40px;font:700 44px Corbel,sans-serif;animation:pulse 1.5s ease-in-out infinite}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}",
    },
  },
  {
    name: "canvas script: stock gradient in addColorStop, web font, glow, confetti",
    expect: ["default-gradient", "font-missing", "glow", "particles"],
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 4000,
      html: '<canvas id="c" width="1920" height="1080"></canvas>',
      js: "const c=document.getElementById('c'),ctx=c.getContext('2d');\nconst A='#667EEA',B='#764BA2';\nconst confetti=[];for(let i=0;i<80;i++)confetti.push({x:Math.random()*1920,y:Math.random()*1080});\nwindow.drawAt=function(t){const g=ctx.createLinearGradient(0,0,1920,1080);g.addColorStop(0,A);g.addColorStop(1,B);ctx.fillStyle=g;ctx.fillRect(0,0,1920,1080);ctx.shadowColor='#00e5ff';ctx.shadowBlur=40;ctx.font='bold 120px Poppins';ctx.fillStyle='#fff';ctx.fillText('Launch day',200,500);for(const p of confetti){ctx.fillRect(p.x,p.y+t*.1,8,8);}};",
    },
  },
  {
    name: "glass lower third: centered at the bottom, blur, hairline and wide shadow",
    expect: ["glass", "hairline-shadow", "centered"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="lt"><div class="name">Jordan Lee</div><div class="role">Product designer</div></div>',
      css: "body{background:transparent}.lt{position:absolute;left:50%;bottom:80px;transform:translateX(-50%);background:rgba(255,255,255,.12);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.25);border-radius:20px;box-shadow:0 8px 32px rgba(0,0,0,.3);padding:24px 48px;text-align:center;color:#fff}.name{font:800 56px 'Segoe UI Black','Arial Black',sans-serif}.role{font:400 30px Corbel,'Segoe UI',sans-serif}",
    },
  },
  {
    name: "emoji checklist",
    expect: ["emoji"],
    input: {
      kind: "card", width: 1080, height: 1920,
      html: '<div class="p"><h1>Why teams switch</h1><ul><li>\u2705 Fast setup</li><li>\u2705 No code needed</li><li>\u{1F525} Loved by 2,000 teams</li></ul></div>',
      css: "body{background:#12372A;color:#FBFADA}.p{padding:160px 90px}h1{font:700 110px/1.05 Georgia,serif;margin:0 0 60px}ul{list-style:none;margin:0;padding:0}li{font:400 48px/1.5 Corbel,'Segoe UI',sans-serif}",
    },
  },
  {
    name: "blurred orbs, noise overlay and gradient text",
    expect: ["gradient-text", "blur-orbs", "texture-overlay"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="bg"><div class="orb a"></div><div class="orb b"></div><div class="noise"></div></div><h1 class="t">Dream bigger</h1><p class="s">A new way to plan your week.</p>',
      css: "body{background:#0b1020;color:#fff}.orb{position:absolute;width:500px;height:500px;border-radius:50%;filter:blur(80px)}.a{left:10%;top:10%;background:#f97316}.b{right:10%;bottom:10%;background:#22c55e}.noise{position:absolute;inset:0;opacity:.2;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.8'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")}.t{position:absolute;left:140px;top:360px;margin:0;font:900 170px/1 'Segoe UI Black','Arial Black',sans-serif;background:linear-gradient(90deg,#f97316,#facc15);background-clip:text;color:transparent}.s{position:absolute;left:140px;top:580px;font:400 46px Corbel,sans-serif}",
    },
  },
  {
    name: "steps panel: side stripes on rounded boxes, 01 02 03, card in card",
    expect: ["side-stripe", "numbered-markers", "card-in-card"],
    input: {
      kind: "card", width: 1080, height: 1920,
      html: '<div class="panel"><h2>How it works</h2><div class="step"><div class="n">01</div><div class="d">Upload your footage</div></div><div class="step"><div class="n">02</div><div class="d">Pick the best takes</div></div><div class="step"><div class="n">03</div><div class="d">Export in one click</div></div></div>',
      css: "body{background:#E8EEF2;color:#102A43}.panel{margin:200px 70px;background:#F7FAFC;border-radius:16px;padding:48px}h2{font:700 84px Bahnschrift,'Segoe UI',sans-serif;margin:0 0 40px}.step{background:#fff;border-left:6px solid #2563eb;border-radius:12px;padding:28px 32px;margin-top:24px}.n{font:700 40px Consolas,monospace;color:#2563eb}.d{font:400 42px Corbel,'Segoe UI',sans-serif}",
    },
  },
  {
    name: "type soup: 44 40 36 32, four weights, 14px footnote, wide caps",
    expect: ["type-scale", "weight-soup", "text-tiny", "tracking"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="p"><div class="tag">Quarterly update</div><div class="l1">Revenue grew again</div><div class="l2">Costs stayed flat this time</div><div class="l3">Hiring resumes in the spring</div><div class="l4">Thank you to the whole team</div><div class="fine">Figures are unaudited and may change.</div></div>',
      css: "body{background:#1E3A2F;color:#F1F5F2;font-family:Corbel,'Segoe UI',sans-serif}.p{padding:120px}.tag{font-size:30px;letter-spacing:.25em;text-transform:uppercase;font-weight:600}.l1{font-size:44px;font-weight:800}.l2{font-size:40px;font-weight:600}.l3{font-size:36px;font-weight:400}.l4{font-size:32px;font-weight:300}.fine{font-size:14px;margin-top:60px}",
    },
  },
  {
    name: "utility classes: indigo to purple in oklch, ui-sans-serif, gray on indigo",
    expect: ["purple-gradient", "font-default", "gray-on-color", "purple-main"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="plate"><h1>Ship faster</h1><p class="muted">Trusted by modern teams.</p><a class="btn">Start free trial</a></div>',
      css: "body{font-family:ui-sans-serif,system-ui,sans-serif;background:#eef2ff}.plate{margin:140px;padding:90px;background:#4f46e5;color:#fff}h1{font-size:120px;margin:0}.muted{font-size:40px;color:#9ca3af}.btn{display:inline-block;margin-top:40px;padding:22px 44px;font-size:34px;color:#fff;background-image:linear-gradient(to right,oklch(0.585 0.233 277),oklch(0.627 0.265 303))}",
    },
  },
  {
    name: "web page copy at video size: tracked caps and a 20px caption",
    expect: ["text-tiny", "font-default", "tracking"],
    input: {
      kind: "card", width: 1920, height: 1080,
      html: '<div class="k">Pro tip</div><div class="cap">Drag the handles to crop</div>',
      css: 'body{background:#23424E}.k{position:absolute;left:60px;top:52px;font-size:16px;letter-spacing:.3em;text-transform:uppercase;color:#8FB6C2}.cap{position:absolute;right:60px;bottom:44px;font-size:20px;color:#EAF2F4}',
    },
  },
  {
    name: "live chip: pulsing dot, shimmer loop, neon green on black",
    expect: ["pulsing-dot", "motion-loop", "neon-on-dark"],
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 5000,
      html: '<div class="chip"><span class="dot"></span><span class="live">LIVE</span></div><h1>Match day stream</h1><div class="sk">Loading the lineup</div>',
      css: "body{background:#0a0a0a;color:#fff}.chip{position:absolute;left:100px;top:90px;display:flex;align-items:center;gap:14px}.dot{width:14px;height:14px;border-radius:50%;background:#39FF14;animation:ping 1.5s ease-in-out infinite}@keyframes ping{0%,100%{opacity:1}50%{opacity:.3}}.live{font:700 34px Bahnschrift,sans-serif;color:#39FF14}h1{position:absolute;left:100px;top:300px;margin:0;font:900 160px/1 Impact,'Arial Narrow',sans-serif}.sk{position:absolute;left:100px;top:560px;font:400 44px Corbel,sans-serif;padding:14px 22px;background:linear-gradient(90deg,#1a1a1a,#333,#1a1a1a);background-size:200% 100%;animation:shimmer 2s linear infinite}@keyframes shimmer{from{background-position:200% 0}to{background-position:-200% 0}}",
    },
  },
];

// Good work in different voices. Each must come back "ok" with no problems.
const CLEAN = [
  {
    name: "editorial: timeline, four dated events in a row under a rule",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 7000,
      html: '<div class="tl"><h1>How the bridge got built</h1><div class="line"></div><ol class="ev"><li><time>1961</time><span>Survey</span></li><li><time>1964</time><span>Piers poured</span></li><li><time>1968</time><span>Deck joined</span></li><li><time>1970</time><span>Opened</span></li></ol></div>',
      css: '.tl{position:absolute;inset:0;background:#EDE7DB;color:#22313F;padding:130px 140px}h1{margin:0 0 120px;font:700 110px/1 Cambria,Georgia,serif}.line{height:6px;background:#22313F;transform-origin:left;animation:ln 1.4s cubic-bezier(.16,1,.3,1) .3s both}@keyframes ln{from{transform:scaleX(0)}}.ev{list-style:none;display:flex;justify-content:space-between;margin:40px 0 0;padding:0}.ev li{display:flex;flex-direction:column;gap:14px}.ev time{font:700 64px/1 Cambria,Georgia,serif;color:#A63D40}.ev span{font:400 40px/1 Corbel,"Segoe UI",sans-serif}',
    },
  },
  {
    name: "retro: radio card, a record that spins and a ticker that scrolls",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 8000,
      html: '<div class="st"><div class="rec"></div><h1>Now playing</h1><p class="song">Blue in Green, 1959</p><div class="tick"><div class="run">Requests open until midnight. Call 555 0142. Requests open until midnight. Call 555 0142.</div></div></div>',
      css: '.st{position:absolute;inset:0;background:#20252B;color:#F4EBD9}.rec{position:absolute;right:160px;top:180px;width:520px;height:520px;border-radius:50%;background:#111;border:40px solid #C8553D;animation:spin 4s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}h1{position:absolute;left:150px;top:260px;margin:0;font:700 150px/1 Rockwell,Georgia,serif}.song{position:absolute;left:150px;top:450px;margin:0;font:400 60px/1 Georgia,serif;color:#E0A458}.tick{position:absolute;left:0;right:0;bottom:0;height:110px;background:#C8553D;overflow:hidden}.run{white-space:nowrap;font:700 50px/110px Bahnschrift,sans-serif;animation:roll 16s linear infinite}@keyframes roll{from{transform:translateX(0)}to{transform:translateX(-50%)}}',
    },
  },
  {
    name: "loud: photo card, a dark scrim under the caption",
    input: {
      kind: "card", width: 1080, height: 1920, durationMs: 4000,
      html: '<div class="ph" style="background-image:url({{image:li_7}})"></div><div class="scrim"></div><div class="cap"><h1>The 5 am ferry</h1><p>Forty minutes, two coffees, no signal.</p></div>',
      css: '.ph{position:absolute;inset:0;background-size:cover}.scrim{position:absolute;left:0;right:0;bottom:0;height:55%;background:linear-gradient(to top,rgba(8,12,16,.9),rgba(8,12,16,0))}.cap{position:absolute;left:80px;right:80px;bottom:140px;color:#fff}h1{margin:0;font:900 130px/1 "Segoe UI Black","Arial Black",sans-serif}p{margin:30px 0 0;font:400 50px/1.3 Corbel,"Segoe UI",sans-serif}',
    },
  },
  {
    name: "technical: before and after in two ruled columns",
    input: {
      kind: "card", width: 1920, height: 1080, durationMs: 5000,
      html: '<div class="cmp"><h1>Same shot, new lens</h1><div class="cols"><div class="col"><div class="k">Before</div><div class="v">f/4, soft corners</div></div><div class="col"><div class="k">After</div><div class="v">f/1.8, sharp to the edge</div></div></div></div>',
      css: '.cmp{position:absolute;inset:0;background:#F4F1EA;color:#1A1A1A;padding:120px 140px}h1{margin:0 0 90px;font:400 150px/1 Impact,"Arial Narrow",sans-serif}.cols{display:grid;grid-template-columns:1fr 1fr;gap:80px}.col{border-top:8px solid #1A1A1A;padding-top:30px}.k{font:700 40px/1 Bahnschrift,sans-serif;color:#B3261E}.v{margin-top:16px;font:400 64px/1.1 Bahnschrift,sans-serif}',
    },
  },
  {
    name: "editorial: quote card, Georgia over Corbel on bottle green",
    input: {
      kind: "card", width: 1080, height: 1920, durationMs: 4000,
      html: '<div class="page"><p class="quote">Salt the water until it tastes like the sea.</p><div class="rule"></div><p class="by">Marta Ruiz, line cook for 22 years</p></div>',
      css: '.page{position:absolute;inset:0;background:#17352B;color:#F4EFE4;padding:160px 96px}.quote{margin:0;font:700 104px/1.08 Georgia,"Palatino Linotype",serif;max-width:860px}.rule{width:120px;height:6px;background:#E0A93B;margin:72px 0 40px}.by{margin:0;font:400 40px/1.3 Corbel,"Segoe UI",sans-serif;color:#CFE0D6}',
    },
  },
  {
    name: "editorial: chapter title animation, Constantia, one rule",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 4000,
      html: '<div class="frame"><div class="no">Chapter 3</div><h1>The long way home</h1><div class="line"></div><p>Forty miles of gravel, one spare tire.</p></div>',
      css: '.frame{position:absolute;inset:0;background:#2B2118;color:#F3E9DC;padding:200px 150px}.no{font:700 34px/1 Corbel,"Segoe UI",sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#D9A441}h1{margin:24px 0 0;font:700 150px/1.02 Constantia,Georgia,serif;animation:rise .8s cubic-bezier(.16,1,.3,1) .15s both}@keyframes rise{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:none}}.line{width:300px;height:5px;background:#D9A441;margin:44px 0;transform-origin:left;animation:draw .6s cubic-bezier(.16,1,.3,1) .5s both}@keyframes draw{from{transform:scaleX(0)}to{transform:scaleX(1)}}p{margin:0;font:400 44px/1.3 Corbel,"Segoe UI",sans-serif;animation:fade .5s ease-out .8s both}@keyframes fade{from{opacity:0}to{opacity:1}}',
    },
  },
  {
    name: "loud: sale card, Impact on yellow with one hard shadow",
    input: {
      kind: "card", width: 1080, height: 1080, durationMs: 3500,
      html: '<div class="sale"><div class="big">HALF OFF</div><div class="what">Every bike in the shop</div><div class="when">Sat 14 June, doors 9 am</div></div>',
      css: '.sale{position:absolute;inset:0;background:#FFD400;color:#111;padding:90px 70px}.big{font:400 300px/.9 Impact,Haettenschweiler,"Arial Narrow",sans-serif;letter-spacing:-.01em}.what{margin-top:36px;font:700 62px/1.1 Bahnschrift,"Segoe UI",sans-serif}.when{display:inline-block;margin-top:60px;background:#111;color:#FFD400;font:700 46px/1 Bahnschrift,"Segoe UI",sans-serif;padding:22px 30px;box-shadow:14px 14px 0 #C1121F}',
    },
  },
  {
    name: "loud: score animation driven by script, Segoe UI Black on red",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 3500,
      html: '<div class="board"><div class="teams">Harbor FC against Eastside</div><div class="score" id="score">3 : 1</div><div class="note" id="note">Full time at Mill Lane</div></div>',
      css: '.board{position:absolute;inset:0;background:#C1121F;color:#fff;padding:150px 130px}.teams{font:700 60px/1.1 Bahnschrift,"Arial Narrow",sans-serif}.score{font:900 420px/1 "Segoe UI Black","Arial Black",sans-serif;margin:10px 0 0 -12px}.note{font:700 54px/1.2 Bahnschrift,"Arial Narrow",sans-serif;color:#FFE5E5}',
      js: "var score=document.getElementById('score'),note=document.getElementById('note');\nwindow.drawAt=function(t){var p=JV.tween(t,200,700,0,1,'outExpo');score.style.transform='translateX('+(-60*(1-p))+'px)';score.style.opacity=p;note.style.opacity=JV.tween(t,900,400,0,1,'outCubic');};",
    },
  },
  {
    name: "technical: changelog card, Bahnschrift and Consolas on navy",
    input: {
      kind: "card", width: 1080, height: 1920, durationMs: 5000,
      html: '<div class="log"><div class="date">Changelog, 12 May</div><h1>Version 4.2</h1><ul><li>+ Export queue</li><li>+ Faster proxy files</li><li>- Old timeline panel</li></ul></div>',
      css: '.log{position:absolute;inset:0;background:#0F1B2D;color:#E6EDF5;padding:220px 90px}.date{font:400 36px/1 "Segoe UI",sans-serif;color:#FF8A3D}h1{margin:26px 0 70px;font:700 150px/1 Bahnschrift,"Segoe UI",sans-serif}ul{list-style:none;margin:0;padding:0;border-top:3px solid #FF8A3D}li{font:400 50px/1 Consolas,"Cascadia Mono",monospace;padding:34px 0;border-bottom:1px solid #2A3B55}',
    },
  },
  {
    name: "technical: diagram animation, SVG lines drawing in, Consolas labels",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 5000,
      html: '<div class="d"><h1>How a frame is made</h1><svg class="g" viewBox="0 0 1600 500"><rect x="20" y="150" width="380" height="200" fill="none" stroke="#F2B544" stroke-width="6"/><rect x="610" y="150" width="380" height="200" fill="none" stroke="#F2B544" stroke-width="6"/><rect x="1200" y="150" width="380" height="200" fill="#F2B544"/><path class="w" d="M400 250H610M990 250H1200" stroke="#E8EEF2" stroke-width="6" fill="none"/><text x="60" y="262" fill="#E8EEF2" font-family="Consolas, monospace" font-size="44">page clock</text><text x="650" y="262" fill="#E8EEF2" font-family="Consolas, monospace" font-size="44">worker</text><text x="1240" y="262" fill="#1E2A32" font-family="Consolas, monospace" font-size="44">frame 0042</text></svg><p>Each worker seeks to one time and saves one picture.</p></div>',
      css: '.d{position:absolute;inset:0;background:#1E2A32;color:#E8EEF2;padding:110px 150px}h1{margin:0 0 50px;font:700 110px/1 Bahnschrift,"Segoe UI",sans-serif}.g{width:1600px;height:500px;display:block}.w{stroke-dasharray:420;stroke-dashoffset:420;animation:wire 1.2s cubic-bezier(.16,1,.3,1) .6s both}@keyframes wire{to{stroke-dashoffset:0}}p{margin:40px 0 0;font:400 46px/1.3 "Segoe UI",sans-serif}',
    },
  },
  {
    name: "retro: diner card, Cooper Black with fallbacks on brick",
    input: {
      kind: "card", width: 1080, height: 1920, durationMs: 4000,
      html: '<div class="diner"><div class="since">Since 1962</div><h1>Pie Night</h1><p>Every Thursday, 6 to 9. A slice and a coffee for four dollars.</p></div>',
      css: '.diner{position:absolute;inset:0;background:#7A2E1D;color:#F2B544;padding:240px 90px}.since{display:inline-block;border:6px solid #F2B544;padding:14px 24px;font:700 40px/1 Rockwell,Georgia,serif}h1{margin:70px 0 50px;font:400 230px/.95 "Cooper Black",Rockwell,Georgia,serif}p{margin:0;max-width:820px;font:400 50px/1.35 Georgia,serif;color:#FBE9C6}',
    },
  },
  {
    name: "retro: tape label animation, Franklin Gothic Heavy sliding in",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 3600,
      html: '<div class="tape"><div class="title">Summer of 89</div><div class="sub">Home movies, tape 4 of 11</div></div>',
      css: '.tape{position:absolute;inset:0;background:#0E4D52;color:#F6E7C1;padding:260px 160px}.title{font:400 220px/1 "Franklin Gothic Heavy","Arial Black",sans-serif;animation:slide .7s cubic-bezier(.16,1,.3,1) .1s both}@keyframes slide{from{transform:translateX(-120px);opacity:0}to{transform:none;opacity:1}}.sub{margin-top:40px;font:400 56px/1.2 Rockwell,Georgia,serif;color:#F28F3B;animation:show .5s ease-out .7s both}@keyframes show{from{opacity:0}to{opacity:1}}',
    },
  },
  {
    name: "handmade: recipe card, Ink Free over Georgia on flour white",
    input: {
      kind: "card", width: 1080, height: 1920, durationMs: 6000,
      html: '<div class="r"><h1>Sunday red sauce</h1><svg class="u" viewBox="0 0 600 30"><path d="M4 18C120 4 260 28 596 10" fill="none" stroke="#C8321F" stroke-width="7" stroke-linecap="round"/></svg><ol><li>Crush two cans of tomatoes by hand.</li><li>Soften an onion in olive oil.</li><li>Simmer for three hours.</li></ol></div>',
      css: '.r{position:absolute;inset:0;background:#FBF7EF;color:#3B2A20;padding:200px 90px}h1{margin:0;font:700 150px/1 "Ink Free","Segoe Print",cursive;color:#C8321F}.u{display:block;width:600px;height:30px;margin:10px 0 70px}ol{margin:0;padding-left:60px}li{font:400 48px/1.4 Georgia,"Palatino Linotype",serif;margin-bottom:30px}',
    },
  },
  {
    name: "handmade: chalk note animation, Segoe Print and a drawn underline",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 4500,
      html: '<div class="b"><div class="hi">Back Monday</div><svg class="ul" viewBox="0 0 900 40"><path d="M6 24C200 6 520 36 894 14" fill="none" stroke="#F4D35E" stroke-width="8" stroke-linecap="round"/></svg><div class="small">The shop is closed for the long weekend.</div></div>',
      css: '.b{position:absolute;inset:0;background:#2B4A3B;color:#F5F3EA;padding:280px 180px}.hi{font:700 200px/1 "Segoe Print","Ink Free",cursive}.ul{display:block;width:900px;height:40px;margin:20px 0 60px}.ul path{stroke-dasharray:920;stroke-dashoffset:920;animation:pen 1s ease-out .5s both}@keyframes pen{to{stroke-dashoffset:0}}.small{font:400 54px/1.3 Corbel,"Segoe UI",sans-serif}',
    },
  },
  {
    name: "overlay: lower third, square dark plate with a bar, bottom left",
    input: {
      kind: "card", width: 1920, height: 1080, durationMs: 4000,
      html: '<div class="lt"><div class="name">Dana Okafor</div><div class="role">Head of repairs, Okafor Cycles</div></div>',
      css: 'body{background:transparent}.lt{position:absolute;left:96px;bottom:120px;background:rgba(12,16,22,.88);padding:28px 40px;border-left:10px solid #F2B544;color:#fff}.name{font:900 64px/1.1 "Segoe UI Black","Arial Black",sans-serif}.role{margin-top:8px;font:400 34px/1.2 Corbel,"Segoe UI",sans-serif;color:#E3E8EE}',
    },
  },
  {
    name: "data: bar chart animation, bars sized inline, scaleY from script",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 5000,
      html: '<div class="c"><h1>Rides per month</h1><div class="bars"><div class="col"><div class="bar" style="height:30%"></div><span>Jan</span></div><div class="col"><div class="bar" style="height:45%"></div><span>Feb</span></div><div class="col"><div class="bar" style="height:80%"></div><span>Mar</span></div><div class="col"><div class="bar" style="height:62%"></div><span>Apr</span></div></div><p>March was the first dry month.</p></div>',
      css: '.c{position:absolute;inset:0;background:#F3EFE6;color:#1D2B36;padding:100px 140px}h1{margin:0;font:700 100px/1 Bahnschrift,"Segoe UI",sans-serif}.bars{display:flex;align-items:flex-end;gap:50px;height:520px;margin:50px 0 30px;border-bottom:4px solid #1D2B36}.col{width:200px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start}.bar{width:100%;background:#C8553D;transform-origin:bottom}.col span{font:400 38px/1.6 Corbel,"Segoe UI",sans-serif}p{margin:0;font:400 44px/1.3 Corbel,"Segoe UI",sans-serif}',
      js: "var bars=document.querySelectorAll('.bar');\nwindow.drawAt=function(t){for(var i=0;i<bars.length;i++){bars[i].style.transform='scaleY('+JV.tween(t,300+i*120,700,0,1,'outCubic')+')';}};",
    },
  },
  {
    name: "hook: centered title card, a headline and one line",
    input: {
      kind: "card", width: 1080, height: 1920, durationMs: 2500,
      html: '<div class="h"><h1>I quit sugar for 30 days</h1><p>Here is what my dentist said.</p></div>',
      css: '.h{position:absolute;inset:0;background:#1B3A57;color:#fff;display:flex;flex-direction:column;justify-content:center;text-align:center;padding:0 80px}h1{margin:0;font:900 150px/1 "Segoe UI Black","Arial Black",sans-serif}p{margin:50px 0 0;font:400 52px/1.3 Corbel,"Segoe UI",sans-serif;color:#FFD166}',
    },
  },
  {
    name: "friendly: kids club card, Candara and Trebuchet, one pill button",
    input: {
      kind: "card", width: 1080, height: 1080, durationMs: 4000,
      html: '<div class="k"><h1>Dino Club</h1><p>Fossil digs and model making for ages 6 to 10.</p><div class="info">Room 4, city library</div><a class="go">Join us Saturday</a></div>',
      css: '.k{position:absolute;inset:0;background:#FFE08A;color:#1F4D3A;padding:110px 90px}h1{margin:0;font:700 190px/1 Candara,"Trebuchet MS",sans-serif}p{margin:30px 0 40px;max-width:800px;font:400 50px/1.3 "Trebuchet MS",Corbel,sans-serif}.info{display:inline-block;background:#fff;border-radius:12px;padding:18px 26px;font:700 40px/1 "Trebuchet MS",Corbel,sans-serif}.go{display:block;width:520px;margin-top:50px;text-align:center;background:#1F4D3A;color:#fff;border-radius:999px;padding:28px 0;font:700 46px/1 Candara,"Trebuchet MS",sans-serif}',
    },
  },
  {
    name: "mono: command line animation, stepped reveal and a blinking caret",
    input: {
      kind: "animation", width: 1920, height: 1080, durationMs: 5000,
      html: '<div class="t"><h1>One command to render</h1><div class="cmd"><span class="typed">jv render intro.html --fps 60</span><span class="caret"></span></div><p>The file lands in your library when it is done.</p></div>',
      css: '.t{position:absolute;inset:0;background:#1F2430;color:#E6E1CF;padding:220px 160px}h1{margin:0 0 70px;font:700 110px/1 Bahnschrift,"Segoe UI",sans-serif}.cmd{display:flex;align-items:center;font:400 62px/1 Consolas,"Cascadia Mono",monospace;color:#FFB454}.typed{clip-path:inset(0 100% 0 0);animation:type 1.6s steps(30) .4s both}@keyframes type{to{clip-path:inset(0 0 0 0)}}.caret{width:26px;height:64px;margin-left:8px;background:#FFB454;animation:blink 1s steps(1) infinite}@keyframes blink{50%{opacity:0}}p{margin:70px 0 0;font:400 46px/1.3 "Segoe UI",sans-serif}',
    },
  },
  {
    name: "overlay: one quiet caption line at the floor, no headline",
    input: {
      kind: "card", width: 1920, height: 1080, durationMs: 3000,
      html: '<div class="c">Evening freight at the harbour</div>',
      css: 'body{background:transparent}.c{position:absolute;left:96px;bottom:120px;font:400 34px/1.2 Rockwell,Georgia,serif;color:#F4EFE4}',
    },
  },
  {
    name: "light: one sunset gradient on a picture panel, type on a solid",
    input: {
      kind: "card", width: 1080, height: 1920, durationMs: 4000,
      html: '<div class="sky"></div><div class="copy"><h1>Golden hour starts at 7:42</h1><p>Bring a tripod and a jacket.</p></div>',
      css: 'body{background:#1E1B18}.sky{position:absolute;left:0;top:0;width:100%;height:44%;background:linear-gradient(#F9A03F,#D45113 60%,#7A1E48)}.copy{position:absolute;left:80px;right:80px;top:52%;color:#F7EDE2}h1{margin:0;font:700 120px/1.05 Georgia,"Palatino Linotype",serif}p{margin:40px 0 0;font:400 50px/1.3 Corbel,"Segoe UI",sans-serif}',
    },
  },
];

console.log("# Slop fixtures (" + SLOP.length + ")");
for (const f of SLOP) {
  const r = lint(f.input, f.opts);
  const missing = f.expect.filter((id) => !ids(r).includes(id));
  check("slop: " + f.name, r.verdict === "slop" && !missing.length && !r.stats.error, "got " + brief(r) + (missing.length ? " missing " + missing.join(", ") : ""));
}

console.log("\n# Clean fixtures (" + CLEAN.length + ")");
for (const f of CLEAN) {
  const r = lint(f.input, f.opts);
  check("clean: " + f.name, r.verdict === "ok" && r.problems.length === 0 && !r.stats.error, "got " + brief(r) + " " + r.problems.map((p) => p.what).join(" / "));
}

// --------------------------------------------------------------------- dodges

console.log("\n# Dodges: the same slop written another way");
const A = parseColor("#667eea"), B = parseColor("#764ba2");
const okl = (c) => "oklch(" + c.L.toFixed(4) + " " + c.C.toFixed(4) + " " + c.h.toFixed(2) + ")";
const card = (css, html, extra) => Object.assign({ kind: "card", width: 1080, height: 1920, html: html || '<div class="x"><h1>Title here</h1></div>', css: "h1{font:700 120px Georgia,serif}" + css }, extra || {});
const DODGES = [
  ["default-gradient", "uppercase hex", card(".x{background:linear-gradient(135DEG,#667EEA,#764BA2)}")],
  ["default-gradient", "rgb() and space separated rgb()", card(".x{background:linear-gradient(rgb(102,126,234),rgb(118 75 162))}")],
  ["default-gradient", "hsl()", card(".x{background:linear-gradient(hsl(229 76% 66%),hsl(270 37% 46%))}")],
  ["default-gradient", "oklch()", card(".x{background:linear-gradient(" + okl(A) + "," + okl(B) + ")}")],
  ["default-gradient", "8 digit hex with stops and a middle color", card(".x{background:linear-gradient(to right,#667eeaff 0%,#6f65c6 50%,#764ba2ff 100%)}")],
  ["default-gradient", "css variables", card(":root{--a:#667eea;--b:#764ba2}.x{background:linear-gradient(var(--a),var(--b))}")],
  ["default-gradient", "nested variables with a fallback", card(":root{--b:#764ba2;--g:linear-gradient(var(--a,#667eea),var(--b))}.x{background:var(--g)}")],
  ["default-gradient", "vars input", card(".x{background:linear-gradient(var(--start),var(--end))}", null, { vars: { start: "#667eea", end: "#764ba2" } })],
  ["default-gradient", "colors input", card(".x{background:linear-gradient(var(--primary),var(--secondary))}", null, { colors: { primary: "#667eea", secondary: "#764ba2" } })],
  ["default-gradient", "background-image longhand", card(".x{background-color:#000;background-image:linear-gradient(#667eea,#764ba2)}")],
  ["default-gradient", "vendor prefix", card(".x{background:-webkit-linear-gradient(left,#667eea,#764ba2)}")],
  ["default-gradient", "comment inside the value", card(".x{background:linear-gradient(/* brand */#667eea,/* end */#764ba2)}")],
  ["default-gradient", "inline style attribute", card("", '<div style="background: linear-gradient(135deg, #667eea, #764ba2)"><h1>Title here</h1></div>')],
  ["default-gradient", "radial and conic", card(".x{background:radial-gradient(circle at top,#667eea,#764ba2)}")],
  ["default-gradient", "inside @media screen and nested css", card("@media screen{.x{h1{color:#fff}background:linear-gradient(#667eea,#764ba2)}}")],
  ["default-gradient", "pseudo element layer", card(".x::before{content:'';position:absolute;inset:0;background:linear-gradient(#667eea,#764ba2)}")],
  ["default-gradient", "svg linearGradient stops", card("", '<svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#667eea"/><stop offset="1" stop-color="#764ba2"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg><h1>Title here</h1>')],
  ["default-gradient", "script: style.background with string concat", { kind: "animation", html: '<div id="x"><h1 style="font:700 120px Georgia,serif">Title</h1></div>', js: "var A='#667eea',B='#764ba2';document.getElementById('x').style.background='linear-gradient(135deg,'+A+','+B+')';" }],
  ["default-gradient", "script: template literal and cssText", { kind: "animation", html: '<div id="x"><h1 style="font:700 120px Georgia,serif">Title</h1></div>', js: "const c={from:'#667eea',to:'#764ba2'};x.style.cssText=`color:#fff;background:linear-gradient(90deg, ${c.from}, ${c.to})`;" }],
  ["default-gradient", "script: setProperty", { kind: "animation", html: '<div id="x"><h1 style="font:700 120px Georgia,serif">Title</h1></div>', js: "x.style.setProperty('background-image','linear-gradient(#667eea,#764ba2)');" }],
  ["default-gradient", "script: colors from an array into a canvas gradient", { kind: "animation", html: "<canvas id=c></canvas>", js: "var stops=['#667eea','#764ba2'];var g=ctx.createLinearGradient(0,0,9,9);stops.forEach(function(s,i){g.addColorStop(i,s);});" }],
  ["default-gradient", "script: a style tag written from script", { kind: "animation", html: '<div class="x"><h1 style="font:700 120px Georgia,serif">Title</h1></div>', js: "var s=document.createElement('style');s.textContent='.x{background:linear-gradient(#667eea,#764ba2)}';document.head.appendChild(s);" }],
  ["purple-gradient", "named colors", card(".x{background:linear-gradient(to right,purple,blue)}")],
  ["purple-gradient", "named pink to violet", card(".x{background:linear-gradient(deeppink,blueviolet)}")],
  ["purple-gradient", "hsl indigo to violet", card(".x{background:linear-gradient(hsl(243 75% 59%),hsl(271 91% 65%))}")],
  ["purple-gradient", "color-mix and variables", card(":root{--v:#8b5cf6}.x{background:linear-gradient(var(--v),color-mix(in srgb,var(--v) 30%,#3b82f6))}")],
  ["purple-gradient", "script object style", { kind: "animation", html: '<div id="x"><h1 style="font:700 120px Georgia,serif">Title</h1></div>', js: "Object.assign(x.style,{background:'linear-gradient(120deg,#7c3aed,#2563eb)',color:'#fff'});" }],
  ["gradient-text", "-webkit- prefix", card("h1{background:linear-gradient(90deg,#f97316,#facc15);-webkit-background-clip:text;-webkit-text-fill-color:transparent}")],
  ["gradient-text", "background shorthand with text", card("h1{background:linear-gradient(90deg,#f97316,#facc15) text;color:transparent}")],
  ["gradient-text", "clip and gradient in separate rules", card(".x h1{background-image:linear-gradient(90deg,#f97316,#facc15)}h1{background-clip:text;color:transparent}")],
  ["gradient-text", "script", { kind: "animation", html: '<h1 id="t" style="font:700 120px Georgia,serif">Title</h1>', js: "t.style.backgroundImage='linear-gradient(90deg,#f97316,#facc15)';t.style.webkitBackgroundClip='text';t.style.color='transparent';" }],
  ["gradient-text", "svg text filled with a gradient", card("", '<svg viewBox="0 0 800 200"><defs><linearGradient id="tg"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#facc15"/></linearGradient></defs><text x="0" y="150" font-size="160" font-family="Georgia, serif" fill="url(#tg)">Title</text></svg>')],
  ["font-missing", "font shorthand", card("p{font:italic 700 48px/1.2 Inter,sans-serif}", '<div class="x"><h1>Title here</h1><p>Line</p></div>')],
  ["font-missing", "uppercase and quoted", card('p{font-family:"POPPINS"}', '<div class="x"><h1>Title here</h1><p>Line</p></div>')],
  ["font-missing", "through a variable", card(":root{--f:'Space Grotesk',sans-serif}p{font-family:var(--f)}", '<div class="x"><h1>Title here</h1><p>Line</p></div>')],
  ["font-missing", "through vars input", card("p{font:400 48px var(--body)}", '<div class="x"><h1>Title here</h1><p>Line</p></div>', { vars: { body: "Montserrat, sans-serif" } })],
  ["font-missing", "inline style", card("", '<h1>Title here</h1><p style="font-family: Roboto, Arial">Line</p>')],
  ["font-missing", "script fontFamily", { kind: "animation", html: '<h1 id="t" style="font:700 120px Georgia,serif">Title</h1>', js: "t.style.fontFamily='Geist, sans-serif';" }],
  ["font-missing", "canvas font", { kind: "animation", html: "<canvas id=c></canvas>", js: "ctx.font='700 90px \"Plus Jakarta Sans\"';ctx.fillText('Title',10,100);" }],
  ["font-no-fallback", "an Office font alone", card('p{font-family:"Cooper Black";font-size:48px}', '<div class="x"><h1>Title here</h1><p>Line</p></div>')],
  ["font-missing", "@font-face that loads from the network", card("@font-face{font-family:Brandy;src:url(https://example.com/b.woff2)}p{font-family:Brandy,serif}", '<div class="x"><h1>Title here</h1><p>Line</p></div>')],
  ["emoji", "numeric entity", card("", '<h1>Launch &#x1F680; day</h1>')],
  ["emoji", "css content escape", card('h1::before{content:"\\1F525 "}')],
  ["emoji", "script string escape", { kind: "animation", html: '<h1 id="t" style="font:700 120px Georgia,serif">Title</h1>', js: "t.textContent='Done \\u{1F389}';" }],
  ["emoji", "innerHTML from script", { kind: "animation", html: '<div id="x"></div>', js: "x.innerHTML='<h1 style=\"font:700 120px Georgia,serif\">Fast \u26A1</h1>';" }],
  ["glow", "text-shadow in rgb", card("h1{text-shadow:0 0 24px rgb(0 229 255 / .8)}")],
  ["glow", "filter drop-shadow", card(".x{filter:drop-shadow(0 0 30px #ff00aa)}")],
  ["glow", "through a variable", card(":root{--accent:#22d3ee}.x{box-shadow:0 0 60px var(--accent)}")],
  ["glass", "-webkit-backdrop-filter", card(".x{-webkit-backdrop-filter:blur(20px);background:rgba(255,255,255,.1)}")],
  ["texture-overlay", "repeating stripes", card(".x{background:repeating-linear-gradient(45deg,#0001 0 2px,transparent 2px 12px)}")],
  ["texture-overlay", "grid dots with background-size", card(".x{background-image:radial-gradient(#fff3 1px,transparent 1px);background-size:24px 24px}")],
  ["motion-bounce", "linear() spring easing", { kind: "animation", html: "<h1>Title</h1>", css: "h1{font:700 120px Georgia,serif;animation:in .8s linear(0,0.6,1.2,0.9,1.05,1) both}@keyframes in{from{transform:translateY(80px)}to{transform:none}}" }],
  ["motion-bounce", "animation-timing-function longhand", { kind: "animation", html: "<h1>Title</h1>", css: "h1{font:700 120px Georgia,serif;animation-name:in;animation-duration:.8s;animation-timing-function:cubic-bezier(.34,1.56,.64,1)}@keyframes in{from{transform:scale(0)}to{transform:scale(1)}}" }],
  ["motion-bounce", "script easing name", { kind: "animation", html: '<h1 id="t" style="font:700 120px Georgia,serif">Title</h1>', js: "window.drawAt=function(t){h.style.transform='scale('+JV.tween(t,0,600,0,1,'outElastic')+')';};" }],
  ["motion-layout", "script sets width every frame", { kind: "animation", html: '<div id="b" style="font:700 60px Georgia,serif">Loading</div>', js: "window.drawAt=function(t){b.style.width=(t/20)+'px';};" }],
];
for (const [rule, how, input] of DODGES) {
  const r = lint(Object.assign({ width: 1920, height: 1080 }, input));
  check("dodge " + rule + ": " + how, ids(r).includes(rule) && !r.stats.error, "got " + brief(r));
}

// --------------------------------------------------------------------- unlocks

console.log("\n# What the person asked for, styles and allow");
const has = (r, id) => ids(r).includes(id);
const purple = card(".x{background:linear-gradient(135deg,#667eea,#764ba2)}");
check("asked 'purple gradient' switches the gradient rules off", (() => {
  const r = lint(purple, { asked: "Make me a title card with a purple gradient background" });
  return !has(r, "default-gradient") && !has(r, "purple-gradient") && !has(r, "gradient-fill") && !has(r, "purple-main");
})());
check("asked 'no purple gradients' keeps them on", has(lint(purple, { asked: "A title card. No purple gradients please." }), "default-gradient"));
check("the standing rule text unlocks nothing", (() => {
  const r = lint(SLOP[0].input, { asked: "DON'T: Use the default AI look: purple or blue gradients, glow, glass, gradient text, emoji or sparkles as decoration, Inter or system-ui type, everything centered." });
  return ["default-gradient", "font-missing", "emoji", "glass", "glow"].every((id) => has(r, id));
})());
check("'no gradients, just make it purple' unlocks purple but not the gradient", (() => {
  const r = lint(card("body{background:#6D28D9}.x{background:linear-gradient(#7c3aed,#2563eb)}"), { asked: "no gradients, just make it purple" });
  return !has(r, "purple-main") && has(r, "purple-gradient");
})());
const inter = card("p{font-family:Inter,sans-serif;font-size:48px}", '<div class="x"><h1>Title here</h1><p>Line</p></div>');
check("asked for Inter by name", !has(lint(inter, { asked: "Use Inter for the body text" }), "font-missing"));
check("'don't use Inter' keeps the font rule", has(lint(inter, { asked: "Don't use Inter this time" }), "font-missing"));
check("asked for glass", !has(lint(SLOP[7].input, { asked: "a frosted glass lower third" }), "glass") && has(lint(SLOP[7].input, {}), "glass"));
check("asked for neon", (() => {
  const r = lint(SLOP[1].input, { asked: "neon cyberpunk dashboard" });
  return !has(r, "neon-on-dark") && !has(r, "glow") && has(r, "gradient-text");
})());
check("asked for emoji", !has(lint(SLOP[8].input, { asked: "add fun emoji to each line" }), "emoji"));
check("an emoji the person typed is theirs", !has(lint(card("", "<h1>Launch \u{1F680}</h1>"), { asked: "Put \u{1F680} after the word Launch" }), "emoji"));
check("asked for centered", !has(lint(SLOP[4].input, { asked: "keep everything centered" }), "centered") && has(lint(SLOP[4].input, {}), "centered"));
check("asked for a bounce", !has(lint(SLOP[5].input, { asked: "make the title bounce in" }), "motion-bounce"));
check("allow by rule id", !has(lint(SLOP[8].input, { allow: ["emoji"] }), "emoji"));
check("allow by group name", (() => {
  const r = lint(SLOP[5].input, { allow: ["motion"] });
  return !ids(r).some((id) => id.startsWith("motion-"));
})());
const neonCss = (n) => "body{background:#07070c;color:#fff}h1{font:700 120px Bahnschrift,sans-serif;color:#00e5ff;text-shadow:0 0 24px #00e5ff}" + Array.from({ length: n }, (_, i) => ".g" + i + "{box-shadow:0 0 30px #ff2bd6;border:3px solid #ff2bd6}").join("");
const neonHtml = (n) => "<h1>Open late</h1>" + Array.from({ length: n }, (_, i) => '<div class="g' + i + '"></div>').join("");
check("style neon: glow on two elements passes", (() => {
  const r = lint({ kind: "card", html: neonHtml(1), css: neonCss(1) }, { style: "neon" });
  return !has(r, "glow") && !has(r, "neon-on-dark");
})());
check("style neon: glow on four elements is still a tell", has(lint({ kind: "card", html: neonHtml(3), css: neonCss(3) }, { style: "neon" }), "glow"));
check("style id with the style- prefix, and the styles list", !has(lint({ kind: "card", html: neonHtml(1), css: neonCss(1) }, { style: "style-neon" }), "neon-on-dark") && !has(lint({ kind: "card", html: neonHtml(1), css: neonCss(1) }, { styles: ["flat", "neon"] }), "neon-on-dark"));
check("no style: the same card is caught", has(lint({ kind: "card", html: neonHtml(1), css: neonCss(1) }, {}), "neon-on-dark") && has(lint({ kind: "card", html: neonHtml(1), css: neonCss(1) }, {}), "glow"));
const gtext = (n) => ({ kind: "card", html: '<h1 class="a">Night</h1>' + (n > 1 ? '<h2 class="a">Drive</h2>' : "<h2>Drive</h2>"), css: "body{background:#1a0b2e;color:#fff}h1,h2{font:700 140px Impact,sans-serif}.a{background:linear-gradient(#ff8a00,#ff2d95);background-clip:text;color:transparent}" });
check("style synthwave: gradient text on one word passes, on two it does not", !has(lint(gtext(1), { style: "synthwave" }), "gradient-text") && has(lint(gtext(2), { style: "synthwave" }), "gradient-text") && has(lint(gtext(1), { style: "minimalist" }), "gradient-text"));
check("a style unlocks only its own rules", has(lint(SLOP[0].input, { style: "synthwave" }), "font-missing") && has(lint(SLOP[0].input, { style: "synthwave" }), "emoji"));

// ------------------------------------------------------------------- verdicts

console.log("\n# Verdicts");
const base = '<div class="p"><h1>Rain delays the final</h1><p>Play resumes at four.</p></div>';
const baseCss = ".p{position:absolute;inset:0;background:#14342B;color:#fff;padding:120px}h1{margin:0;font:700 130px/1 Georgia,serif}p{font:400 50px/1.3 Corbel,sans-serif}";
const v0 = lint({ kind: "card", html: base, css: baseCss });
const v1 = lint({ kind: "card", html: base, css: baseCss + "h1{text-shadow:0 0 30px #5eead4}" });
const v2 = lint({ kind: "card", html: base, css: baseCss + "h1{text-shadow:0 0 30px #5eead4}.p{background:repeating-linear-gradient(90deg,#14342B 0 20px,#17392f 20px 40px)}" });
const v3 = lint({ kind: "card", html: base.replace("</div>", '<p class="f">Terms apply</p></div>'), css: baseCss + "h1{text-shadow:0 0 30px #5eead4}.p{background:repeating-linear-gradient(90deg,#14342B 0 20px,#17392f 20px 40px)}.f{font-size:13px}" });
const vh = lint({ kind: "card", html: base, css: baseCss + "p{font-family:Roboto}" });
check("no tells: ok", v0.verdict === "ok" && v0.problems.length === 0, brief(v0));
check("one soft tell: tells", v1.verdict === "tells" && v1.problems.length === 1 && v1.problems[0].hard === false, brief(v1));
check("two soft tells: tells", v2.verdict === "tells" && v2.problems.length === 2, brief(v2));
check("three soft tells: slop", v3.verdict === "slop" && v3.problems.length === 3 && v3.stats.hard === 0, brief(v3));
check("one hard problem alone: slop", vh.verdict === "slop" && vh.problems.length === 1 && vh.problems[0].hard === true, brief(vh));
check("hard problems are listed first", (() => {
  const r = lint(SLOP[0].input);
  const firstSoft = r.problems.findIndex((p) => !p.hard);
  return firstSoft > 0 && r.problems.slice(firstSoft).every((p) => !p.hard);
})());

// ------------------------------------------------------------ odd input, API

console.log("\n# API and odd input");
check("RULES: unique kebab-case ids with group, hard and title", RULES.length >= 30 && new Set(RULES.map((r) => r.id)).size === RULES.length && RULES.every((r) => /^[a-z]+(-[a-z]+)*$/.test(r.id) && typeof r.group === "string" && typeof r.hard === "boolean" && r.title));
check("hard rules: font, gradient text, stock gradient, purple gradient, emoji", ["font-missing", "gradient-text", "default-gradient", "purple-gradient", "emoji"].every((id) => RULES.find((r) => r.id === id && r.hard)));
let threw = "";
const odd = [undefined, null, {}, { html: null, css: 42, js: {} }, { html: "<div><p>unclosed <b>tags", css: ".a{color:red;.b{", js: "function(" }, { html: "x".repeat(20000) }, { css: "@keyframes{}{}}}}", kind: "nope", width: "wide" }, { html: "<svg><text>", vars: "no", colors: 7 }];
for (const input of odd) {
  try {
    const r = lintDesign(input, input === undefined ? undefined : { allow: "emoji", styles: "x", asked: 12 });
    all.push(r);
    if (!r || !["ok", "tells", "slop"].includes(r.verdict) || !Array.isArray(r.problems) || !r.stats) threw = "bad shape";
    if (r.stats.error) threw = r.stats.error;
  } catch (err) {
    threw = String(err && err.stack ? err.stack : err);
  }
}
check("missing fields, wrong types and broken markup never throw", !threw, threw);
check("empty input is ok", lintDesign({}).verdict === "ok" && lintDesign().verdict === "ok");
check("an unused css rule and a :hover rule do not count", lint(card(".never{background:linear-gradient(#667eea,#764ba2)}h1:hover{text-shadow:0 0 30px #0ff}")).verdict === "ok");
check("a big data uri does not slow the lint", (() => {
  const img = "data:image/png;base64," + "A".repeat(600000);
  const r = lint(card('.x{background:url("' + img + '") center/cover}'));
  return r.verdict === "ok" && r.stats.ms < 60;
})());

// -------------------------------------------------------------- shipped work

// Findings on shipped presets and templates that are real by the skill's own
// words. They are reported to the team, not fixed here; the gate takes a
// preset's own findings off an agent's design by rule id. Anything outside
// this list is a new false alarm (or new slop in a preset) and fails the run.
const KNOWN = {
  "preset logo-sting": ["particles", "tracking"],
  "preset lower-third": ["side-stripe", "gradient-fill"],
  "preset counter-stat": ["centered"],
  "preset word-slam": ["motion-bounce"],
  "preset end-card": ["motion-bounce", "motion-loop"],
};
const PRESET_PARAMS = {
  "kinetic-title": { title: "Small boats, big water", subtitle: "A week on the Dalmatian coast" },
  "logo-sting": { text: "Northwind", tagline: "Field recordings" },
  "lower-third": { name: "Alex Rivera", role: "Trail builder" },
  "counter-stat": { value: 1280, label: "people reached" },
  "bar-chart": { title: "Rides per month", items: [{ label: "Jan", value: 12 }, { label: "Feb", value: 19 }, { label: "Mar", value: 31 }, { label: "Apr", value: 24 }] },
  "word-slam": { words: ["Make", "it", "loud"] },
  "typewriter-quote": { quote: "Measure twice, cut once, then measure again.", author: "Workshop rule" },
  "end-card": { cta: "Follow for more", handle: "@northwind", button: "Subscribe" },
};

function mixHex(a, b, t) {
  const pa = parseColor(a), pb = parseColor(b);
  const ch = (x, y) => Math.round((x * (1 - t) + y * t) * 255).toString(16).padStart(2, "0");
  return "#" + ch(pa.r, pb.r) + ch(pa.g, pb.g) + ch(pa.b, pb.b);
}

// A field card (lib/card-templates.js) as the page lib/card-render.js draws:
// the surface, then each text block at its place in one default font.
function templateDesign(tpl) {
  const cardDef = tpl.card, comp = cardDef.composition, colors = Object.assign({ primary: "#1F6F56", secondary: "#DFF56A", text: "#FFFFFF" }, cardDef.colors);
  const size = { vertical: [1080, 1920, 390], landscape: [1920, 1080, 1100], square: [1080, 1080, 620] }[comp.aspectRatio] || [1080, 1920, 390];
  const scale = size[0] / size[2];
  const defaults = { headline: { x: 0.22, y: 0.38, width: 0.56, fontSize: 28 }, body: { x: 0.22, y: 0.52, width: 0.56, fontSize: 16 }, eyebrow: { x: 0.22, y: 0.26, width: 0.56, fontSize: 13 }, cta: { x: 0.22, y: 0.66, width: 0.56, fontSize: 15 } };
  let surface;
  if (comp.surface === "soft") surface = "linear-gradient(" + mixHex(colors.primary, "#FFFFFF", 0.91) + "," + mixHex(colors.secondary, "#FFFFFF", 0.76) + ")";
  else if (comp.surface === "transparent") surface = "rgba(14,20,33,.55)";
  else surface = "linear-gradient(" + colors.primary + "," + mixHex(colors.primary, "#000000", 0.32) + ")";
  let html = "", css = "body{background:" + surface + ";color:" + colors.text + "}";
  for (const field of ["eyebrow", "headline", "body", "cta"]) {
    if (!comp[field]) continue;
    const b = Object.assign({}, defaults[field], comp.blockLayout && comp.blockLayout[field]);
    html += '<div class="' + field + '">' + String(comp[field]).replace(/\n/g, "<br>") + "</div>";
    css += "." + field + "{position:absolute;left:" + b.x * 100 + "%;top:" + b.y * 100 + "%;width:" + b.width * 100 + "%;font-size:" + Math.round(b.fontSize * scale) + "px;line-height:1.2;font-weight:" + (b.bold !== false ? 700 : 400) + ";text-align:" + (b.align || comp.align || "left") + ";color:" + (b.color || colors.text) + (b.highlight ? ";background:" + b.highlight : "") + "}";
  }
  return { kind: "card", html, css, colors, width: size[0], height: size[1], durationMs: tpl.durationMs };
}

const TEMPLATE_KNOWN = ["font-default", "eyebrow", "gradient-fill", "purple-main"];

async function shipped() {
  console.log("\n# Shipped presets, through animationSource() as the render tool calls it");
  const { animationSource } = require(path.join(root, "lib", "animation-render.js"));
  const { PRESET_NAMES } = require(path.join(root, "lib", "animation-presets.js"));
  const findings = [];
  for (const name of PRESET_NAMES) {
    const seen = new Set();
    let hard = false, error = "";
    for (const presetParams of [undefined, PRESET_PARAMS[name]]) {
      for (const durationMs of [undefined, 9000]) {
        for (const size of [[1920, 1080], [1080, 1920]]) {
          const src = await animationSource({ preset: name, presetParams, durationMs }, "", "");
          const r = lint({ html: src.html, css: src.css, js: src.js, vars: src.vars, colors: src.colors, kind: "animation", width: size[0], height: size[1], durationMs: src.durationMs });
          for (const p of r.problems) {
            if (!seen.has(p.rule)) findings.push("preset " + name + ": " + p.rule + ". " + p.what);
            seen.add(p.rule);
            if (p.hard) hard = true;
          }
          if (r.stats.error) error = r.stats.error;
        }
      }
    }
    const known = KNOWN["preset " + name] || [];
    const extra = [...seen].filter((id) => !known.includes(id));
    check("preset " + name + ": " + (seen.size ? "known findings only (" + [...seen].join(", ") + ")" : "clean"), !extra.length && !hard && !error, "unexpected: " + extra.join(", ") + " " + error);
  }

  console.log("\n# Shipped card templates, drawn as the page the field renderer makes");
  const { TEMPLATES } = require(path.join(root, "lib", "card-templates.js"));
  for (const tpl of TEMPLATES) {
    const r = lint(templateDesign(tpl));
    for (const p of r.problems) findings.push("template " + tpl.id + ": " + p.rule + ". " + p.what);
    const extra = ids(r).filter((id) => !TEMPLATE_KNOWN.includes(id));
    check("template " + tpl.id + ": " + (r.problems.length ? "known findings only (" + ids(r).join(", ") + ")" : "clean"), !extra.length && !r.problems.some((p) => p.hard) && !r.stats.error, "unexpected: " + extra.join(", ") + " " + (r.stats.error || ""));
  }

  console.log("\n# Code in the skills (fenced blocks and inline declarations)");
  const skillsDir = path.join(root, "skills");
  let snippets = 0;
  for (const dir of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, dir, "SKILL.md");
    if (!fs.existsSync(file) || /-slop$|^deslop$|^design-review$/.test(dir)) continue; // those quote slop on purpose
    const text = fs.readFileSync(file, "utf8");
    const style = dir.startsWith("style-") ? dir.slice(6) : undefined;
    const inputs = [];
    let m;
    const fence = /```(\w*)\r?\n([\s\S]*?)```/g;
    while ((m = fence.exec(text))) {
      const lang = m[1].toLowerCase(), body = m[2];
      if (lang === "html" || /^\s*<[a-z]/i.test(body)) inputs.push({ html: body });
      else if (lang === "css") inputs.push({ css: body });
      else if (lang === "js" || lang === "javascript") inputs.push({ js: body });
    }
    const inline = /`([^`\n]{8,300})`/g;
    while ((m = inline.exec(text.replace(/```[\s\S]*?```/g, "")))) {
      const code = m[1].trim();
      if (/^<[a-z][\s\S]*>$/i.test(code)) inputs.push({ html: code });
      else if (/^(?:-webkit-)?[a-z-]+\s*:\s*[^{}"]+;?$/i.test(code) && /^(font|font-family|background|background-image|background-clip|color|box-shadow|text-shadow|filter|backdrop-filter|border|border-radius|letter-spacing|animation|transition|transform)\b/i.test(code.replace(/^-webkit-/, ""))) inputs.push({ css: ".example{" + code.replace(/\.\.\./g, "0") + "}" });
      else if (/^[.#]?[\w-]+\s*\{[^}]+\}$/.test(code)) inputs.push({ css: code });
    }
    if (!inputs.length) continue;
    const bad = [];
    for (const input of inputs) {
      snippets += 1;
      const r = lint(Object.assign({ kind: "card", width: 1920, height: 1080 }, input), { style });
      if (r.verdict !== "ok" || r.stats.error) bad.push((input.css || input.html || input.js).slice(0, 80) + " -> " + brief(r));
      for (const p of r.problems) findings.push("skill " + dir + ": " + p.rule + ". " + p.what);
    }
    check("skill " + dir + ": " + inputs.length + " snippet" + (inputs.length === 1 ? "" : "s"), !bad.length, bad.join(" | "));
  }
  check("skills hold code to check", snippets > 0, "no snippets found");
  return findings;
}

// --------------------------------------------------------------------- corpus

function corpus() {
  // scripts/slop-corpus holds real agent output: good-* files are designs a
  // person would keep and must pass, slop-* files must be caught.
  const dir = process.env.SLOP_CORPUS || path.join(__dirname, "slop-corpus");
  console.log("\n# Corpus of saved real designs: " + dir);
  if (!fs.existsSync(dir)) {
    console.log("SKIP corpus folder not found (set SLOP_CORPUS to run it)");
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) console.log("SKIP corpus folder is empty");
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      check("corpus " + file + " parses", false, String(err.message));
      continue;
    }
    const kind = /\.card\./.test(file) || doc.kind === "card" || (doc.kind && doc.kind !== "animation" && !Array.isArray(doc.scenes) && !/\.animation\./.test(file)) ? "card" : "animation";
    const aspect = String(doc.aspectRatio || (kind === "card" ? "vertical" : "16/9"));
    const size = { "9/16": [1080, 1920], vertical: [1080, 1920], "1/1": [1080, 1080], square: [1080, 1080], "4/5": [1080, 1350] }[aspect] || [1920, 1080];
    const scenes = Array.isArray(doc.scenes) && doc.scenes.length ? doc.scenes : [doc];
    const rules = new Set(), lines = [];
    let hard = false, error = "";
    scenes.forEach((scene, i) => {
      const r = lint({ html: scene.html, css: scene.css, js: scene.js, vars: Object.assign({}, doc.vars, scene.vars), colors: Object.assign({}, doc.colors, scene.colors), kind, width: doc.width || size[0], height: doc.height || size[1], durationMs: scene.durationMs || (scenes.length === 1 ? doc.durationMs : undefined) }, { asked: doc.asked || doc.prompt || "", style: doc.style, styles: doc.styles });
      for (const p of r.problems) {
        rules.add(p.rule);
        if (p.hard) hard = true;
        lines.push("scene " + (i + 1) + " " + (p.hard ? "!" : "") + p.rule + ": " + p.what);
      }
      if (r.stats.error) error = r.stats.error;
    });
    // Across scenes, as the gate counts it: any hard problem, or three different soft tells.
    const verdict = hard || rules.size >= 3 ? "slop" : rules.size ? "tells" : "ok";
    if (/^good-/.test(file)) check("corpus " + file + " (" + scenes.length + " scene" + (scenes.length === 1 ? "" : "s") + ") is ok", verdict === "ok" && !error, verdict + ": " + lines.join(" | ") + " " + error);
    else if (/^slop-/.test(file)) {
      check("corpus " + file + " (" + scenes.length + " scene" + (scenes.length === 1 ? "" : "s") + ") is caught: " + verdict + " [" + [...rules].join(", ") + "]", verdict !== "ok" && !error, "came back ok " + error);
      for (const line of lines) console.log("       " + line);
    } else console.log("INFO corpus " + file + ": " + verdict + " [" + [...rules].join(", ") + "]");
  }
}

// --------------------------------------------------------------------- timing

function timing() {
  console.log("\n# Speed");
  const median = (input) => {
    for (let i = 0; i < 5; i += 1) lintDesign(input, {});
    const times = [];
    for (let i = 0; i < 40; i += 1) times.push(lintDesign(input, {}).stats.ms);
    times.sort((a, b) => a - b);
    return times[20];
  };
  const a = median(SLOP[2].input), b = median(CLEAN[0].input), c = median(SLOP[5].input);
  check("a normal card lints in under 30 ms (feature cards " + a + " ms, quote card " + b + " ms, animation " + c + " ms, median of 40)", a < 30 && b < 30 && c < 30);
}

// -------------------------------------------------------------------- wording

function wording() {
  console.log("\n# Wording of every problem this run produced");
  const known = new Set(RULES.map((r) => r.id));
  const bad = [];
  let count = 0;
  for (const r of all) {
    for (const p of r.problems) {
      count += 1;
      const rule = RULES.find((x) => x.id === p.rule);
      if (!known.has(p.rule)) bad.push("unknown rule " + p.rule);
      else if (rule.hard !== p.hard) bad.push(p.rule + " hard flag differs from RULES");
      for (const key of ["what", "fix"]) {
        const text = p[key];
        if (typeof text !== "string" || text.length < 12) bad.push(p.rule + " " + key + " is missing");
        else if (/[\u2014\u2013]|--/.test(text)) bad.push(p.rule + " " + key + " has a dash: " + text);
        else if (!/[.)]$/.test(text)) bad.push(p.rule + " " + key + " does not end a sentence: " + text);
        else if (text.length > 260) bad.push(p.rule + " " + key + " is too long: " + text.length);
        else if (/\b(leverage|seamless|elevate|unlock|robust|delve|vibrant|stunning)\b/i.test(text)) bad.push(p.rule + " " + key + " has a buzzword: " + text);
        else if (/undefined|NaN|\[object/.test(text)) bad.push(p.rule + " " + key + " has a broken value: " + text);
      }
      if (typeof p.where !== "string") bad.push(p.rule + " where is not a string");
    }
  }
  check(count + " problems: plain sentences, known rule ids, no dashes", !bad.length && count > 50, [...new Set(bad)].slice(0, 8).join("\n       "));
  const fired = new Set();
  for (const r of all) for (const p of r.problems) fired.add(p.rule);
  const silent = RULES.map((r) => r.id).filter((id) => !fired.has(id));
  check("every rule fired at least once in this run", !silent.length, "never fired: " + silent.join(", "));
}

shipped()
  .then((findings) => {
    corpus();
    timing();
    wording();
    if (findings.length) {
      console.log("\n# Findings in shipped work (reported, not failures)");
      for (const line of [...new Set(findings)]) console.log("  " + line);
    }
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.log("FAIL the test run crashed\n       " + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
