// The "paint crew": little CSS-only characters that pop up over the dimmed 3D view while a paint run works.
// Each showing takes the next character in order (never random), and a long run moves on every few seconds.
// Pixel art is one element's box-shadow grid of 3px cells, built from the rows below.

/** Rows of palette letters ('.' is empty) -> a box-shadow list of size×size cells. */
const px = (rows, pal, s = 3) =>
  rows
    .flatMap((row, y) => [...row].map((c, x) => (pal[c] ? `${x * s}px ${y * s}px 0 ${pal[c]}` : null)))
    .filter(Boolean)
    .join(',');

const C = {
  green: '#6fdc5f',
  orange: '#F3AD3D',
  blue: '#2196F3',
  teal: '#26a69a',
  gold: '#ffcc33',
  skin: '#f1c27d',
  ink: '#1b1f22',
  grey: '#9aa3ab',
  light: '#e8ebee',
};

const ROLLER_HEAD = ['.kkkkkkkkkk.', 'kbwwbbbbbbbk', 'kbbbbbbbbbbk', 'kbbbbbbbbbbk', '.kkkkkkkkkk.'];
const ROLLER_HANDLE = ['.kkkkkkk', '.......k', '.......k', '......ggg', '......ggg', '......ggg', '......ggg'];
const CAN = [
  '...kk...',
  '..kwk...',
  '.tttttt.',
  'tttttttt',
  'twtttttt',
  'gggggggg',
  'gyyyyyyg',
  'gyggggyg',
  'gggggggg',
  'twtttttt',
  'tttttttt',
  '.tttttt.',
];
const PALETTE = [
  '....ssssss....',
  '..ssssssssss..',
  '.ssssssssssss.',
  'ssssssssssssss',
  'ssssssssssssss',
  'ssssssss..ssss',
  'ssssssss..ssss',
  'sssssssssssss.',
  '.sssssssssss..',
  '..ssssssss....',
  '...sssss......',
];
const BUCKET = [
  'kkkkkkkkkk',
  'kooooooook',
  'gggggggggg',
  'gwgggggggg',
  '.gwggggggg.',
  '.gggggggg.',
  '.gggggggg.',
  '..gggggg..',
];
const BRUSH = ['..kk..', '..kk..', '..kk..', '..kk..', '.gggg.', '.gggg.', '.bbbb.', '.bbbb.', '..bb..'];

