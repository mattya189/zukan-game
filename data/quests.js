// ---------------------------------------------------------------------
// クエスト
// ---------------------------------------------------------------------
const QUESTS = [
  {
    id: 'q1', name: 'はじまりの草原', level: 1,
    story: '草原のいきものたちが、腕試しを申しこんできた。',
    enemy: { name: '草原の番人', leader: 'chr_007', policy: 'defend', hp: 25,
      deck: ['chr_007', 'chr_017', 'chr_025', 'chr_009', 'chr_001', 'chr_017', 'chr_025', 'chr_014', 'chr_019', 'chr_027', 'chr_009', 'chr_021', 'chr_017', 'chr_025', 'chr_014', 'chr_019', 'chr_007', 'art_002', 'art_001', 'chr_027'] },
    rules: [], goalTurns: null,
    reward: { first: 500, repeat: 150 }
  },
  {
    id: 'q2', name: '霧の森の奥へ', level: 2,
    story: '深い霧が、森に入る者の体をむしばむ。',
    enemy: { name: '霧の森の住人', leader: 'chr_010', policy: 'attack', hp: 85,
      deck: ['chr_010', 'chr_029', 'chr_027', 'chr_028', 'chr_025', 'chr_003', 'chr_002', 'chr_021', 'chr_030', 'chr_013', 'chr_017', 'chr_019', 'chr_010', 'chr_029', 'chr_027', 'chr_028', 'art_010', 'art_012', 'art_001', 'chr_025'] },
    rules: [{ type: 'laneNoFlying', lane: 1 }, { type: 'turnEndPoisonAll', from: 6 }],
    goalTurns: 16,
    reward: { first: 800, repeat: 250 }
  },
  {
    id: 'q3', name: '台所の大宴会', level: 2,
    story: 'いい匂いにつられて、台所の仲間が集まってきた。',
    enemy: { name: '料理長', leader: 'chr_009', policy: 'attack', hp: 85,
      deck: ['chr_009', 'chr_014', 'chr_030', 'chr_013', 'chr_006', 'chr_015', 'chr_001', 'chr_017', 'chr_005', 'chr_007', 'chr_021', 'chr_002', 'chr_009', 'chr_014', 'chr_030', 'art_009', 'art_002', 'chr_006', 'chr_013', 'chr_001'] },
    rules: [{ type: 'tribeBuff', tribe: '台所', atk: 1, hp: 2 }],
    goalTurns: null,
    reward: { first: 800, repeat: 250 }
  },
  {
    id: 'q4', name: '空中戦', level: 3,
    story: '強い風の中では、地面を歩くものは踏んばれない。',
    enemy: { name: '風の一団', leader: 'chr_008', policy: 'attack', hp: 45,
      deck: ['chr_008', 'chr_002', 'chr_018', 'chr_019', 'chr_020', 'chr_003', 'chr_024', 'chr_025', 'chr_011', 'chr_026', 'chr_013', 'chr_005', 'chr_008', 'chr_002', 'chr_019', 'chr_018', 'art_005', 'art_004', 'chr_020', 'chr_003'] },
    rules: [{ type: 'nonFlyingAtkHalf' }, { type: 'costLimit', max: 6 }],
    goalTurns: null,
    reward: { first: 1200, repeat: 400 }
  },
  {
    id: 'q5', name: 'ボス：霧の主', level: 4,
    story: '森の最奥で、霧そのものが形をとった。',
    enemy: { name: '霧の主', leader: 'chr_028', policy: 'big', hp: 42, ultimates: true,
      deck: ['chr_028', 'chr_010', 'chr_029', 'chr_030', 'chr_027', 'chr_012', 'chr_022', 'chr_024', 'chr_023', 'chr_003', 'chr_020', 'chr_013', 'chr_028', 'chr_010', 'chr_029', 'chr_012', 'art_006', 'art_007', 'art_011', 'chr_022'] },
    rules: [{ type: 'bossPulse', every: 3, amount: 1 }],
    goalTurns: 20,
    reward: { first: 3000, repeat: 800 }
  }
];
