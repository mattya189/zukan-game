// 個体値から解放される装備。戦闘へは loadout として渡し、自動で発動する。
const SKILL_MAX_COST = 8;
const SKILL_CALM_NATURES = ['れいせい','しんちょう','ひかえめ','まじめ','がんこ'];
const SKILL_WEAK_TAGS = ['大型','飛行','領域','精神干渉','長期戦'];
const skillNeed = (ok, text) => ({ ok, text: ok ? '条件達成' : text });
const SKILL_DEFS = {
  sk_tekkabi:{name:'鉄壁の重量',kind:'passive',cost:2,desc:'常に受けるダメージを15%減らす。',condition:(i,c)=>i.weight>=c.base_weight*1.3,requirement:(i,c)=>skillNeed(i.weight>=c.base_weight*1.3,`体重があと${Math.max(0,c.base_weight*1.3-i.weight).toFixed(1)}kg必要`),trigger:()=>false,cooldown:0,apply(){}},
  sk_shigojou:{name:'執念',kind:'passive',cost:2,desc:'一度だけ、倒れるダメージをHP1で耐える。',condition:(i,c)=>i.luck<=c.luck_bias*.7,requirement:(i,c)=>skillNeed(i.luck<=c.luck_bias*.7,`うんをあと${Math.max(0,Math.ceil(i.luck-c.luck_bias*.7))}下げる必要`),trigger:()=>false,cooldown:0,apply(){}},
  sk_kamihitoe:{name:'紙一重',kind:'passive',cost:3,desc:'被弾時20%でダメージを0にする（再発動まで3ラウンド）。',condition:(i,c)=>i.weight<=c.base_weight*.7,requirement:(i,c)=>skillNeed(i.weight<=c.base_weight*.7,`体重をあと${Math.max(0,i.weight-c.base_weight*.7).toFixed(1)}kg軽くする必要`),trigger:()=>false,cooldown:3,apply(){}},
  sk_fukuhachibu:{name:'腹八分の集中力',kind:'skill',cost:1,desc:'16ラウンド目以降、その番の命中率+8%。',condition:(i,c)=>i.appetite<=c.appetite_bias*.7,requirement:(i,c)=>skillNeed(i.appetite<=c.appetite_bias*.7,`食欲をあと${Math.max(0,Math.ceil(i.appetite-c.appetite_bias*.7))}下げる必要`),trigger:ctx=>ctx.round>15,cooldown:0,apply(ctx,f,foe,a){a.accuracyBonus=(a.accuracyBonus||0)+.08;}},
  sk_genkai:{name:'限界突破',kind:'skill',cost:3,desc:'HP40%以下になった次の番に一度、与ダメージ+80%。その後2ターン被ダメージ+25%。',condition:i=>i.power>=1000,requirement:i=>skillNeed(i.power>=1000,`パワーがあと${Math.max(0,1000-i.power)}必要`),trigger:(ctx,f)=>f.hp<=f.maxHp*.4&&!f.flags.sk_genkai, cooldown:0,apply(ctx,f,foe,a){f.flags.sk_genkai=true;a.mult=(a.mult??1)*1.8;f.flags.skillVulnerable=2;}},
  sk_jakuten:{name:'弱点看破',kind:'passive',cost:2,desc:'登録された弱点タグを持つ相手への与ダメージ+10%。',condition:i=>i.wisdom>=500,requirement:i=>skillNeed(i.wisdom>=500,`かしこさがあと${Math.max(0,500-i.wisdom)}必要`),trigger:(ctx,f,foe)=>[...foe.tags].some(x=>SKILL_WEAK_TAGS.includes(x)),cooldown:0,apply(ctx,f,foe,a){a.mult=(a.mult??1)*1.1;}},
  sk_kaisen:{name:'開戦の合図',kind:'skill',cost:3,desc:'5ラウンド以内に3回先攻すると一度、必中・与ダメージ+80%。',condition:i=>i.speed>=500,requirement:i=>skillNeed(i.speed>=500,`すばやさがあと${Math.max(0,500-i.speed)}必要`),trigger:(ctx,f)=>ctx.round<=5&&(f.meters.skillFirst||0)>=3&&!f.flags.sk_kaisen,cooldown:0,apply(ctx,f,foe,a){f.flags.sk_kaisen=true;a.sure=true;a.mult=(a.mult??1)*1.8;}},
  sk_dojinu:{name:'動じぬ心',kind:'passive',cost:1,desc:'敵から状態異常を受けた直後、50%で効果を1ターン短縮。',condition:i=>SKILL_CALM_NATURES.includes(i.nature),requirement:i=>skillNeed(SKILL_CALM_NATURES.includes(i.nature),'性格が れいせい／しんちょう／ひかえめ／まじめ／がんこ のいずれか必要'),trigger:()=>false,cooldown:0,apply(){}}
};
function skillCost(ids){return (ids||[]).reduce((n,id)=>n+(SKILL_DEFS[id]?.cost||0),0);}
