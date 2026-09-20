// ---------------------------------------------------------------------
// 守護者
//   ガチャには出ず、デッキとは別に1体を選んでバトルを支える。
// ---------------------------------------------------------------------
const GUARDIANS = [
  {
    id: 'gd_001', name: 'マデランデス', title: '夢岩の魔導守護者',
    story: true, art: { base: 1 }, hue: 40, shape: 2,
    hp: 100, gaugeRate: 1.5,
    unlock: { type: 'start' },
    passive: {
      name: '夢岩の加護',
      text: '土属性の味方は攻撃+1。土属性の味方が登場した時、その体力+1',
      effects: [
        { type: 'elementAtk', element: '土', amount: 1 },
        { type: 'elementPlayHp', element: '土', amount: 1 }
      ]
    },
    skills: [
      { name: '岩夢', uses: 2, text: '土属性の味方1体に、もう一度攻撃させるか、盾を与える',
        effect: { type: 'dreamRock', element: '土' } },
      { name: '夢創造', uses: 2, text: '岩（土・攻撃3／体力5）を後列に呼ぶ',
        effect: { type: 'summon', token: { name: '夢岩', atk: 3, hp: 5, element: '土', keywords: [], prefer: 'back' } } }
    ],
    ultimate: {
      name: '夢錯覚', text: '2ターンの間、味方全員を土属性にする',
      effect: { type: 'elementShift', target: 'allAllies', element: '土', turns: 2 }
    }
  },
  {
    id: 'gd_enemy_guard', name: '草原の番人', title: '守りの守護者',
    story: false, art: { base: 0 }, hue: 110, shape: 0,
    hp: 70, gaugeRate: 1.0, unlock: { type: 'none' }, passive: null,
    skills: [
      { name: '守りの陣', uses: 2, text: '味方全員に盾を与える', effect: { type: 'shield', target: 'allAllies' } },
      { name: '再編', uses: 2, text: '一番弱っている味方を3回復', effect: { type: 'heal', target: 'lowestAlly', amount: 3 } }
    ],
    ultimate: { name: '大城壁', text: '味方全員に盾と体力+2', effects: [
      { type: 'shield', target: 'allAllies' },
      { type: 'buff', target: 'allAllies', hp: 2 }
    ] }
  },
  {
    id: 'gd_enemy_war', name: '戦場の指揮官', title: '攻めの守護者',
    story: false, art: { base: 0 }, hue: 5, shape: 2,
    hp: 70, gaugeRate: 1.0, unlock: { type: 'none' }, passive: null,
    skills: [
      { name: '総攻撃', uses: 2, text: '味方全員の攻撃+2', effect: { type: 'buff', target: 'allAllies', atk: 2 } },
      { name: '突撃', uses: 1, text: '味方1体がもう一度攻撃', effect: { type: 'extraAttack', target: 'randomAlly' } }
    ],
    ultimate: { name: '全軍突撃', text: '味方全員がもう一度攻撃', effect: { type: 'extraAttack', target: 'allAllies' } }
  },
  {
    id: 'gd_enemy_mist', name: '霧の主', title: '霧毒の守護者',
    story: false, art: { base: 0 }, hue: 270, shape: 1,
    hp: 85, gaugeRate: 1.0, unlock: { type: 'none' },
    passive: { name: '霧毒', text: 'ターン終了時、敵1体に毒1', effects: [
      { type: 'turnEndStatus', target: 'randomEnemy', status: 'poison', amount: 1 }
    ] },
    skills: [
      { name: '目くらまし', uses: 2, text: '敵全体の攻撃-1', effect: { type: 'buff', target: 'allEnemies', atk: -1 } },
      { name: '引き寄せ', uses: 2, text: 'カードを2枚引く', effect: { type: 'draw', amount: 2 } }
    ],
    ultimate: { name: '濃霧', text: '敵全体を凍結し、毒2', effects: [
      { type: 'status', target: 'allEnemies', status: 'freeze', amount: 1 },
      { type: 'status', target: 'allEnemies', status: 'poison', amount: 2 }
    ] }
  }
];

const GUARDIAN_MAP = Object.fromEntries(GUARDIANS.map(g => [g.id, g]));
const DEFAULT_GUARDIAN_ID = 'gd_001';
const DEFAULT_ENEMY_GUARDIAN_ID = 'gd_enemy_guard';