export const CREW = [
  {
    id: 'roller',
    caption: 'Rolling on a fresh coat...',
    html: '<div class="wc-roller"><i class="wall"></i><i class="coat"></i><i class="tool"><b class="handle"></b><b class="head"></b></i></div>',
    css: `.wc-roller{position:relative;width:60px;height:52px}
.wc-roller i,.wc-roller b{position:absolute;display:block}
.wc-roller .wall{left:0;top:3px;width:60px;height:9px;border-radius:2px;background:#2b3136}
.wc-roller .coat{left:0;top:3px;width:60px;height:9px;border-radius:2px;transform-origin:0 50%;
  animation:wc-roller-coat 2s linear infinite,wc-roller-hue 6s steps(1,end) infinite}
.wc-roller .tool{left:0;top:4px;animation:wc-roller-roll 2s ease-in-out infinite}
.wc-roller .head{left:0;top:0;width:3px;height:3px;box-shadow:${px(ROLLER_HEAD, { k: C.ink, b: C.blue, w: '#8fcbff' })};
  animation:wc-roller-hue 6s steps(1,end) infinite}
.wc-roller .handle{left:6px;top:15px;width:3px;height:3px;box-shadow:${px(ROLLER_HANDLE, { k: C.grey, g: C.orange })}}
@keyframes wc-roller-roll{0%{transform:translate(0,0)}45%{transform:translate(24px,-1px)}50%{transform:translate(24px,0)}
  95%{transform:translate(0,-1px)}100%{transform:translate(0,0)}}
@keyframes wc-roller-coat{0%{transform:scaleX(0);background:${C.blue}}45%,100%{transform:scaleX(1);background:${C.blue}}}
@keyframes wc-roller-hue{0%{filter:none}33%{filter:hue-rotate(250deg)}66%{filter:hue-rotate(150deg)}}`,
  },
  {
    id: 'spray',
    caption: 'Shaking things up...',
    html: '<div class="wc-spray"><i class="can"></i><i class="mist m1"></i><i class="mist m2"></i><i class="mist m3"></i><i class="mark"></i></div>',
    css: `.wc-spray{position:relative;width:60px;height:52px}
.wc-spray i{position:absolute;display:block}
.wc-spray .can{left:8px;top:10px;width:3px;height:3px;box-shadow:${px(CAN, { k: C.ink, w: C.light, t: C.teal, g: C.gold, y: C.orange })};
  transform-origin:12px 36px;animation:wc-spray-shake 1.6s ease-in-out infinite}
.wc-spray .mist{left:20px;top:12px;width:7px;height:7px;border-radius:50%;opacity:0;animation:wc-spray-mist 1.6s ease-out infinite}
.wc-spray .m1{background:${C.green}}
.wc-spray .m2{background:${C.orange};animation-delay:.12s}
.wc-spray .m3{background:${C.blue};animation-delay:.24s}
.wc-spray .mark{left:42px;top:6px;width:14px;height:14px;border-radius:50% 45% 55% 40%;opacity:0;
  background:radial-gradient(circle at 40% 40%,${C.gold},${C.orange} 45%,${C.green} 75%);animation:wc-spray-mark 1.6s ease-out infinite}
@keyframes wc-spray-shake{0%,8%,16%,24%,32%{transform:rotate(-9deg) translateY(0)}4%,12%,20%,28%{transform:rotate(9deg) translateY(-3px)}
  40%,100%{transform:rotate(0)}}
@keyframes wc-spray-mist{0%,40%{transform:translate(0,0) scale(.3);opacity:0}45%{opacity:.9}
  80%{transform:translate(22px,-4px) scale(1.8);opacity:.6}90%,100%{transform:translate(26px,-4px) scale(2.2);opacity:0}}
@keyframes wc-spray-mark{0%,55%{transform:scale(0);opacity:0}70%{transform:scale(1.2);opacity:1}88%{transform:scale(1);opacity:1}100%{transform:scale(1);opacity:0}}`,
  },
  {
    id: 'palette',
    caption: 'Mixing the paint...',
    html: '<div class="wc-palette"><i class="board"></i><i class="dab d1"></i><i class="dab d2"></i><i class="dab d3"></i><i class="brush"></i></div>',
    css: `.wc-palette{position:relative;width:60px;height:52px}
.wc-palette i{position:absolute;display:block}
.wc-palette .board{left:4px;top:12px;width:3px;height:3px;box-shadow:${px(PALETTE, { s: C.skin })};
  animation:wc-palette-tilt 1.8s ease-in-out infinite alternate}
.wc-palette .dab{left:0;top:0;width:8px;height:8px;border-radius:50% 50% 45% 55%;box-shadow:inset -2px -2px 0 rgba(0,0,0,.2);
  animation:wc-palette-swap 1.8s ease-in-out infinite}
.wc-palette .d1{background:${C.green}}
.wc-palette .d2{background:${C.orange};animation-delay:-.6s}
.wc-palette .d3{background:${C.blue};animation-delay:-1.2s}
.wc-palette .brush{left:40px;top:0;width:3px;height:3px;box-shadow:${px(BRUSH, { k: C.orange, g: C.grey, b: C.teal })};
  transform-origin:9px 0;animation:wc-palette-dip .9s ease-in-out infinite}
@keyframes wc-palette-swap{0%{transform:translate(10px,18px)}22%{transform:translate(16px,8px)}33.3%{transform:translate(22px,16px)}
  55%{transform:translate(18px,30px) scale(1.2)}66.6%{transform:translate(14px,26px)}88%{transform:translate(8px,24px) scale(1.2)}
  100%{transform:translate(10px,18px)}}
@keyframes wc-palette-tilt{from{transform:rotate(-4deg)}to{transform:rotate(4deg)}}
@keyframes wc-palette-dip{0%,100%{transform:translate(0,0) rotate(20deg)}50%{transform:translate(-6px,8px) rotate(-10deg)}}`,
  },
  {
    id: 'bucket',
    caption: 'Pouring on the color...',
    html: '<div class="wc-bucket"><i class="pool"></i><i class="pour"></i><i class="pail"></i></div>',
    css: `.wc-bucket{position:relative;width:76px;height:56px}
.wc-bucket i{position:absolute;display:block}
.wc-bucket .pail{left:6px;top:8px;width:3px;height:3px;box-shadow:${px(BUCKET, { k: C.ink, o: C.orange, g: C.grey, w: C.light })};
  transform-origin:30px 24px;animation:wc-bucket-tip 2.2s ease-in-out infinite}
.wc-bucket .pail::before{content:"";position:absolute;left:2px;top:-8px;width:24px;height:12px;border:2px solid ${C.grey};
  border-bottom:none;border-radius:14px 14px 0 0}
.wc-bucket .pour{left:54px;top:22px;width:5px;height:24px;border-radius:3px;background:${C.orange};transform-origin:50% 0;
  transform:scaleY(0);animation:wc-bucket-pour 2.2s ease-in infinite}
.wc-bucket .pool{left:40px;top:44px;width:34px;height:8px;border-radius:50%;background:${C.orange};transform:scale(0);
  box-shadow:inset 0 -2px 0 #d58a1c;animation:wc-bucket-pool 2.2s ease-out infinite}
@keyframes wc-bucket-tip{0%,12%{transform:rotate(0)}30%,70%{transform:rotate(70deg)}86%,100%{transform:rotate(0)}}
@keyframes wc-bucket-pour{0%,28%{transform:scaleY(0);opacity:1}38%,66%{transform:scaleY(1);opacity:1}74%,100%{transform:scaleY(1) translateY(24px);opacity:0}}
@keyframes wc-bucket-pool{0%,34%{transform:scale(0);opacity:1}70%{transform:scale(1.05,1)}78%{transform:scale(1,1.2)}90%{opacity:1}100%{transform:scale(1);opacity:0}}`,
  },
  {
    id: 'swatch',
    caption: 'Picking the perfect shade...',
    html: '<div class="wc-swatch"><i class="fan f1"></i><i class="fan f2"></i><i class="fan f3"></i><i class="pin"></i></div>',
    css: `.wc-swatch{position:relative;width:56px;height:56px}
.wc-swatch i{position:absolute;display:block}
.wc-swatch .fan{left:22px;top:6px;width:12px;height:40px;border-radius:3px;border:2px solid ${C.ink};transform-origin:50% 36px;
  box-shadow:inset 0 -10px 0 rgba(255,255,255,.85)}
.wc-swatch .f1{background:${C.green};animation:wc-swatch-f1 1.8s cubic-bezier(.5,0,.3,1.4) infinite}
.wc-swatch .f2{background:${C.gold};animation:wc-swatch-f2 1.8s cubic-bezier(.5,0,.3,1.4) infinite}
.wc-swatch .f3{background:${C.blue};animation:wc-swatch-f3 1.8s cubic-bezier(.5,0,.3,1.4) infinite}
.wc-swatch .pin{left:26px;top:39px;width:6px;height:6px;border-radius:50%;background:${C.ink}}
@keyframes wc-swatch-f1{0%,15%{transform:rotate(0)}35%,75%{transform:rotate(-45deg)}95%,100%{transform:rotate(0)}}
@keyframes wc-swatch-f2{0%,15%{transform:rotate(0)}35%,75%{transform:rotate(-15deg)}95%,100%{transform:rotate(0)}}
@keyframes wc-swatch-f3{0%,15%{transform:rotate(0)}35%,75%{transform:rotate(30deg)}95%,100%{transform:rotate(0)}}`,
  },
];

