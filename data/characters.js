// 依頼1で採用する10体。stats / resolve / tags / grade は今後の対戦でも使う。
const CHARACTERS = [
  ['chr_001','マッチ＝ヴァルガルド','戦争の化身','マッチ神','','A','high',['近接','大型','長期戦','拘束','高揚'],[91,102,58,28,83,80],900,360,200,600,400,800,['負けず嫌い','ゆうかん','いじっぱり'],12],
  ['chr_002','マッチ＝バースクライ','誕生の化身','マッチ神','概念種','B','high',['遠距離','音','精神干渉','長期戦'],[57,52,82,41,79,48],25,190,650,800,350,300,['れいせい','しんちょう','がんこ'],25],
  ['chr_003','マデランデス','夢岩の魔導守護者','マッチ守護者','','A','high',['遠距離','分析','長期戦','自信','拘束'],[70,72,92,50,61,90],68,178,500,850,550,450,['いじっぱり','れいせい','マイペース'],275],
  ['chr_004','タルンルソルク','短足の化身','マッチ神','欲望種','D','low',['近接','かわいい好き','精神干渉'],[27,38,46,42,50,81],30,90,350,400,700,600,['ようき','むじゃき','のんき'],210],
  ['chr_005','マッチ＝ダラガルド','低堕落の化身','マッチ神','欲望種','C','mid',['近接','大型','長期戦','高揚'],[86,82,24,26,88,15],1200,420,250,250,500,950,['のんき','マイペース','ねぼすけ'],18],
  ['chr_006','マッチ＝カンタレイア','伝歌の化身','マッチ神','現象種','B','mid',['遠距離','音','長期戦','領域'],[62,48,70,53,74,64],62,182,550,650,600,500,['ようき','すなお','おしゃべり'],330],
  ['chr_007','アストラ＝プレア','星願の化身','マッチ神','文化種','S','high',['遠距離','飛行','分析','長期戦'],[84,40,108,72,60,82],45,170,700,900,650,250,['れいせい','しんちょう','ひかえめ'],260],
  ['chr_008','カゼマッチ＝バサラ','風邪の化身','マッチ神','概念種','C','low',['近接','飛行','高揚','長期戦'],[74,52,28,80,57,34],70,185,800,300,400,650,['いじっぱり','せっかち','さみしがり'],145],
  ['chr_009','マッチ＝トツカイザー','鍛罰の化身','マッチ神','欲望種','C','low',['近接','短期決戦','拘束','高揚'],[76,58,40,86,22,50],850,520,850,400,350,600,['まじめ','がんこ','せっかち'],5],
  ['chr_010','マッチ＝デウマグナ','神魔の化身','マッチ神','概念種','F','low',['近接','大型','短期決戦','自信','領域'],[48,52,22,20,30,98],1100,400,200,250,450,850,['いじっぱり','がんこ','負けず嫌い'],285]
].map(([id,name,title,category,kind,grade,resolve,tags,s,base_weight,base_height,speed_bias,wisdom_bias,luck_bias,appetite_bias,likely_natures,hue]) => ({
  id,name,title,category,kind,grade,resolve,tags,
  stats:{atk:s[0],def:s[1],wis:s[2],spd:s[3],sta:s[4],amb:s[5]},
  story:true,combat:true,art:{base:1,r4:0,r5:0},hue,shape:0,
  base_weight,base_height,speed_bias,wisdom_bias,luck_bias,appetite_bias,likely_natures
}));

CHARACTERS.push(
  {
    id:'chr_011', name:'カンカラッチ', title:'踏切音の化身', category:'マッチ神', kind:'文化種', grade:'E', resolve:'mid',
    tags:['近接','音','領域','拘束'], stats:{atk:50,def:42,wis:55,spd:70,sta:45,amb:33}, story:true, combat:true,
    art:{base:1,r4:0,r5:0}, hue:20, shape:0, base_weight:65, base_height:210,
    speed_bias:800, wisdom_bias:500, luck_bias:450, appetite_bias:400, likely_natures:['せっかち','やんちゃ','おしゃべり']
  },
  {
    id:'chr_012', name:'マッチ＝ネガヴォイド', title:'心淵次元の化身', category:'マッチ神', kind:'概念種', grade:'S', resolve:'high',
    tags:['遠距離','分析','精神干渉','長期戦','拘束'], stats:{atk:58,def:52,wis:112,spd:78,sta:62,amb:72}, story:true, combat:true,
    art:{base:1,r4:0,r5:0}, hue:280, shape:0, base_weight:400, base_height:300,
    speed_bias:700, wisdom_bias:950, luck_bias:500, appetite_bias:200, likely_natures:['れいせい','しんちょう','ひかえめ']
  },
  {
    id:'chr_013', name:'タメリス', title:'備蓄の化身', category:'マッチ神', kind:'欲望種', grade:'A', resolve:'high',
    tags:['遠距離','飛行','長期戦','領域'], stats:{atk:48,def:62,wis:84,spd:66,sta:96,amb:70}, story:true, combat:true,
    art:{base:1,r4:0,r5:0}, hue:15, shape:0, base_weight:120, base_height:200,
    speed_bias:600, wisdom_bias:800, luck_bias:700, appetite_bias:900, likely_natures:['しっかりもの','しんちょう','くいしんぼう']
  }
);

CHARACTERS.push(
  {
    id:'chr_014', name:'マッチ＝オモルディア', title:'抱込の化身', category:'マッチ神', kind:'欲望種', grade:'C', resolve:'high',
    tags:['近接','大型','拘束','長期戦','精神干渉'], stats:{atk:45,def:88,wis:65,spd:22,sta:120,amb:8}, story:true, combat:true,
    art:{base:1,r4:0,r5:0}, hue:355, shape:0, base_weight:150, base_height:250,
    speed_bias:200, wisdom_bias:650, luck_bias:300, appetite_bias:250, likely_natures:['ひかえめ','しんちょう','がんこ']
  },
  {
    id:'chr_015', name:'マッチ＝スクアリオン', title:'集団行動の化身', category:'マッチ神', kind:'欲望種', grade:'B', resolve:'mid',
    tags:['近接','大型','領域','精神干渉'], stats:{atk:70,def:68,wis:85,spd:100,sta:75,amb:20}, story:true, combat:true,
    art:{base:1,r4:0,r5:0}, hue:195, shape:0, base_weight:1500, base_height:480,
    speed_bias:800, wisdom_bias:700, luck_bias:400, appetite_bias:750, likely_natures:['すなお','ようき','しっかりもの']
  },
  {
    id:'chr_016', name:'マッチ＝クロノロン', title:'独時の化身', category:'マッチ神', kind:'概念種', grade:'B', resolve:'mid',
    tags:['遠距離','音','拘束','領域','大型'], stats:{atk:62,def:72,wis:96,spd:118,sta:40,amb:58}, story:true, combat:true,
    art:{base:1,r4:0,r5:0}, hue:40, shape:0, base_weight:550, base_height:420,
    speed_bias:850, wisdom_bias:800, luck_bias:450, appetite_bias:150, likely_natures:['マイペース','しんちょう','れいせい']
  }
);
