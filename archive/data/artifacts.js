// ---------------------------------------------------------------------
// アーティファクト（場に出ない、能力を発動するだけのカード）
//   mode: 'instant' … 使うとすぐ effect が発動して消える
//   mode: 'relic'   … 場の外に設置され、ability のきっかけのたびに発動する（最大2つ）
//   price … 工房で作るのに必要なコイン（0 は最初から持っている）
//   art … 画像の版番号（0 ならアイコン）。1 以上なら img/（id）_base_（版番号）.webp を読む
// ---------------------------------------------------------------------
const ARTIFACT_LIST = [
  { id: 'art_001', name: '火花の石',   icon: '🔥', color: '#E4572E', cost: 1, price: 0,    mode: 'instant', effect: { type: 'damage', target: 'randomEnemy', amount: 2 } },
  { id: 'art_002', name: '薬草の束',   icon: '🌿', color: '#2FA36B', cost: 1, price: 0,    mode: 'instant', effect: { type: 'heal', target: 'leader', amount: 4 } },
  { id: 'art_003', name: '呼び笛',     icon: '📯', color: '#9A6B3F', cost: 2, price: 0,    mode: 'instant', effect: { type: 'summon', token: { name: '笛の子分', atk: 2, hp: 2, keywords: [] } } },
  { id: 'art_004', name: '知恵の書',   icon: '📘', color: '#2E86DE', cost: 2, price: 500,  mode: 'instant', effect: { type: 'draw', amount: 2 } },
  { id: 'art_005', name: '追い風の羽', icon: '🪶', color: '#1FA38A', cost: 2, price: 600,  mode: 'instant', effect: { type: 'buff', target: 'allAllies', atk: 1 } },
  { id: 'art_006', name: '雷鳴の太鼓', icon: '🥁', color: '#D9A300', cost: 4, price: 900,  mode: 'instant', effect: { type: 'damage', target: 'allEnemies', amount: 2 } },
  { id: 'art_007', name: '氷の砂時計', icon: '⏳', color: '#7CC8F2', cost: 4, price: 900,  mode: 'instant', effect: { type: 'status', status: 'freeze', target: 'allEnemies' } },
  { id: 'art_008', name: '見張りの旗', icon: '🚩', color: '#E6394A', cost: 2, price: 1000, mode: 'relic', ability: { trigger: 'turnEnd', effect: { type: 'shield', target: 'randomAlly' } } },
  { id: 'art_009', name: '豊穣の鍋',   icon: '🍲', color: '#E0A800', cost: 1, price: 700,  mode: 'relic', ability: { trigger: 'allyPlay', effect: { type: 'buff', target: 'playedAlly', hp: 1 } } },
  { id: 'art_010', name: '弔いの鐘',   icon: '🔔', color: '#7050A8', cost: 2, price: 900,  mode: 'relic', ability: { trigger: 'allyDeath', effect: { type: 'damage', target: 'enemyLeader', amount: 2 } } },
  { id: 'art_011', name: '月のランプ', icon: '🏮', color: '#D9A300', cost: 2, price: 1200, mode: 'relic', ability: { trigger: 'turnStart', effect: { type: 'heal', target: 'allAllies', amount: 1 } } },
  { id: 'art_012', name: '呪いの人形', icon: '🪆', color: '#7050A8', cost: 2, price: 900,  mode: 'relic', ability: { trigger: 'enemyDeath', effect: { type: 'buff', target: 'randomAlly', atk: 1, hp: 1 } } }
];
