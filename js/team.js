// =====================================================================
// 集団戦（2対2・3対3）
//   ・1対1の部品（FIGHTER_KITS）をそのまま使い、並び・狙う相手・集団戦用の技を足す
//   ・前衛は狙われやすく、後衛は前衛が立っている間は狙われにくい
//   ・近接型は前衛で、遠距離型は後衛で力を出しやすい
//   ・相手チーム全員を倒したら勝ち。60ラウンドで決着しなければ、残り体力の合計の割合で判定
//   使い方：
//     runTeamBattle({
//       teams: [
//         [{ ch, ind, row: 'front' }, { ch, ind, row: 'back' }],   // 自分のチーム（2〜3体、同じキャラは不可）
//         [{ ch, ind, row: 'front' }, ...]                         // 相手のチーム
//       ],
//       stage: { name, features, events, enemyState(ctx, enemies, allies), enemyPower }, seed
//     })
// =====================================================================

const TEAM_RULES = {
  HP_MULT: { 2: 0.8, 3: 0.72 },   // 人数が多いほど体力を増やし、30〜50ラウンドに収める
  BACK_TARGET: 0.2,               // 前衛が立っているとき、後衛が狙われる確率
  BACK_TARGET_RANGED: 0.45,       // 遠距離型・飛行型が後衛を狙う確率
  FRONT_RANGED: 0.9,              // 遠距離型が前衛にいるときの与ダメージ
  BACK_MELEE: 0.72,               // 近接型が後衛にいるときの与ダメージ（飛行型は下がらない）
  FRONT_TAKEN: 1.0, BACK_TAKEN: 0.9
};