const NEXT_EVERY_MS = 7000;
let el = null;
let next = 0;
let timer = null;

function build(host) {
  const style = document.createElement('style');
  style.textContent = CREW.map((c) => c.css).join('\n');
  document.head.append(style);
  el = document.createElement('div');
  el.id = 'wait-crew';
  el.className = 'wait-crew';
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="wc-stage"><div class="wc-slot"></div><p class="wc-cap"></p></div>';
  host.append(el);
}

/** Pop the next character in (restarting the pop and caption animations). */
function showNext() {
  const c = CREW[next];
  next = (next + 1) % CREW.length;
  const stage = el.querySelector('.wc-stage');
  el.querySelector('.wc-slot').innerHTML = c.html;
  el.querySelector('.wc-cap').textContent = c.caption;
  el.dataset.crew = c.id;
  stage.classList.remove('wc-pop');
  void stage.offsetWidth; // restart the pop-in
  stage.classList.add('wc-pop');
}

/** Dim `host` and start the crew; a second call while showing does nothing. */
export function showWaitCrew(host) {
  if (!el) build(host);
  if (!el.hidden) return;
  el.hidden = false;
  showNext();
  timer = setInterval(showNext, NEXT_EVERY_MS);
}

export function hideWaitCrew() {
  if (!el || el.hidden) return;
  el.hidden = true;
  clearInterval(timer);
  timer = null;
}
