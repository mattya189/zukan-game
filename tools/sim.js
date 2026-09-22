// 個体値と称号の出やすさを確認する。使い方: node tools/sim.js stats 200000
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = ['data/characters.js','data/rules.js','js/game.js'].map(f => fs.readFileSync(path.join(root,f),'utf8')).join('\n');
const memory = {};
global.localStorage = { getItem:k => memory[k] || null, setItem:(k,v)=>{memory[k]=String(v);}, removeItem:k=>{delete memory[k];} };
const api = (0,eval)(src + '\n;({CHARACTERS,TITLES,titlesOf,generateIndividual,powerChance,ratioChance})');
const { CHARACTERS, TITLES, titlesOf, generateIndividual } = api;
const line = console.log;

function stats(n = 200000) {
  line(`■ 個体値と称号の出やすさ（${n}体を生成）`);
  const count = {}, values = { power:[], total:[] };
  for (let i=0;i<n;i++) {
    const c=CHARACTERS[i%CHARACTERS.length], ind=generateIndividual(Math.random,c,1,i+1);
    titlesOf(ind,c).forEach(id=>{count[id]=(count[id]||0)+1;});
    if(i<50000){values.power.push(ind.power);values.total.push(ind.total_score);}
  }
  const summary=a=>{a.sort((x,y)=>x-y);return `中央 ${a[a.length>>1]}／上位5% ${a[Math.floor(a.length*.95)]}／上位0.1% ${a[Math.floor(a.length*.999)]}`;};
  line(`キャラ ${CHARACTERS.length}体`);
  line(`パワー ${summary(values.power)}`);
  line(`総合値 ${summary(values.total)}`);
  TITLES.forEach(t=>line(`${t.name}: ${count[t.id] ? `約1/${Math.round(n/count[t.id])}` : '出なかった'}`));
}

const [cmd,arg]=process.argv.slice(2);
if (!cmd || cmd === 'stats') stats(Number(arg)||200000);
else { console.error('使える項目は stats だけです'); process.exitCode=1; }