// ---------------------------------------------------------------------
// 集団戦用の技（キャラごと）。1対1の技に加えて使われる
// ---------------------------------------------------------------------
const TEAM_KITS = {
  // ヴァルガルド：万軍掃滅（敵全体）
  chr_001: {
    action(ctx, f) {
      const en = ctx.enemies(f);
      if (en.length >= 2 && ctx.round >= 6 && (f.flags.tLastSweep || 0) + 9 <= ctx.round && ctx.r.chance(0.5)) {
        f.flags.tLastSweep = ctx.round;
        return { area: true, name: '万軍掃滅', mult: 1.25, label: '翼を最大まで広げ、刃を一斉に展開して回転した――' };
      }
    }
  },
  // バースクライ：生誕震界・万生大哭が敵全体に
  chr_002: {
    action(ctx, f) {
      if (ctx.round % 7 === 0 && ctx.enemies(f).length >= 2) return { area: true, name: '生誕震界', mult: 0.95, sure: true, label: '巨大な産声が、空間そのものを震わせた――' };
      if (!f.flags.tBigCry && ctx.round >= 16 && ctx.r.chance(0.25)) {
        f.flags.tBigCry = true;
        return { area: true, name: '万生大哭', mult: 1.9, sure: true, big: true, label: '無数の産声が重なり、ひとつの巨大な叫びになった――',
          each(ctx, f, t) { const p = ctx.mental(f, t, 1); if (ctx.r.chance(0.25 + 0.45 * p)) t.stun = Math.max(t.stun, 1); } };
      }
    }
  },
  // マデランデス：不落城で味方も守る、群星は敵全体へ
  chr_003: {
    protect(ctx, f, tgt, dmg) { return f.flags.fort && tgt !== f ? dmg * 0.8 : dmg; },
    action(ctx, f) {
      if (f.meters.analysis >= 40 && ctx.enemies(f).length >= 2 && ctx.round % 6 === 3) return { area: true, name: '夢岩・墜星（群星）', mult: 0.85, sure: true, label: '大量の小さな岩が、隕石の夢を見て降り注いだ――' };
    }
  },
  // タルンルソルク：ちょこちょこ領域（敵全体の短足化）、かわいい認定（味方を傷つけた敵を優先）
  chr_004: {
    onAllyHurt(ctx, f, ally, src) { if (src && src.hp > 0 && ctx.r.chance(0.5)) { ctx.setTarget(f, src); if (!f.flags.tCertNote) { f.flags.tCertNote = true; ctx.say('skill', `${f.name}の「かわいい認定」！ ${ally.name}を傷つけた${src.name}を許さない`, { side: f.side, skill: 'かわいい認定' }); } } },
    action(ctx, f) {
      if (ctx.round % 8 === 4 && ctx.enemies(f).length >= 2) {
        return { special(ctx, f) {
          ctx.enemies(f).forEach(t => { const p = FIGHTER_KITS.chr_004.shrinkPower(t); addMod(t, { key: 'tShrink', stat: 'spd', mul: 1 - 0.18 * p, turns: 6 }); });
          f.meters.cute += 12;
          ctx.say('skill', `${f.name}の「ちょこちょこ領域」！ 敵がまとめて短足になり、ちょこちょこ歩きしかできなくなった`, { side: f.side, skill: 'ちょこちょこ領域' });
          if (ctx.r.chance(0.3)) ctx.say('info', `${f.name}はその光景を眺めて喜んでいる`, { side: f.side });
        } };
      }
    }
  },
  // ダラガルド：ダラ投げで敵同士をぶつける
  chr_005: {
    afterHit(ctx, f, t) {
      const others = ctx.enemies(f).filter(x => x !== t);
      if (others.length && ctx.r.chance(0.22)) { const o = ctx.r.pick(others); const d = ctx.damage(f, o, o.maxHp * 0.035, { name: 'ダラ投げ' }); ctx.say('hit', `${f.name}は${t.name}を放り投げ、${o.name}にぶつけた。${o.name}に${Math.round(d)}ダメージ`, { side: f.side, dmg: Math.round(d) }); }
    }
  },
  // カンタレイア：抱響壁で味方を守る（自分より強い）、味方をかばうと自分の守りが手薄に、奥義は仲間が多いほど強い
  chr_006: {
    protect(ctx, f, tgt, dmg) {
      if (tgt === f) return f.flags.tGuarding ? dmg * 1.12 : dmg;
      if (ctx.r.chance(0.2)) { f.flags.tGuarding = true; return dmg * 0.8; }
      return dmg;
    },
    onRound(ctx, f) {
      f.flags.tGuarding = false;
      if (ctx.round % 8 === 0) {
        const allies = ctx.allies(f);
        if (allies.length) { const w = allies.reduce((a, b) => (a.hp / a.maxHp < b.hp / b.maxHp ? a : b)); w.shield = Math.max(w.shield, w.maxHp * 0.07); ctx.say('skill', `${f.name}の「抱響壁」！ 赤い伝響が${w.name}を包み込んだ`, { side: f.side, skill: '抱響壁' }); }
      }
    },
    action(ctx, f) {
      if (!f.flags.tWorld && ctx.round >= 20 && ctx.r.chance(0.3)) {
        f.flags.tWorld = true;
        const n = ctx.allies(f).length;
        return { area: true, name: '世界よ、この歌を聞け', mult: 1.2 + 0.45 * n, big: true, sure: true, label: `仲間${n}人の「まだ終わりたくない」を受け取り、巨大な伝響の輪が空に現れた――` };
      }
    }
  },
  // アストラ＝プレア：流星観測（敵全体）、懇願星（味方が追い詰められているほど強い）、後衛も狙い撃つ
  chr_007: {
    targetBack: 0.6,
    action(ctx, f) {
      if (ctx.round % 9 === 5 && ctx.enemies(f).length >= 2) return { area: true, name: '流星観測', mult: 0.9, sure: f.meters.obs >= 50, label: '味方を避けるように計算された疑似流星が降り注いだ――' };
      const hurt = ctx.allies(f).filter(a => a.hp / a.maxHp < 0.35);
      if (hurt.length && (f.flags.tPlea || 0) + 10 <= ctx.round) {
        f.flags.tPlea = ctx.round;
        return { name: '懇願星', mult: 1.6 + 0.5 * hurt.length, big: true, label: `「助けて」「負けないで」――${hurt.map(h => h.name).join('と')}の懇願が、一つの巨大な星になった。` };
      }
    }
  },
  // バサラ：爆嚏暴風は味方も巻き込む、風邪胞子は敵全体に
  chr_008: {
    onRound(ctx, f) {
      if (ctx.round % 3 === 0) ctx.enemies(f).forEach(t => { if (t === ctx.foe(f)) return; t.meters.cold = Math.min(10, (t.meters.cold || 0) + 1); addMod(t, { key: 'cold', stat: 'atk', mul: 1 - t.meters.cold * 0.02, turns: 99 }); });
    },
    action(ctx, f) {
      if (ctx.r.chance(0.08) && ctx.enemies(f).length >= 2) {
        return { area: true, name: '爆嚏暴風', mult: 1.3, big: true, label: '「ハックショォォォォォイ！！」――止められないくしゃみが、敵も味方も吹き飛ばした',
          after(ctx, f) { ctx.allies(f).forEach(a => { const d = ctx.damage(f, a, a.maxHp * 0.03, { friendly: true }); ctx.say('info', `${a.name}も巻き込まれた（${Math.round(d)}ダメージ）`, { side: a.side }); }); } };
      }
    }
  },
  // トツカイザー：懲練ワイヤーが敵全体の逃げ道を減らす（倒れた相手は狙わない：狙いの選び方で対応）
  chr_009: {
    onRound(ctx, f) { if (ctx.round >= 4) ctx.enemies(f).forEach(t => addMod(t, { key: 'wireAll', stat: 'spd', mul: 1 - Math.min(0.2, ctx.round * 0.02), turns: 99 })); }
  },

  // カンカラッチ：警界で敵全体を惑わせる
  chr_011: {
    onRound(ctx, f) {
      if (ctx.round % 6 === 2) {
        const en = ctx.enemies(f);
        if (en.length >= 2) {
          en.forEach(t => addMod(t, { key: 'kankaiAll', stat: 'wis', mul: 1 - 0.12 * FIGHTER_KITS.chr_011.noiseRate(f, t), turns: 3 }));
          ctx.say('skill', `${f.name}の「警界」！ 四方から警報音が反響し、敵全体が${f.name}の位置を見失った`, { side: f.side, skill: '警界' });
        }
      }
    },
    action(ctx, f) {
      if (ctx.round % 9 === 5 && ctx.enemies(f).length >= 2) return { area: true, name: 'カンカン連打（乱打）', mult: 1.0, label: '「カン、カン、カン、カン、カン！」――踏切のリズムで敵全体を殴り回る' };
    }
  },

  // ネガヴォイド：疑心連鎖と万心解析。後衛も狙える
  chr_012: {
    targetBack: 0.7,
    onRound(ctx, f) {
      const en = ctx.enemies(f);
      if (en.length >= 2 && ctx.round % 6 === 4) {
        en.forEach(t => { const p = ctx.mental(f, t, 1); addMod(t, { key: 'doubt', stat: 'atk', mul: 1 - 0.12 * p, turns: 3 }); });
        ctx.say('skill', `${f.name}の「疑心連鎖」！ 「本当に味方なのか？」――敵チームの連携が崩れていく`, { side: f.side, skill: '疑心連鎖' });
      }
      if (!f.flags.tAll && f.meters.read >= 60 && en.length >= 2) {
        f.flags.tAll = true;
        en.forEach(t => { const p = ctx.mental(f, t, 1); addMod(t, { key: 'allRead', stat: 'wis', mul: 1 - 0.15 * p, turns: 99 }); });
        ctx.say('skill', `${f.name}の「万心解析」！ 戦場が、無数の感情が繋がった巨大な地図として見えている`, { side: f.side, skill: '万心解析' });
      }
    }
  },

  // タメリス：味方を立て直す支援役
  chr_013: {
    onStart(ctx, f) {
      ctx.allies(f).forEach(a => { a.shield = Math.max(a.shield, a.maxHp * 0.07); });
      f.meters.stock -= 10;
      ctx.say('skill', `${f.name}の「先払い治療」！ 戦う前に、味方全員へ生命力を預けておいた`, { side: f.side, skill: '先払い治療' });
    },
    onRound(ctx, f) {
      const K = FIGHTER_KITS.chr_013;
      if (f.meters.stock <= 0) return;
      const allies = ctx.allies(f);
      // 備蓄共有圏：味方が少しずつ回復する
      if (ctx.round % 3 === 0 && allies.length) {
        const rate = Math.max(0.3, f.meters.stock / 100);
        allies.forEach(a => { a.hp = Math.min(a.maxHp, a.hp + a.maxHp * 0.022 * rate); });
        f.meters.stock -= 6;
        if (ctx.round % 9 === 0) ctx.say('skill', `${f.name}の「備蓄共有圏」！ 足りないものが、備蓄から自動で味方へ供給されていく`, { side: f.side, skill: '備蓄共有圏' });
      }
      // 緊急備蓄解放：瀕死の味方を戻す
      const dying = allies.filter(a => a.hp < a.maxHp * 0.3);
      if (dying.length && !f.flags.tEmergency && f.meters.stock >= 25) {
        f.flags.tEmergency = true;
        const rate = Math.max(0.3, f.meters.stock / 100);
        dying.forEach(a => { const amount = Math.round(a.maxHp * 0.22 * rate); a.hp = Math.min(a.maxHp, a.hp + amount); });
        f.meters.stock -= 30;
        ctx.say('skill', `${f.name}の「緊急備蓄解放」！ ${dying.map(a => a.name).join('と')}へ生命力を一気に流し込んだ`, { side: f.side, skill: '緊急備蓄解放' });
      }
      // 百年備蓄・大放出：全員まとめて立て直す
      if (!f.flags.tCentury && f.meters.stock >= 45 && allies.concat([f]).filter(a => a.hp < a.maxHp * 0.45).length >= 2) {
        f.flags.tCentury = true;
        const rate = Math.max(0.3, f.meters.stock / 100);
        allies.concat([f]).forEach(a => { a.hp = Math.min(a.maxHp, a.hp + a.maxHp * 0.16 * rate); });
        f.meters.stock -= 45;
        ctx.say('skill', `${f.name}の「百年備蓄・大放出」！ 何十年ぶんもの備蓄が解放され、チーム全体が息を吹き返した`, { side: f.side, skill: '百年備蓄・大放出' });
      }
    }
  },

  // デウマグナ：偽神魔界は狭く、自分だけが強くなる（集団戦用の技はない）
  chr_010: {}
};

