import type { ArticulatoryPose } from './ptb-ipa-presets';

export interface DialectTone {
  id?: string;
  name: string;
  chao: string;
  pts: number[];
  checked: boolean;
  f0?: { u: number; hz: number }[];
}

export interface DialectSandhiRule {
  en: boolean;
  type: 'lexical' | 'word_pattern' | 'pair';
  trig: string;
  out: string;
  note: string;
}

export interface DialectPack {
  name: string;
  summary: string;
  closureNote: string;
  pose: ArticulatoryPose;
  tones: DialectTone[];
  sandhi: DialectSandhiRule[];
  phrases: Record<string, [string, string]>;
}

export const DIALECT_PACKS: Record<string, DialectPack> = {
  "yue": {
    "name": "广州粤语 (yue-GZ) · 测试示例",
    "summary": "测试示例词表（当前词条覆盖不全，仅供方言演示与自定义扩充参考）：9 声 6 调，-p/-t/-k 阻塞尾仅闭塞不除阻 [◌̚]。",
    "closureNote": "粤语入声：结尾截面积归零并关闭除阻脉冲。",
    "pose": {
      "TCX": 0.35,
      "TCY": 0.15,
      "TTX": 4.1,
      "TTY": 1.55,
      "TBX": 2.6,
      "TBY": 0.8,
      "LD": 0.45,
      "LP": 0,
      "JA": -1.45,
      "VO": 0,
      "HX": 0.5,
      "HY": -4.5,
      "JX": -0.1,
      "VS": 0.1,
      "TS1": 0.4,
      "TS2": 0.45,
      "TS3": 0,
      "F0": 215,
      "PR": 480,
      "XB": -0.01,
      "XT": 0.01,
      "CA": -0.03,
      "LAG": 1,
      "RA": 0.2,
      "PS": 0,
      "FL": 10,
      "SHIM": 8
    },
    "tones": [
      {
        "name": "阴平",
        "chao": "55",
        "pts": [
          22,
          22,
          22
        ],
        "checked": false
      },
      {
        "name": "阴上",
        "chao": "35",
        "pts": [
          62,
          42,
          22
        ],
        "checked": false
      },
      {
        "name": "阴去",
        "chao": "33",
        "pts": [
          62,
          62,
          62
        ],
        "checked": false
      },
      {
        "name": "阳平",
        "chao": "21",
        "pts": [
          82,
          92,
          102
        ],
        "checked": false
      },
      {
        "name": "阳上",
        "chao": "13",
        "pts": [
          102,
          82,
          62
        ],
        "checked": false
      },
      {
        "name": "阳去",
        "chao": "22",
        "pts": [
          82,
          82,
          82
        ],
        "checked": false
      },
      {
        "name": "阴入",
        "chao": "5",
        "pts": [
          22,
          22,
          22
        ],
        "checked": true
      },
      {
        "name": "中入",
        "chao": "3",
        "pts": [
          62,
          62,
          62
        ],
        "checked": true
      },
      {
        "name": "阳入",
        "chao": "2",
        "pts": [
          82,
          82,
          82
        ],
        "checked": true
      }
    ],
    "sandhi": [
      {
        "en": true,
        "type": "pair",
        "trig": "53 + 55",
        "out": "55 + 55",
        "note": "高降并入高平连读"
      },
      {
        "en": true,
        "type": "lexical",
        "trig": "小称调",
        "out": "[35] 升调",
        "note": "口语名词小称变调"
      },
      {
        "en": true,
        "type": "word_pattern",
        "trig": "-p/-t/-k",
        "out": "[p̚/t̚/k̚]",
        "note": "仅闭塞不除阻 [◌̚]"
      }
    ],
    "phrases": {
      "一杯白水": [
        "[jɐt̚⁵ pui⁵⁵ paːk̚² sɵy³⁵]",
        "入声 5/2 不除阻"
      ],
      "粤语研究": [
        "[jyːt̚² jyː¹³ jiːn²¹ kɐu³³]",
        "阳入+阳上"
      ]
    }
  },
  "nan": {
    "name": "潮汕闽南 (nan-ST)",
    "summary": "8 调广泛前字连读变调 + 鼻化元音与三套塞尾。",
    "closureNote": "前字变调规则自动重写 qTA 目标靶点。",
    "pose": {
      "TCX": -0.3,
      "TCY": -0.6,
      "TTX": 3.1,
      "TTY": -0.85,
      "TBX": 1.8,
      "TBY": -0.25,
      "LD": 1.05,
      "LP": 0.05,
      "JA": -2.75,
      "VO": 0.78,
      "HX": 0.45,
      "HY": -4.6,
      "JX": -0.15,
      "VS": 0.65,
      "TS1": 0.35,
      "TS2": 0.4,
      "TS3": 0,
      "F0": 158,
      "PR": 720,
      "XB": 0.018,
      "XT": 0.025,
      "CA": 0.02,
      "LAG": 1.15,
      "RA": 0.45,
      "PS": 0.16,
      "FL": 18,
      "SHIM": 12
    },
    "tones": [
      {
        "name": "阴平",
        "chao": "33",
        "pts": [
          62,
          62,
          62
        ],
        "checked": false
      },
      {
        "name": "阴上",
        "chao": "53",
        "pts": [
          22,
          38,
          62
        ],
        "checked": false
      },
      {
        "name": "阴去",
        "chao": "213",
        "pts": [
          82,
          102,
          62
        ],
        "checked": false
      },
      {
        "name": "阳平",
        "chao": "55",
        "pts": [
          22,
          22,
          22
        ],
        "checked": false
      },
      {
        "name": "阴入",
        "chao": "2",
        "pts": [
          82,
          82,
          82
        ],
        "checked": true
      },
      {
        "name": "阳入",
        "chao": "5",
        "pts": [
          22,
          22,
          22
        ],
        "checked": true
      }
    ],
    "sandhi": [
      {
        "en": true,
        "type": "pair",
        "trig": "213 + X",
        "out": "53 + X",
        "note": "阴去前字转高降"
      },
      {
        "en": true,
        "type": "pair",
        "trig": "53 + X",
        "out": "35 + X",
        "note": "阴上前字转中升"
      }
    ],
    "phrases": {
      "食饱未": [
        "[tsiaʔ⁵⁻² pa⁵³ bue¹¹]",
        "前字阳入 5→2 连读"
      ],
      "潮汕话": [
        "[tio⁵⁵⁻¹¹ swã³³ ue¹¹]",
        "鼻化 VO=0.72"
      ]
    }
  },
  "wuu": {
    "name": "苏州吴语 (wuu-SZ)",
    "summary": "广用式连读变调（首字决定全词调型）与浊塞音声母。",
    "closureNote": "吴语多音节遵循 word_pattern 调型向后扩展。",
    "pose": {
      "TCX": 0.55,
      "TCY": 0.15,
      "TTX": 3.4,
      "TTY": -0.45,
      "TBX": 2.1,
      "TBY": 0.2,
      "LD": 0.62,
      "LP": 0.28,
      "JA": -2.1,
      "VO": 0,
      "HX": 0.45,
      "HY": -4.6,
      "JX": -0.15,
      "VS": 0.15,
      "TS1": 0.35,
      "TS2": 0.42,
      "TS3": 0,
      "F0": 168,
      "PR": 740,
      "XB": 0.015,
      "XT": 0.024,
      "CA": 0.012,
      "LAG": 1.18,
      "RA": 0.55,
      "PS": 0.15,
      "FL": 18,
      "SHIM": 12
    },
    "tones": [
      {
        "name": "阴平",
        "chao": "44",
        "pts": [
          42,
          42,
          42
        ],
        "checked": false
      },
      {
        "name": "阳平",
        "chao": "223",
        "pts": [
          82,
          82,
          62
        ],
        "checked": false
      },
      {
        "name": "阴入",
        "chao": "4",
        "pts": [
          42,
          42,
          42
        ],
        "checked": true
      }
    ],
    "sandhi": [
      {
        "en": true,
        "type": "word_pattern",
        "trig": "44 + X + Y",
        "out": "44 + 33 + 21",
        "note": "首字阴平展开整词调型"
      }
    ],
    "phrases": {
      "苏州话": [
        "[səu⁴⁴ tsøʏ³³ ɦo²¹]",
        "word_pattern 首字主导展开"
      ]
    }
  },
  "cmn": {
    "name": "普通话 (cmn-BJ)",
    "summary": "4 基本调 + 轻声/三声连读/一不变调规则。",
    "closureNote": "标准官话无入声不除阻尾。",
    "pose": {
      "TCX": 0.55,
      "TCY": 0.15,
      "TTX": 3.4,
      "TTY": -0.45,
      "TBX": 2.1,
      "TBY": 0.2,
      "LD": 0.62,
      "LP": 0.28,
      "JA": -2.1,
      "VO": 0,
      "HX": 0.45,
      "HY": -4.6,
      "JX": -0.15,
      "VS": 0.15,
      "TS1": 0.35,
      "TS2": 0.42,
      "TS3": 0,
      "F0": 168,
      "PR": 740,
      "XB": 0.015,
      "XT": 0.024,
      "CA": 0.012,
      "LAG": 1.18,
      "RA": 0.45,
      "PS": 0.15,
      "FL": 18,
      "SHIM": 12
    },
    "tones": [
      {
        "name": "阴平",
        "chao": "55",
        "pts": [
          22,
          22,
          22
        ],
        "checked": false
      },
      {
        "name": "阳平",
        "chao": "35",
        "pts": [
          62,
          42,
          22
        ],
        "checked": false
      },
      {
        "name": "上声",
        "chao": "214",
        "pts": [
          82,
          104,
          42
        ],
        "checked": false
      },
      {
        "name": "去声",
        "chao": "51",
        "pts": [
          22,
          62,
          102
        ],
        "checked": false
      }
    ],
    "sandhi": [
      {
        "en": true,
        "type": "pair",
        "trig": "214 + 214",
        "out": "35 + 214",
        "note": "三声连读转阳平"
      },
      {
        "en": true,
        "type": "lexical",
        "trig": "一/不 + 51",
        "out": "35 + 51",
        "note": "特定词去声前变阳平"
      }
    ],
    "phrases": {
      "你好": [
        "[ni²¹⁴⁻³⁵ xau²¹⁴]",
        "三声连读变调"
      ]
    }
  }
};
