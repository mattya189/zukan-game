// ガチャを増やすときは、この配列へ定義を追加する。
const GACHAS = [
  {
    id: 'normal_1', name: '通常ガチャ vol.1', banner: 'img/banner_normal_1.webp',
    price: 100, price10: 1000,
    chars: ['chr_001','chr_002','chr_003','chr_004','chr_005','chr_006','chr_007','chr_008','chr_009','chr_010'],
    guarantee: { count: 10, minRarity: 3 }, guaranteeText: '10連は★3確定！！',
    limited: false, open: true
  },
  {
    id: 'limited_1', name: '万象顕現ガチャ Vol.1', subtitle: '― 備蓄・心淵次元・踏切音 ―',
    banner: 'img/banner_limited_1.webp', price: 300, price10: 3000,
    chars: ['chr_013','chr_012','chr_011','chr_004','chr_001'],
    guarantee: { count: 10, minRarity: 4 }, guaranteeText: '10連で★4確定！！',
    limited: true, open: true,
    note: 'タメリス・ネガヴォイド・カンカラッチは、このガチャでしか出会えません（のちに通常ガチャへ加わります）'
  },
  {
    id: 'limited_2', name: '万象顕現ガチャ Vol.2', subtitle: '― 抱込・同調・独時 ―',
    banner: 'img/banner_limited_2.webp', price: 300, price10: 3000,
    chars: ['chr_014','chr_015','chr_016','chr_002','chr_008'],
    guarantee: { count: 10, minRarity: 4 }, guaranteeText: '10連で★4確定！！',
    limited: true, open: true,
    note: 'オモルディア・スクアリオン・クロノロンは、このガチャ限定です'
  }
];

const LIMITED_ONLY = ['chr_011','chr_012','chr_013','chr_014','chr_015','chr_016'];
const GACHA_RATES = [[1,50],[2,28],[3,15],[4,5.5],[5,1.5]];