function runTeamBattle(opts) {
  const r = battleRng(opts.seed ?? Math.floor(Math.random() * 1e9));
  const stage = { name: '無名の荒野', features: [], events: [], ...opts.stage };
  stage.features = [...(stage.features || [])];
  const size = Math.max(opts.teams[0].length, opts.teams[1].length);
  const ids = t => t.map(m => m.ch.id);
  for (const t of opts.teams) if (new Set(ids(t)).size !== t.length) throw new Error('同じキャラを同じチームに入れることはできません');

  const teams = opts.teams.map((t, side) => t.map((m, i) => {
    const f = makeFighter(m.ch, m.ind, side, stage);
    f.row = m.row === 'back' ? 'back' : 'front';
    f.slot = i;
    f.maxHp = f.hp = Math.round(f.maxHp * (TEAM_RULES.HP_MULT[size] || 1.3));
    f.tkit = TEAM_KITS[m.ch.id] || {};
    return f;
  }));
  const all = [...teams[0], ...teams[1]];
  applyStageFeatures(stage, all);
  for (const f of all) f.form = r.range(0.82, 1.18);
  const log = [];
  const alive = side => teams[side].filter(f => f.hp > 0 && !f.forfeit);
  const targetOf = new Map();

  const ctx = {
    r, stage, log, round: 0, teams, firstHit: null, team: true,
    partySize: size, teamSize: size,
    A: teams[0][0], B: teams[1][0],
    allies: f => alive(f.side).filter(x => x !== f),
    enemies: f => alive(1 - f.side),
    setTarget: (f, t) => targetOf.set(f, t),
    foe(f) {
      let t = targetOf.get(f);
      if (!t || t.hp <= 0 || t.forfeit) { t = pickTarget(f); targetOf.set(f, t); }
      return t || teams[1 - f.side][0];
    },
    say(kind, text, extra = {}) { log.push({ round: ctx.round, kind, text, hp: all.map(x => Math.max(0, Math.round(x.hp))), ...extra }); },
    line(f, key) { const arr = f.kit.lines[key]; return arr ? r.pick(arr) : ''; },
    feat: name => stage.features.includes(name),
    mental(src, tgt, power) {
      let p = power * tgt.mentalRes;
      if (ctx.feat('生命の気配')) p *= 1.35;
      // カンタレイアの抱歌領域：味方の精神を支える
      if (ctx.allies(tgt).some(a => a.ch.id === 'chr_006')) p *= 0.6;
      if (tgt.kit.onMental) p = tgt.kit.onMental(ctx, tgt, src, p) ?? p;
      return p;
    },
    evasionNegated: f => f.mods.some(m => m.negateEvasion) || f.bind > 0,
    damage(src, tgt, amount, info = {}) { return applyDamage(ctx, src, tgt, amount, info); },
    attack(src, tgt, opt) { return doAttack(ctx, src, tgt, opt); },
    // 並びの効果
    rowMul(f, foe) {
      let m = 1;
      if (f.row === 'front' && f.tags.has('遠距離')) m *= TEAM_RULES.FRONT_RANGED;
      if (f.row === 'back' && f.tags.has('近接') && !f.tags.has('飛行')) m *= TEAM_RULES.BACK_MELEE;
      m *= foe.row === 'back' ? TEAM_RULES.BACK_TAKEN : TEAM_RULES.FRONT_TAKEN;
      m *= (typeof TEAM_TUNE !== 'undefined' && TEAM_TUNE[f.ch.id]) || 1;   // 集団戦用の強さの補正値
      return m;
    },
    // 味方をかばう効果
    beforeDamage(src, tgt, dmg, info) {
      let d = dmg;
      for (const g of ctx.allies(tgt).concat([tgt])) if (g.tkit.protect && g.hp > 0) d = g.tkit.protect(ctx, g, tgt, d);
      if (src && src.side !== tgt.side) for (const a of ctx.allies(tgt)) a.tkit.onAllyHurt?.(ctx, a, tgt, src);
      if (tgt.kit.onFallWatch) tgt.kit.onFallWatch(ctx, tgt);
      return d;
    }
  };
  function pickTarget(f) {
    const en = alive(1 - f.side);
    if (!en.length) return null;
    const front = en.filter(x => x.row === 'front'), back = en.filter(x => x.row === 'back');
    let pool = front.length ? front : back;
    const backRate = (f.tkit.targetBack ?? (f.tags.has('遠距離') || f.tags.has('飛行') ? TEAM_RULES.BACK_TARGET_RANGED : TEAM_RULES.BACK_TARGET));
    if (front.length && back.length && r.chance(backRate)) pool = back;
    // 弱っている相手を少し狙いやすい
    return pool.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp + r.range(-0.25, 0.25))[0];
  }

  stage.setup?.(ctx);
  ctx.say('stage', `舞台：${stage.name}${stage.features.length ? `（${stage.features.join('・')}）` : ''}　${teams[0].length}対${teams[1].length}`);
  for (const f of all) {
    if (f.form >= 1.1) ctx.say('info', `${f.name}は絶好調だ`, { side: f.side });
    ctx.say('talk', `${f.name}「${ctx.line(f, 'intro')}」`, { side: f.side });
  }
  stage.enemyState?.(ctx, teams[1], teams[0]);
  for (const f of all) f.kit.onStart?.(ctx, f, ctx.foe(f));

  const sideDone = side => alive(side).length === 0;
  while (!sideDone(0) && !sideDone(1) && ctx.round < BATTLE_RULES.MAX_ROUNDS) {
    ctx.round++;
    ctx.say('round', `ラウンド ${ctx.round}`);
    if (ctx.feat('異界') && ctx.round % 3 === 0) { for (const f of all) f.mods = f.mods.filter(m => m.permanent); ctx.say('event', '異界の揺らぎで、全員の強化と弱体化が消えた'); }
    for (const ev of stage.events || []) if ((ev.at && ev.at === ctx.round) || (ev.every && ctx.round % ev.every === 0)) ev.run(ctx);
    for (const f of all) if (f.hp > 0 && !f.forfeit) { targetOf.delete(f); f.kit.onRound?.(ctx, f, ctx.foe(f)); f.tkit.onRound?.(ctx, f); }
    const order = all.filter(f => f.hp > 0 && !f.forfeit)
      .sort((x, y) => (statOf(y, 'spd') * r.range(0.85, 1.15) + (y.kit.initiative?.(ctx, y) || 0)) - (statOf(x, 'spd') * r.range(0.85, 1.15) + (x.kit.initiative?.(ctx, x) || 0)));
    for (const f of order) {
      if (sideDone(0) || sideDone(1)) break;
      if (f.hp <= 0 || f.forfeit) continue;
      teamAct(ctx, f);
    }
    for (const f of all) {
      if (f.hp <= 0 && !f.flags.tDown) { f.flags.tDown = true; ctx.say('big', `${f.name}が倒れた`, { side: f.side }); }
      if (f.hp <= 0) continue;
      f.kit.onRoundEnd?.(ctx, f, ctx.foe(f));
      for (const m of f.mods) m.turns--;
      const expired = f.mods.filter(m => m.turns <= 0 && m.onExpire);
      f.mods = f.mods.filter(m => m.turns > 0);
      expired.forEach(m => m.onExpire(ctx, f));
      if (f.bind > 0) { f.rec.bound = true; f.rec.boundRounds++; f.bind--; }
      f.rec.minHp = Math.min(f.rec.minHp, Math.max(0, f.hp) / f.maxHp);
      if (ctx.round === 10) f.rec.minHpAtR10 = f.rec.minHp;
    }
  }

  // 決着
  let winner = null, reason = '';
  if (sideDone(1) && !sideDone(0)) { winner = 0; reason = '相手チームが全員倒れた'; }
  else if (sideDone(0) && !sideDone(1)) { winner = 1; reason = '自分のチームが全員倒れた'; }
  else if (sideDone(0) && sideDone(1)) { reason = '相打ち'; }
  else {
    const ratio = side => teams[side].reduce((s, f) => s + Math.max(0, f.hp), 0) / teams[side].reduce((s, f) => s + f.maxHp, 0);
    const a = ratio(0), b = ratio(1);
    winner = a === b ? null : a > b ? 0 : 1;
    reason = `${BATTLE_RULES.MAX_ROUNDS}ラウンドを戦い抜き、残り体力の合計で判定`;
    ctx.say('info', reason);
  }
  if (winner !== null) {
    const w = alive(winner)[0] || teams[winner][0];
    ctx.say('talk', `${w.name}「${ctx.line(w, 'win')}」`, { side: winner });
  }
  return {
    winner, reason, rounds: ctx.round, log, stage,
    fighters: all.map(f => ({ side: f.side, id: f.ch.id, name: f.name, row: f.row, hp: Math.max(0, Math.round(f.hp)), maxHp: f.maxHp, grade: f.grade })),
    state: all.map(f => ({ side: f.side, id: f.ch.id, rec: f.rec, flags: f.flags, meters: f.meters, resolve: f.resolve, forfeit: f.forfeit, hp: f.hp, maxHp: f.maxHp }))
  };
}

