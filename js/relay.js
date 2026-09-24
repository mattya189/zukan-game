const RELAY_ENEMIES=[
 {ch:{id:'chr_rag',name:'ラグ＝ヴァルガ',grade:'C',resolve:'mid',tags:['遠距離','分析','長期戦'],stats:{atk:58,def:48,wis:82,spd:92,sta:58,amb:35},art:{base:1},hue:30,shape:0},ind:{power:160,speed:160,wisdom:160}},
 {id:'chr_004',ind:{power:4000,speed:3000,wisdom:160}},
 {ch:{id:'chr_grad',name:'グラド＝ヴァルガ',grade:'A',resolve:'high',tags:['遠距離','大型','拘束','長期戦','領域'],stats:{atk:68,def:98,wis:42,spd:8,sta:138,amb:55},art:{base:1},hue:0,shape:0},ind:{power:160,speed:160,wisdom:160}}
];
function runRelayBattle(opts){
 let ai=0,bi=0,ahp=null,bhp=null;const bouts=[];
 while(ai<opts.a.length&&bi<opts.b.length){
  const a=opts.a[ai],b=opts.b[bi],stage={name:'逆獣の荒野',features:[]};
  if(b.ch.id==='chr_004'){stage.enemyPower=1.2;stage.setup=(ctx)=>{ctx.B.maxHp*=1.6;ctx.B.hp=bhp==null?ctx.B.maxHp:Math.min(bhp,ctx.B.maxHp);};}
  const res=runBattle({a:{ch:a.ch,ind:{...a.ind,loadout:a.ind.equipped_skills||[],battleHp:ahp}},b:{ch:b.ch,ind:{...b.ind,battleHp:bhp}},stage,seed:(opts.seed||Date.now())+bouts.length});
  bouts.push(res);
  if(res.winner===0){ahp=res.A.hp;bi++;bhp=null;}else{bhp=res.B.hp;ai++;ahp=null;}
 }
 return{winner:bi>=opts.b.length?0:ai>=opts.a.length?1:null,bouts,ownDown:ai,enemyDown:bi};
}
