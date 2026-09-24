// 逆獣三段撃破の簡易勝率確認: node tools/relay-sim.js [回数]
const fs=require('fs'),path=require('path'),root=path.join(__dirname,'..'),run=eval;
run(['data/characters.js','data/skills.js','js/battle.js','js/relay.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n')+'\n;globalThis.__R={cs:CHARACTERS,rr:runRelayBattle,re:RELAY_ENEMIES};');
const T=globalThis.__R,N=Number(process.argv[2])||100;
function party(skills){return T.cs.slice(0,3).map((ch,i)=>({ch,ind:{power:1100+i*100,speed:600+i*100,wisdom:550,weight:ch.base_weight*1.35,appetite:ch.appetite_bias*.6,luck:ch.luck_bias*.6,nature:'まじめ',equipped_skills:skills}}));}
const foes=()=>T.re.map(x=>({ch:x.ch||T.cs.find(c=>c.id===x.id),ind:{...x.ind}}));
for(const [label,skills] of [['装備なし',[]],['粘り装備',['sk_tekkabi','sk_shigojou','sk_fukuhachibu','sk_dojinu']]]){let wins=0;for(let i=0;i<N;i++)wins+=T.rr({a:party(skills),b:foes(),seed:i+1}).winner===0;console.log(`${label}: ${wins}/${N} (${Math.round(wins/N*100)}%)`);}
