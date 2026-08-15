// src/run/fusions.js — the five sheng-pair spells (spec §4.7 表)
export const FUSIONS = {
  '1+3': { name: '业火燎原' }, // 木+火
  '3+4': { name: '地心火山' }, // 火+土
  '4+0': { name: '锋岩星阵' }, // 土+金
  '0+2': { name: '霜刃洪流' }, // 金+水
  '2+1': { name: '回春雷泽' } // 水+木
};
export const fusionKey = (wuxA, wuxB) => `${wuxA}+${wuxB}`;
export const isFusionId = (id) => typeof id === 'string' && id.startsWith('fusion:');
export const fusionParents = (id) => id.slice('fusion:'.length).split('+'); // [elementA, elementB]
export const fusionId = (a, b) => `fusion:${a}+${b}`;