// 集団戦の1回の行動：集団戦用の技 → 1対1の技、の順に考える
function teamAct(ctx, f) {
  const foe = ctx.foe(f);
  if (!foe) return;
  if (f.stun > 0) { f.stun--; f.rec.stunned++; if (f.kit.onStunned?.(ctx, f, foe)) return; ctx.say('info', `${f.name}は動けない`, { side: f.side }); return; }
  if (!f.ambUsed && f.hp <= f.maxHp * 0.3) {
    f.ambUsed = true;
    addMod(f, { key: 'amb', stat: 'atk', mul: 1 + f.base.amb / 600, turns: 99, permanent: true });
    ctx.say('talk', `${f.name}「${ctx.line(f, 'low')}」`, { side: f.side, note: '野望力で攻撃が上がった' });
  }
  const t = f.tkit.action?.(ctx, f);
  if (t) {
    if (t.special) { t.special(ctx, f); return; }
    if (t.area) {
      ctx.say(t.big ? 'big' : 'skill', `${f.name}の「${t.name}」！ ${t.label || ''}`, { side: f.side, skill: t.name });
      const targets = ctx.enemies(f);
      let total = 0;
      for (const x of targets) {
        const before = x.hp;
        doAttack(ctx, f, x, { ...t, label: '', name: t.name, mult: t.mult / Math.sqrt(targets.length) * 1.1, big: false, quiet: true });
        total += Math.max(0, before - x.hp);
        t.each?.(ctx, f, x);
      }
      t.after?.(ctx, f);
      return;
    }
    doAttack(ctx, f, foe, t);
    return;
  }
  const action = f.kit.chooseAction?.(ctx, f, foe, false) || { name: ctx.line(f, 'attack') };
  if (action.skip) { if (action.text) ctx.say('info', action.text, { side: f.side }); return; }
  if (action.special) { action.special(ctx, f, foe); return; }
  const before = foe.hp;
  doAttack(ctx, f, foe, action);
  if (foe.hp < before) f.tkit.afterHit?.(ctx, f, foe);
}

// 集団戦用の強さの補正値（1対1の KIT_TUNE に重ねて掛かる）。tools/team-sim.js --calibrate で合わせる
const TEAM_TUNE = { chr_001: 0.885, chr_002: 0.898, chr_003: 1.034, chr_004: 1.27, chr_005: 0.759, chr_006: 0.739, chr_007: 1.15, chr_008: 1.353, chr_009: 0.747, chr_010: 0.972, chr_011: 1.063, chr_012: 1.158, chr_013: 1.016 };
