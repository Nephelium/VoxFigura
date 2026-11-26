import { editionReferences } from '@vocalcut/edition';
import { additionalReferences } from './references-additional';

export interface MethodReference {
  id: string;
  title: string;
  modules: string[];
  importance?: number;
  acknowledgement_group: 'software' | 'academic' | string;
  authors: string;
  license: string;
  urls: Record<string, string>;
  citation: string;
  reference_note: string;
}

export const METHOD_REFERENCES: MethodReference[] = [
  {
    id: 'REF-DEFORMATION-TRANSFER',
    title: 'Deformation Transfer for Triangle Meshes',
    modules: ["声道动态重建"], importance: 83,
    acknowledgement_group: 'academic',
    authors: 'Robert W. Sumner、Jovan Popović',
    license: '',
    urls: {
      'DOI': 'https://doi.org/10.1145/1015706.1015736',
      '论文全文': 'https://homes.cs.washington.edu/~jovan/papers/sumner-2004-dtt.pdf',
    },
    citation: 'SUMNER R W, POPOVIĆ J. Deformation transfer for triangle meshes[J]. ACM Transactions on Graphics, 2004, 23(3): 399–405. DOI: 10.1145/1015706.1015736.',
    reference_note: '实时三维人头参考论文的局部三角形变换，把 MediaPipe 中性脸到表情帧的局部变形传到 JD2 头模，并以重心坐标绑定表面特征点。运行时采用局部加权迁移，VTL 唇颌保留独立的几何约束。',
  },
  {
    id: 'SRC-MEDIAPIPE-FACE-GEOMETRY',
    title: 'MediaPipe Face Geometry · Canonical Face Model',
    modules: ["声道动态重建"], importance: 84,
    acknowledgement_group: 'software',
    authors: 'Google MediaPipe 贡献者',
    license: 'Apache-2.0',
    urls: {
      '标准面部网格': 'https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/modules/face_geometry/data/canonical_face_model.obj',
      '许可': 'https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/LICENSE',
    },
    citation: 'GOOGLE MEDIAPIPE CONTRIBUTORS. Canonical Face Model: MediaPipe v0.10.14[DS/OL]. https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/modules/face_geometry/data/canonical_face_model.obj.',
    reference_note: '使用标准脸的 468 个表面点与三角拓扑建立实时三维人头的表面对应。',
  },
  {
    id: 'STK-WAVEGUIDES', title: 'The Synthesis ToolKit in C++ (STK)',
    modules: ["编曲"], importance: 85, acknowledgement_group: 'software', authors: 'Perry R. Cook、Gary P. Scavone',
    license: 'STK permissive license',
    urls: {
      '开源工程': 'https://github.com/thestk/stk/tree/6aacd357d76250bb7da2b1ddf675651828784bbc',
      '授权文本': 'https://github.com/thestk/stk/blob/6aacd357d76250bb7da2b1ddf675651828784bbc/LICENSE',
    },
    citation: 'COOK P R, SCAVONE G P. The Synthesis ToolKit in C++[CP/OL]. https://github.com/thestk/stk/tree/6aacd357d76250bb7da2b1ddf675651828784bbc.',
    reference_note: '启发管弦数字波导基础结构；本项目重构为三阶分数延迟线与精确闭环相位补偿，并独立实现竹笛非线性笛膜、洞箫气包音、Cremona 提琴模态、二胡蟒皮共振及古筝/琵琶/吉他交换双极化色散波导。',
  },
  {
    id: 'CHIMERA-SINGING-TIMING', title: 'CHIMERA vocal synthesizer',
    modules: ["编曲"], importance: 82, acknowledgement_group: 'software', authors: 'jamesondh 及贡献者',
    license: 'MIT',
    urls: { '歌唱调度': 'https://github.com/jamesondh/chimera-vocal-synth/blob/f795b84a6f451aae10c38882be1fbcbc93b3cdd8/crates/chimera/src/phonetics/sing.rs' },
    citation: 'JAMESONDH AND CONTRIBUTORS. CHIMERA vocal synthesizer: Singing syllables on notes[CP/OL]. https://github.com/jamesondh/chimera-vocal-synth/blob/f795b84a6f451aae10c38882be1fbcbc93b3cdd8/crates/chimera/src/phonetics/sing.rs.',
    reference_note: '参考其拍前安排字头、主元音踩拍的做法，在本项目调度器按辅音类别决定是否抢拍。',
  },
  {
    id: 'AUDIO-SALAMANDER-C5', title: 'Salamander Grand Piano v3',
    modules: ["编曲"], importance: 79, acknowledgement_group: 'software', authors: 'Alexander Holm',
    license: 'CC BY 3.0', urls: { '录音与采样工程':'https://github.com/sfzinstruments/SalamanderGrandPiano', '授权条款':'https://creativecommons.org/licenses/by/3.0/' },
    citation: 'HOLM A. Salamander Grand Piano v3[DS/OL]. https://github.com/sfzinstruments/SalamanderGrandPiano.',
    reference_note: '编曲试听采用 Yamaha C5 实录的两层力度和释键共鸣，随包样本经过 MP3 转码。',
  },
  {
    "id": "PROJ-PHONETICTOOLBOX-V3",
    "title": "PhoneticToolbox v3（语音学工具箱与国际音标 Plus 基础架构）",
    "modules": ["工作台与基础架构", "国际音标表 Plus", "发音字典管理"],
    "importance": 99,
    "acknowledgement_group": "software",
    "authors": "井韶子",
    "license": "GPL-3.0-or-later",
    "urls": {
      "phonetictoolbox.com": "https://www.phonetictoolbox.com/",
      "github": "https://github.com/Nephelium/PhoneticToolbox"
    },
    "citation": "井韶子. PhoneticToolbox v3 (3.1.3)[CP/OL]. https://www.phonetictoolbox.com/ (GitHub: https://github.com/Nephelium/PhoneticToolbox).",
    "reference_note": "同作者前序开源工程（GPL-3.0-or-later）。VoxFigura 复用了其中的国际音标表 Plus 体系、多语文字转 IPA 流程、2D/3D 声道可视化底座及文献致谢架构。"
  },
  {
    "id": "REF-YIN",
    "title": "YIN, a fundamental frequency estimator for speech and music",
    "modules": ["声道动态重建", "核心引擎与模型"],
    "importance": 16,
    "acknowledgement_group": "academic",
    "authors": "Alain de Cheveigné；Hideki Kawahara",
    "license": "",
    "urls": {
      "doi": "https://doi.org/10.1121/1.1458024"
    },
    "citation": "DE CHEVEIGNÉ A, KAWAHARA H. YIN, a fundamental frequency estimator for speech and music[J]. Journal of the Acoustical Society of America, 2002, 111(4): 1917–1930. DOI: 10.1121/1.1458024.",
    "reference_note": "基频估计的经典方法参考。当前本地引擎的声道重建和方言基频提取使用 SwiftF0；本次检索未找到当前路径对 YIN 的直接调用。"
  },
  {
    "id": "REF-FORNEY",
    "title": "The Viterbi algorithm",
    "modules": ["声道动态重建", "核心引擎与模型"],
    "importance": 73,
    "acknowledgement_group": "academic",
    "authors": "G. David Forney Jr.",
    "license": "",
    "urls": {
      "doi": "https://doi.org/10.1109/PROC.1973.9030"
    },
    "citation": "FORNEY G D Jr. The Viterbi algorithm[J]. Proceedings of the IEEE, 1973, 61(3): 268–278. DOI: 10.1109/PROC.1973.9030.",
    "reference_note": "动态规划路径搜索的方法背景；当前本地引擎的文本引导对齐代码使用 Viterbi 路径解码。"
  },
  {
    "id": "REF-XU-2021",
    "title": "Model-Based Exploration of Linking Between Vowel Articulatory Space and Acoustic Space",
    "modules": ["语音合成", "声道连续统"],
    "importance": 58,
    "acknowledgement_group": "academic",
    "authors": "Anqi Xu；Daniel van Niekerk；Branislav Gerazov；Paul Konstantin Krug；Santitham Prom-on；Peter Birkholz；Yi Xu",
    "license": "",
    "urls": {
      "doi": "https://doi.org/10.21437/Interspeech.2021-1422",
      "paper": "https://www.isca-archive.org/interspeech_2021/xu21j_interspeech.html"
    },
    "citation": "XU A, VAN NIEKERK D, GERAZOV B, et al. Model-Based Exploration of Linking Between Vowel Articulatory Space and Acoustic Space[C]//Interspeech 2021. 2021: 3191–3195. DOI: 10.21437/Interspeech.2021-1422.",
    "reference_note": "研究对照。作者用模拟退火拟合英语元音，每个元音迭代 1,000 次。工作台采用候选构形匹配。"
  },
  {
    "id": "REF-TENSORTRACT3",
    "title": "TensorTract3: Pushing the Limits of Articulatory Speech Synthesis",
    "modules": ["核心引擎与模型", "声道动态重建", "语音合成"],
    "importance": 95,
    "acknowledgement_group": "academic",
    "authors": "Paul Konstantin Krug；Christoph Wagner；Peter Birkholz；Timo Stich",
    "license": "",
    "urls": {
      "paper": "https://www.essv.de/pdf/2026_112_119.pdf",
      "demo": "https://tensortract3.github.io/",
      "demo_repository": "https://github.com/TensorTract3/TensorTract3.github.io"
    },
    "citation": "KRUG P K, WAGNER C, BIRKHOLZ P, et al. TensorTract3: Pushing the Limits of Articulatory Speech Synthesis[C]//ESSV 2026. 2026: 112–119.",
    "reference_note": "研究对照。作者训练编码器从录音预测构音轨迹。所链接仓库提供演示网页和音频，当前工作台未调用该编码器。"
  },
  {
    "id": "DATA-CMUDICT",
    "title": "The Carnegie Mellon University Pronouncing Dictionary (CMUdict)",
    "modules": ["发音字典管理", "语音合成", "编曲"],
    "importance": 76,
    "acknowledgement_group": "software",
    "authors": "Carnegie Mellon University Speech Group；CMUdict contributors",
    "license": "BSD-2-Clause (Carnegie Mellon University)",
    "urls": {
      "repository": "https://github.com/cmusphinx/cmudict",
      "license": "https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/LICENSE"
    },
    "citation": "CARNEGIE MELLON UNIVERSITY SPEECH GROUP AND CONTRIBUTORS. The Carnegie Mellon University Pronouncing Dictionary[DS/OL]. https://github.com/cmusphinx/cmudict.",
    "reference_note": "随包英语词典用于文字转 IPA；准确上游快照尚未由本地文件单独证明。"
  },
  {
    "id": "PTB-BROWSER-SCIENCE-RUNTIME",
    "title": "Browser scientific runtime: Pyodide, original Praat and pinned scientific dependencies",
    "modules": ["工作台与基础架构"],
    "importance": 15,
    "acknowledgement_group": "software",
    "authors": "Pyodide contributors；Python Software Foundation；NumPy/SciPy/Matplotlib/Pillow/Pydantic/OpenPyXL contributors；Paul Boersma and David Weenink；Yannick Jadoul",
    "license": "Mixed upstream licenses; GPL-3.0-or-later for Parselmouth/Praat binding; MPL-2.0 for Pyodide; PSF-2.0 for CPython; wheel license texts preserved",
    "urls": {
      "pyodide": "https://github.com/pyodide/pyodide/tree/0.29.3",
      "praat": "https://pypi.org/project/praat-parselmouth/0.4.7/",
      "noto": "https://github.com/notofonts/noto-cjk"
    },
    "citation": "PYODIDE CONTRIBUTORS. Pyodide 0.29.3[CP/OL]. https://github.com/pyodide/pyodide/tree/0.29.3.\nPYTHON SOFTWARE FOUNDATION. Python[CP/OL]. https://www.python.org/.",
    "reference_note": "继承自 PhoneticToolbox。VoxFigura 的适配器保留浏览器 Pyodide 后端探测接口；本仓库未发现对应运行资源，因此不能据此认定该后端已经随包可用。NumPy、SciPy 与 Pillow 的本地引擎用途另列。"
  },
  {
    "id": "SRC-PRAAT",
    "title": "Praat / Parselmouth",
    "modules": ["核心引擎与模型", "声道动态重建", "发声调音台", "声道连续统", "国际音标表 Plus"],
    "importance": 89,
    "acknowledgement_group": "software",
    "authors": "Paul Boersma、David Weenink（Praat）；Yannick Jadoul、Bill Thompson、Bart de Boer（Parselmouth）",
    "license": "Parselmouth 0.4.7：GPL-3.0-or-later；内嵌 Praat 6.1.38：GPL-2.0-or-later。按组合发行适用条款提供许可与对应源码；依赖另列。",
    "urls": {
      "homepage": "https://www.praat.org/",
      "documentation": "https://parselmouth.readthedocs.io/en/stable/",
      "paper": "https://doi.org/10.1016/j.wocn.2018.07.001",
      "pdf": "https://cris.vub.be/ws/files/38628284/jadoul_introducing_parselmouth_a_python_interface_to_praat.pdf",
      "spectrogram_analysis": "https://www.fon.hum.uva.nl/praat/manual/Sound__To_Spectrogram___.html",
      "spectrogram_display": "https://www.fon.hum.uva.nl/praat/manual/Spectrogram__Paint___.html",
      "spectrogram_faq": "https://www.fon.hum.uva.nl/praat/manual/FAQ__Spectrograms.html",
      "lpc_order": "https://www.fon.hum.uva.nl/praat/manual/Sound__To_LPC__covariance____.html",
      "pitch_method_choice": "https://www.fon.hum.uva.nl/praat/manual/how_to_choose_a_pitch_analysis_method.html",
      "overlap_add": "https://www.fon.hum.uva.nl/praat/manual/overlap-add.html",
      "manipulation_source": "https://github.com/YannickJadoul/Parselmouth/blob/v0.4.7/praat/fon/Manipulation.cpp"
    },
    "citation": "JADOUL Y, THOMPSON B, DE BOER B. Introducing Parselmouth: A Python interface to Praat[J]. Journal of Phonetics, 2018, 71: 1-15. DOI: 10.1016/j.wocn.2018.07.001.\nBOERSMA P, WEENINK D. Praat: doing phonetics by computer: Version 6.1.38[EB/OL]. (2021)[2026-10-11]. https://www.praat.org/.",
    "reference_note": "项目部分录音处理与分析脚本调用 Parselmouth；0.4.7 与内嵌 Praat 6.1.38 是所列上游版本，实际部署环境须另行确认。"
  },
  {
    "id": "SRC-REAPER",
    "title": "REAPER (Robust Epoch And Pitch EstimatoR)",
    "modules": ["工作台与基础架构", "声道动态重建"],
    "importance": 10,
    "acknowledgement_group": "software",
    "authors": "David Talkin and REAPER contributors",
    "license": "Apache-2.0",
    "urls": {
      "repository": "https://github.com/google/REAPER"
    },
    "citation": "TALKIN D AND CONTRIBUTORS. REAPER: Robust Epoch And Pitch EstimatoR[CP/OL]. https://github.com/google/REAPER.",
    "reference_note": "继承自 PhoneticToolbox；本次核查仅发现继承的界面语言字符串，未发现 VoxFigura 当前的 REAPER 可执行文件或实际调用路径。"
  },
  {
    "id": "SRC-ZAIWA",
    "title": "载瓦语 F0 与发声类型研究代码/数据",
    "modules": ["发声调音台", "工作台与基础架构"],
    "importance": 13,
    "acknowledgement_group": "software",
    "authors": "Yao Lu and Changwei Liang and Jiangping Kong",
    "license": "（2026-09-10）作者邮件许可，允许相关 MATLAB 代码改写为 Python，集成至 PhoneticToolbox v3 免费开源发布，并按约定引用、署名致谢和说明改写。",
    "urls": {
      "repository": "https://github.com/Luyao2025/Contribution-of-F0-and-phonation-to-tone-perception-in-the-Zaiwa-language"
    },
    "citation": "LU Y, LIANG C, KONG J. Contribution of F0 and phonation to tone perception in the Zaiwa language: Code and data[CP/OL]. https://github.com/Luyao2025/Contribution-of-F0-and-phonation-to-tone-perception-in-the-Zaiwa-language.",
    "reference_note": "该授权记录针对 PhoneticToolbox v3。VoxFigura 当前代码未找到相应研究实现或数据调用，本条保留作为来源历史，不推断授权自动覆盖其他用途。"
  },
  {
    "id": "REF-ZAIWA",
    "title": "Contribution of F0 and phonation to tone perception in the Zaiwa language",
    "modules": ["发声调音台", "工作台与基础架构"],
    "importance": 12,
    "acknowledgement_group": "academic",
    "authors": "Yao Lu；Changwei Liang；Jiangping Kong",
    "license": "article license is separate from code/data",
    "urls": {
      "paper": "https://www.sciencedirect.com/science/article/pii/S0095447025000245",
      "doi": "https://doi.org/10.1016/j.wocn.2025.101413"
    },
    "citation": "LU Y, LIANG C, KONG J. Contribution of F0 and phonation to tone perception in the Zaiwa language[J]. Journal of Phonetics, 2025, 110: 101413. DOI: 10.1016/j.wocn.2025.101413.",
    "reference_note": "继承自 PhoneticToolbox 的学术参考；本次未找到 VoxFigura 中相应研究代码或数据的实际调用。"
  },
  {
    "id": "SRC-VTL",
    "title": "VocalTractLab API 2.4",
    "modules": ["核心引擎与模型", "语音合成", "声道动态重建", "发声调音台", "声道连续统", "编曲"],
    "importance": 100,
    "acknowledgement_group": "software",
    "authors": "Peter Birkholz and VocalTractLab contributors",
    "license": "GPL-3.0-or-later",
    "urls": {
      "homepage": "https://www.vocaltractlab.de/",
      "download": "https://www.vocaltractlab.de/download-vocaltractlab/VTL2.4.zip",
      "backend_source": "https://github.com/TUD-STKS/VocalTractLabBackend-dev",
      "documentation": "https://www.vocaltractlab.de/index.php?page=vocaltractlab-download"
    },
    "citation": "BIRKHOLZ P AND VOCALTRACTLAB CONTRIBUTORS. VocalTractLab API 2.4[CP/OL]. https://www.vocaltractlab.de/index.php?page=vocaltractlab-download.",
    "reference_note": ""
  },
  {
    "id": "DOC-VTL24",
    "title": "VocalTractLab 2.4 User Manual",
    "modules": ["核心引擎与模型", "语音合成"],
    "importance": 96,
    "acknowledgement_group": "academic",
    "authors": "Peter Birkholz",
    "license": "",
    "urls": {
      "pdf": "https://vocaltractlab.de/download-vocaltractlab/VTL2.4-manual.pdf",
      "official_download": "https://www.vocaltractlab.de/index.php?page=vocaltractlab-download"
    },
    "citation": "BIRKHOLZ P. VocalTractLab 2.4 User Manual[Z/OL]. (2025-12-05)[2026-10-11]. https://vocaltractlab.de/download-vocaltractlab/VTL2.4-manual.pdf.",
    "reference_note": ""
  },
  {
    "id": "DOC-VTL23",
    "title": "VocalTractLab 2.3 User Manual",
    "modules": ["核心引擎与模型", "语音合成"],
    "importance": 57,
    "acknowledgement_group": "academic",
    "authors": "Peter Birkholz",
    "license": "",
    "urls": {
      "pdf": "https://www.vocaltractlab.de/download-vocaltractlab/VTL2.3-manual.pdf",
      "official_download": "https://www.vocaltractlab.de/index.php?page=vocaltractlab-download"
    },
    "citation": "BIRKHOLZ P. VocalTractLab 2.3 User Manual[Z/OL]. (2020-08-09)[2026-10-11]. https://www.vocaltractlab.de/download-vocaltractlab/VTL2.3-manual.pdf.",
    "reference_note": ""
  },
  {
    "id": "REF-VTL2006",
    "title": "Construction and Control of a Three-Dimensional Vocal Tract Model",
    "modules": ["核心引擎与模型", "语音合成"],
    "importance": 97,
    "acknowledgement_group": "academic",
    "authors": "Peter Birkholz；Dietmar Jackèl；Bernd J. Kröger",
    "license": "",
    "urls": {
      "pdf": "https://www.vocaltractlab.de/publications/birkholz-2006-icassp.pdf",
      "publications": "https://www.vocaltractlab.de/index.php?page=birkholz-publications",
      "doi": "https://doi.org/10.1109/ICASSP.2006.1660160"
    },
    "citation": "BIRKHOLZ P, JACKÈL D, KRÖGER B J. Construction and Control of a Three-Dimensional Vocal Tract Model[C]//2006 IEEE International Conference on Acoustics, Speech and Signal Processing. [S.l.]: IEEE, 2006: I-873-I-876. DOI: 10.1109/ICASSP.2006.1660160.",
    "reference_note": ""
  },
  {
    "id": "SRC-THREE",
    "title": "Three.js / OrbitControls",
    "modules": ["语音合成", "声道动态重建"],
    "importance": 88,
    "acknowledgement_group": "software",
    "authors": "three.js authors",
    "license": "MIT",
    "urls": {
      "vendored_r180": "https://github.com/mrdoob/three.js/tree/r180",
      "npm_r172": "https://github.com/mrdoob/three.js/tree/r172"
    },
    "citation": "THREE.JS AUTHORS. Three.js: r180 and r172[CP/OL]. https://github.com/mrdoob/three.js.",
    "reference_note": "声道视图随包使用 r180；实时三维人头从 npm 导入 r172。两者分别使用对应版本的 OrbitControls。"
  },
  {
    "id": "ASSET-HEAD",
    "title": "3D human parts pack / FACE2",
    "modules": ["语音合成"],
    "importance": 60,
    "acknowledgement_group": "software",
    "authors": "byzmod3d",
    "license": "CC0-1.0",
    "urls": {
      "homepage": "https://opengameart.org/content/3d-human-parts-pack"
    },
    "citation": "BYZMOD3D. 3D human parts pack: FACE2[DS/OL]. https://opengameart.org/content/3d-human-parts-pack.",
    "reference_note": ""
  },
  {
    "id": "ASSET-NASAL",
    "title": "Data for \"Characterization of the Airflow within an Average Geometry of the Healthy Human Nasal Cavity\"",
    "modules": ["语音合成"],
    "importance": 59,
    "acknowledgement_group": "academic",
    "authors": "Jan Brüning；Thomas Hildebrandt；Werner Heppt；Hans Lamecker；Nora Schmidt；Angelika Szengel；Natalja Amiridze；Heiko Ramm；Matthias Bindernagel；Stefan Zachow；Leonid Goubergrits",
    "license": "CC BY 4.0（官方 v4 元数据与原始网格摘要已核对）。保留作者、来源、许可链接和修改说明。",
    "urls": {
      "doi": "https://doi.org/10.6084/m9.figshare.9585410.v4",
      "dataset": "https://figshare.com/articles/dataset/Data_for_Characterization_of_the_Airflow_within_an_Average_Geometry_of_the_Healthy_Human_Nasal_Cavity_/9585410/4",
      "metadata": "https://api.figshare.com/v2/articles/9585410/versions/4",
      "related_paper": "https://pmc.ncbi.nlm.nih.gov/articles/PMC7048824/"
    },
    "citation": "BRÜNING J, HILDEBRANDT T, HEPPT W, et al. Data for \"Characterization of the Airflow within an Average Geometry of the Healthy Human Nasal Cavity\": version 4[DS/OL]. figshare, 2020-02-25[2026-10-11]. https://doi.org/10.6084/m9.figshare.9585410.v4.",
    "reference_note": ""
  },
  {
    "id": "SRC-VTLWRAPPER",
    "title": "VocalTractLab-Python",
    "modules": ["核心引擎与模型", "语音合成"],
    "importance": 18,
    "acknowledgement_group": "software",
    "authors": "Paul Krug",
    "license": "",
    "urls": {
      "repository": "https://github.com/paul-krug/VocalTractLab-Python"
    },
    "citation": "KRUG P. VocalTractLab-Python[CP/OL]. https://github.com/paul-krug/VocalTractLab-Python.",
    "reference_note": "上游接口参考；当前引擎通过项目内的原生 VTL 适配代码调用，尚不能仅凭清单认定直接使用此 Python 软件包。"
  },
  {
    "id": "SRC-FFMPEG",
    "title": "FFmpeg",
    "modules": ["剪辑", "发音卡工坊"],
    "importance": 86,
    "acknowledgement_group": "software",
    "authors": "FFmpeg contributors",
    "license": "",
    "urls": {
      "homepage": "https://ffmpeg.org/",
      "license": "https://ffmpeg.org/legal.html"
    },
    "citation": "FFMPEG CONTRIBUTORS. FFmpeg[CP/OL]. https://ffmpeg.org/.",
    "reference_note": ""
  },
  {
    "id": "ASSET-DOULOS",
    "title": "Doulos SIL 字体",
    "modules": ["国际音标表 Plus", "发音卡工坊", "工作台与基础架构"],
    "importance": 77,
    "acknowledgement_group": "software",
    "authors": "SIL International",
    "license": "SIL Open Font License 1.1; embedded license extracted without modification",
    "urls": {
      "homepage": "https://software.sil.org/doulos/",
      "download": "https://software.sil.org/doulos/download/"
    },
    "citation": "SIL INTERNATIONAL. Doulos SIL[CP/OL]. https://software.sil.org/doulos/.",
    "reference_note": ""
  },
  {
    "id": "SRC-SHEETJS",
    "title": "SheetJS",
    "modules": ["工作台与基础架构"],
    "importance": 5,
    "acknowledgement_group": "software",
    "authors": "SheetJS LLC",
    "license": "Apache-2.0",
    "urls": {
      "repository": "https://git.sheetjs.com/sheetjs/sheetjs",
      "distribution": "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs",
      "license": "https://docs.sheetjs.com/docs/miscellany/license/"
    },
    "citation": "SHEETJS LLC. SheetJS[CP/OL]. https://git.sheetjs.com/sheetjs/sheetjs.",
    "reference_note": "继承自 PhoneticToolbox；本次未在 VoxFigura 的依赖清单或运行代码中找到 SheetJS 调用。"
  },
  {
    "id": "PKG-PRAAT-PARSELMOUTH",
    "title": "praat-parselmouth",
    "modules": ["核心引擎与模型", "工作台与基础架构"],
    "importance": 20,
    "acknowledgement_group": "software",
    "authors": "Yannick Jadoul",
    "license": "GPL-3.0-or-later；Praat 及其依赖另列",
    "urls": {
      "release_metadata": "https://pypi.org/pypi/praat-parselmouth/0.4.7/json",
      "Bug Tracker": "https://github.com/YannickJadoul/Parselmouth/issues",
      "Documentation": "https://parselmouth.readthedocs.io/",
      "Homepage": "https://github.com/YannickJadoul/Parselmouth",
      "Source Code": "https://github.com/YannickJadoul/Parselmouth"
    },
    "citation": "JADOUL Y AND CONTRIBUTORS. praat-parselmouth 0.4.7[CP/OL]. https://pypi.org/project/praat-parselmouth/0.4.7/.",
    "reference_note": "Praat / Parselmouth 本地用途另见 SRC-PRAAT；0.4.7 是上游参考版本，不能据此保证所有部署环境使用该版本。"
  },
  {
    "id": "PKG-SOUNDFILE",
    "title": "soundfile",
    "modules": ["核心引擎与模型", "剪辑"],
    "importance": 78.5,
    "acknowledgement_group": "software",
    "authors": "Bastian Bechtold",
    "license": "BSD-3-Clause；libsndfile 等原生组件许可另列",
    "urls": {
      "release_metadata": "https://pypi.org/pypi/soundfile/0.13.1/json",
      "Homepage": "https://github.com/bastibe/python-soundfile"
    },
    "citation": "BECHTOLD B AND CONTRIBUTORS. python-soundfile 0.13.1[CP/OL]. https://pypi.org/project/soundfile/0.13.1/.",
    "reference_note": "本地引擎使用 soundfile 进行音频读写；上游 0.13.1 是参考版本，实际版本由 Python 环境决定。"
  },
  {
    "id": "PTB-PY-PRAAT-PARSELMOUTH",
    "title": "praat-parselmouth",
    "modules": ["工作台与基础架构", "核心引擎与模型"],
    "importance": 19,
    "acknowledgement_group": "software",
    "authors": "Yannick Jadoul",
    "license": "GPL-3.0-or-later（Parselmouth 0.4.7）；内嵌 Praat 与依赖许可另列。",
    "urls": {
      "release": "https://pypi.org/project/praat-parselmouth/0.4.7/"
    },
    "citation": "JADOUL Y AND CONTRIBUTORS. praat-parselmouth 0.4.7[CP/OL]. https://pypi.org/project/praat-parselmouth/0.4.7/.",
    "reference_note": "继承自 PhoneticToolbox 的历史条目；当前项目的 Praat / Parselmouth 本地用途另见 SRC-PRAAT。具体运行版本以实际 Python 环境为准。"
  },
  {
    "id": "PTB-PY-SCIPY",
    "title": "scipy",
    "modules": ["工作台与基础架构", "核心引擎与模型"],
    "importance": 17,
    "acknowledgement_group": "software",
    "authors": "SciPy Developers",
    "license": "BSD-3-Clause；wheel 内原生组件、运行库许可与例外须一并保留。",
    "urls": {
      "release": "https://pypi.org/project/scipy/1.16.3/",
      "m09_inverse_stft": "https://docs.scipy.org/doc/scipy-1.16.2/reference/generated/scipy.signal.istft.html"
    },
    "citation": "SCIPY DEVELOPERS. SciPy 1.16.3[CP/OL]. https://pypi.org/project/scipy/1.16.3/.",
    "reference_note": "SciPy 确用于本地引擎；该条保留 PhoneticToolbox 历史依赖来源，运行环境具体版本可能不同。"
  },
  {
    "id": "REF-WEBCODECS",
    "title": "WebCodecs specification",
    "modules": ["剪辑"],
    "importance": 42,
    "acknowledgement_group": "software",
    "authors": "W3C Web Media Working Group",
    "license": "",
    "urls": {
      "specification": "https://www.w3.org/TR/webcodecs/"
    },
    "citation": "W3C WEB MEDIA WORKING GROUP. WebCodecs[S/OL]. https://www.w3.org/TR/webcodecs/.",
    "reference_note": "WebCodecs 是浏览器接口规范；在此列作技术标准参考，不代表浏览器组件随项目发行。"
  },
  {
    "id": "REF-WEBM",
    "title": "WebM Container Guidelines",
    "modules": ["剪辑"],
    "importance": 40,
    "acknowledgement_group": "software",
    "authors": "The WebM Project",
    "license": "",
    "urls": {
      "specification": "https://www.webmproject.org/docs/container/"
    },
    "citation": "THE WEBM PROJECT. WebM Container Guidelines[EB/OL]. https://www.webmproject.org/docs/container/.",
    "reference_note": "保留作为 WebM 容器格式背景；不能仅凭参考条目认定引用了 WebM 项目代码。"
  },
  {
    "id": "REF-FONT-RENDERING",
    "title": "CSS font loading, Qt font catalogue and Matplotlib font resolution",
    "modules": ["工作台与基础架构"],
    "importance": 14,
    "acknowledgement_group": "software",
    "authors": "W3C CSS Working Group；The Qt Company；Matplotlib developers",
    "license": "",
    "urls": {
      "font_loading": "https://www.w3.org/TR/2023/WD-css-font-loading-3-20230406/",
      "qt_fonts": "https://doc.qt.io/qt-6/qfontdatabase.html",
      "matplotlib_fonts": "https://matplotlib.org/stable/api/font_manager_api.html",
      "local_fonts": "https://wicg.github.io/local-font-access/"
    },
    "citation": "W3C CSS WORKING GROUP. CSS Font Loading Module Level 3[S/OL]. (2023-04-06). https://www.w3.org/TR/2023/WD-css-font-loading-3-20230406/.\nTHE QT COMPANY. QFontDatabase Class[EB/OL]. https://doc.qt.io/qt-6/qfontdatabase.html.\nMATPLOTLIB DEVELOPERS. matplotlib.font_manager[EB/OL]. https://matplotlib.org/stable/api/font_manager_api.html.\nWICG. Local Font Access API[S/OL]. https://wicg.github.io/local-font-access/.",
    "reference_note": "继承自 PhoneticToolbox 的字体实现参考；未证实本项目运行时使用 Qt 字体目录或 Matplotlib 字体解析。"
  },
  {
    "id": "REF-IPA-CHART",
    "title": "The International Phonetic Alphabet",
    "modules": ["国际音标表 Plus", "语音合成", "声道连续统"],
    "importance": 92,
    "acknowledgement_group": "academic",
    "authors": "International Phonetic Association",
    "license": "CC BY-SA 4.0",
    "urls": {
      "homepage": "https://www.internationalphoneticassociation.org/content/ipa-chart",
      "pdf": "https://www.internationalphoneticassociation.org/IPAcharts/common_files/pdfs/pdfs_IPA_charts_E/IPA_Kiel.pdf"
    },
    "citation": "INTERNATIONAL PHONETIC ASSOCIATION. The International Phonetic Alphabet[EB/OL]. (2026)[2026-10-11]. https://www.internationalphoneticassociation.org/IPAcharts/common_files/pdfs/pdfs_IPA_charts_E/IPA_Kiel.pdf.",
    "reference_note": ""
  },
  {
    "id": "REF-EXTIPA-2025",
    "title": "ExtIPA symbols for disordered speech",
    "modules": ["国际音标表 Plus", "声道连续统"],
    "importance": 90,
    "acknowledgement_group": "academic",
    "authors": "International Clinical Phonetics；Linguistics Association",
    "license": "CC BY-SA 3.0 as identified on ICPLA resources; original chart reproduction wording also recorded",
    "urls": {
      "homepage": "https://www.icpla.org.uk/resources",
      "pdf": "https://drive.google.com/file/d/1innt3AxeLuAj0p8_7_PpHV8aOY8LbpK3/view"
    },
    "citation": "INTERNATIONAL CLINICAL PHONETICS AND LINGUISTICS ASSOCIATION. ExtIPA symbols for disordered speech[EB/OL]. (2025)[2026-10-11]. https://www.icpla.org.uk/resources.",
    "reference_note": ""
  },
  {
    "id": "REF-VOQS-BALL-2018",
    "title": "Revisions to the VoQS system for the transcription of voice quality",
    "modules": ["发声调音台", "国际音标表 Plus", "语音合成", "声道连续统"],
    "importance": 91,
    "acknowledgement_group": "academic",
    "authors": "Martin J. Ball；John H. Esling；B. Craig Dickson",
    "license": "",
    "urls": {
      "paper": "https://doi.org/10.1017/S0025100317000159",
      "publisher": "https://www.cambridge.org/core/journals/journal-of-the-international-phonetic-association/article/abs/revisions-to-the-voqs-system-for-the-transcription-of-voice-quality/67662EA00A0B1D77136AF8514B6F230B",
      "chart": "https://www.icpla.org.uk/resources"
    },
    "citation": "BALL M J, ESLING J H, DICKSON B C. Revisions to the VoQS system for the transcription of voice quality[J]. Journal of the International Phonetic Association, 2018, 48(2): 165-171. https://doi.org/10.1017/S0025100317000159.",
    "reference_note": ""
  },
  {
    "id": "REF-VOQS-ZH-UNTPHESOCA",
    "title": "VoQS: 音质符号 (2016中英双语版)",
    "modules": ["国际音标表 Plus", "发声调音台"],
    "importance": 61,
    "acknowledgement_group": "academic",
    "authors": "王天恒（Wang, Tianheng），译",
    "license": "CC BY 4.0（Zenodo 对应中文译表记录）；保留作者、来源、许可链接及交互改写说明，原表作者另列，原 PDF 不随包。",
    "urls": {
      "doi": "https://doi.org/10.5281/zenodo.10206204",
      "record": "https://zenodo.org/records/10206204",
      "author": "https://phesoca.com/wang/",
      "license": "https://creativecommons.org/licenses/by/4.0/"
    },
    "citation": "王天恒, 译. VoQS: 音质符号 (2016中英双语版)[EB/OL]. (2020-08-30)[2026-10-11]. https://doi.org/10.5281/zenodo.10206204.",
    "reference_note": ""
  },
  {
    "id": "ASSET-PTB-IPA-PLUS-FONT",
    "title": "PTB IPA Plus 1.000 — module font derived from Doulos SIL 7.000",
    "modules": ["国际音标表 Plus", "发音卡工坊", "工作台与基础架构"],
    "importance": 78,
    "acknowledgement_group": "software",
    "authors": "井韶子；SIL Global；Noto authors",
    "license": "SIL Open Font License 1.1",
    "urls": {
      "upstream": "https://software.sil.org/doulos/",
      "history": "https://software.sil.org/doulos/history/",
      "noto_delimiters": "https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansMath/NotoSansMath-Regular.ttf",
      "noto_license": "https://raw.githubusercontent.com/notofonts/noto-fonts/main/LICENSE"
    },
    "citation": "井韶子. PTB IPA Plus 1.000[CP/OL]. https://github.com/Nephelium/PhoneticToolbox.\nSIL INTERNATIONAL. Doulos SIL 7.000[CP/OL]. https://software.sil.org/doulos/.\nNOTO AUTHORS. Noto Sans Math[CP/OL]. https://github.com/notofonts/noto-fonts.",
    "reference_note": ""
  },
  {
    "id": "REF-UNICODE-PHONETIC-ENCODING",
    "title": "Unicode 音标与附加符号编码资料",
    "modules": ["国际音标表 Plus"],
    "importance": 60.5,
    "acknowledgement_group": "academic",
    "authors": "The Unicode Consortium（Unicode标准）；Kirk Miller、Martin Ball（两份提案）；SIL Global（字体资料）",
    "license": "",
    "urls": {
      "chapter7": "https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-7/",
      "voqs_correction": "https://www.unicode.org/L2/L2020/20113-voqs-correction.pdf",
      "cartouche": "https://www.unicode.org/L2/L2024/24182r-cartouche.pdf",
      "bridges": "https://software.sil.org/fonts/bridging-diacritics/"
    },
    "citation": "THE UNICODE CONSORTIUM. The Unicode Standard, Version 16.0.0: Chapter 7, Europe-I[S/OL]. (2024-09-10)[2026-10-11]. https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-7/.\nMILLER K, BALL M. Unicode request for modification of VoQS character: L2/20-113[R/OL]. (2020-01-19)[2026-10-11]. https://www.unicode.org/L2/L2020/20113-voqs-correction.pdf.\nMILLER K, BALL M. Unicode request for ExtIPA cartouche: L2/24-182R[R/OL]. (2024-09-04)[2026-10-11]. https://www.unicode.org/L2/L2024/24182r-cartouche.pdf.\nSIL GLOBAL. Using bridging diacritics[EB/OL]. (2025-06-02)[2026-10-11]. https://software.sil.org/fonts/bridging-diacritics/.",
    "reference_note": ""
  },
  {
    "id": "SRC-IPA-INTERACTIVE-LAYOUT",
    "title": "Interactive IPA Chart 与 IPA Unicode Keyboard",
    "modules": ["国际音标表 Plus"],
    "importance": 45,
    "acknowledgement_group": "software",
    "authors": "IPAChart.com；Weston Ruter（IPA Unicode Keyboard）",
    "license": "",
    "urls": {
      "Interactive IPA Chart": "https://www.ipachart.com/",
      "IPA Unicode Keyboard": "https://westonruter.github.io/ipa-chart/keyboard/",
      "Keyboard源码": "https://github.com/westonruter/ipa-chart"
    },
    "citation": "IPAChart.com. Interactive IPA Chart[EB/OL]. [2026-10-11]. https://www.ipachart.com/.\nRUTER W. International Phonetic Alphabet (IPA) Unicode Chart and Character Picker[EB/OL]. [2026-10-11]. https://github.com/westonruter/ipa-chart.",
    "reference_note": "参考音标表的交互与分区方式。"
  },
  {
    "id": "REF-EXTIPA-LV-JIANG-2013",
    "title": "国际音标扩展表的分类、命名与功能",
    "modules": ["国际音标表 Plus"],
    "importance": 48,
    "acknowledgement_group": "academic",
    "authors": "吕佳；江荻",
    "license": "",
    "urls": {
      "paper": "https://jasptl.haoyicn.cn/summary/19224?eng=0&type=history",
      "funding_record": "https://www.nopss.gov.cn/n/2015/0721/c358205-27339164.html"
    },
    "citation": "吕佳, 江荻. 国际音标扩展表的分类、命名与功能[J]. 听力学及言语疾病杂志, 2013, 21(6): 665-668.",
    "reference_note": "原登记 DOI 尚未核实，暂不列入引文；作者、卷期与页码可由项目成果登记核对。"
  },
  {
    "id": "SRC-IOS-IPA-PHONETICS",
    "title": "iPA Phonetics（iPA Phonetics Pro）",
    "modules": ["国际音标表 Plus"],
    "importance": 44,
    "acknowledgement_group": "software",
    "authors": "John Esling、Christopher Coey",
    "license": "",
    "urls": {
      "App Store": "https://apps.apple.com/us/app/ipa-phonetics/id869642260"
    },
    "citation": "ESLING J, COEY C. iPA Phonetics: Version 3.0[EB/OL]. App Store, (2025-02-15)[2026-10-11]. https://apps.apple.com/us/app/ipa-phonetics/id869642260.",
    "reference_note": "参考应用的符号展示与组合输入方式。"
  },
  {
    "id": "REF-IPA-CHART-ZH-2007",
    "title": "The chart of the International Phonetic Alphabet in Chinese (2007)",
    "modules": ["国际音标表 Plus", "语音合成"],
    "importance": 63,
    "acknowledgement_group": "academic",
    "authors": "Phonetic Association of China（中国语言学会语音学分会）",
    "license": "",
    "urls": {
      "paper": "https://doi.org/10.1017/S0025100311000156",
      "publisher": "https://www.cambridge.org/core/journals/journal-of-the-international-phonetic-association/article/abs/chart-of-the-international-phonetic-alphabet-in-chinese-2007/372C851EDD231F03709B56339F4DB400",
      "association": "https://www.internationalphoneticassociation.org/IPAcharts/IPA_charts_T/IPA_charts_T.html"
    },
    "citation": "PHONETIC ASSOCIATION OF CHINA. The chart of the International Phonetic Alphabet in Chinese (2007)[J]. Journal of the International Phonetic Association, 2011, 41(2): 245. https://doi.org/10.1017/S0025100311000156.",
    "reference_note": ""
  },
  {
    "id": "REF-IPA-HANDBOOK-JIANG-2008",
    "title": "国际语音学会手册：国际音标使用指南",
    "modules": ["国际音标表 Plus", "语音合成"],
    "importance": 62,
    "acknowledgement_group": "academic",
    "authors": "国际语音学会，编著；江荻，译",
    "license": "",
    "urls": {
      "catalogue": "https://ci.nii.ac.jp/ncid/BB01991047",
      "original": "https://www.internationalphoneticassociation.org/content/handbook-ipa"
    },
    "citation": "国际语音学会. 国际语音学会手册：国际音标使用指南[M]. 江荻, 译. 上海: 上海教育出版社, 2008.",
    "reference_note": ""
  },
  {
    "id": "REF-VOICE-QUALITY-ESLING-2019",
    "title": "Voice quality: The laryngeal articulator model",
    "modules": ["发声调音台", "国际音标表 Plus"],
    "importance": 66,
    "acknowledgement_group": "academic",
    "authors": "John H. Esling；Scott R. Moisik；Allison Benner；Lise Crevier-Buchman",
    "license": "",
    "urls": {
      "paper": "https://doi.org/10.1017/9781108696555",
      "publisher": "https://www.cambridge.org/core/books/voice-quality/62327F676CC6B8823389A76449731F85",
      "catalogue": "https://ci.nii.ac.jp/ncid/BB28502458"
    },
    "citation": "ESLING J H, MOISIK S R, BENNER A, et al. Voice quality: The laryngeal articulator model[M]. Cambridge: Cambridge University Press, 2019. https://doi.org/10.1017/9781108696555.",
    "reference_note": ""
  },
  {
    "id": "REF-EXTIPA-BALL-2018",
    "title": "Revisions to the extIPA chart",
    "modules": ["国际音标表 Plus"],
    "importance": 49,
    "acknowledgement_group": "academic",
    "authors": "Martin J. Ball；Sara J. Howard；Kirk Miller",
    "license": "",
    "urls": {
      "paper": "https://doi.org/10.1017/S0025100317000147",
      "publisher": "https://www.cambridge.org/core/journals/journal-of-the-international-phonetic-association/article/abs/revisions-to-the-extipa-chart/06C01EA81DA2AECA2AC52AAF21556B33",
      "chart": "https://www.internationalphoneticassociation.org/sites/default/files/extIPA_2016.pdf"
    },
    "citation": "BALL M J, HOWARD S J, MILLER K. Revisions to the extIPA chart[J]. Journal of the International Phonetic Association, 2018, 48(2): 155-164. https://doi.org/10.1017/S0025100317000147.",
    "reference_note": ""
  },
  {
    "id": "REF-EXTIPA-BALL-2024",
    "title": "Changes to certain extIPA diacritics",
    "modules": ["国际音标表 Plus"],
    "importance": 47,
    "acknowledgement_group": "academic",
    "authors": "Martin J. Ball",
    "license": "",
    "urls": {
      "paper": "https://doi.org/10.1080/02699206.2024.2365205",
      "publisher": "https://www.tandfonline.com/doi/full/10.1080/02699206.2024.2365205"
    },
    "citation": "BALL M J. Changes to certain extIPA diacritics[J]. Clinical Linguistics & Phonetics, 2024, 38(7): 692-695. https://doi.org/10.1080/02699206.2024.2365205.",
    "reference_note": ""
  },
  {
    "id": "REF-EXTIPA-BALL-2025-REPLY",
    "title": "Reply to letter concerning the revisions to some diacritics of the extensions to the IPA (extIPA), Ball (2024)",
    "modules": ["国际音标表 Plus"],
    "importance": 46,
    "acknowledgement_group": "academic",
    "authors": "Martin J. Ball",
    "license": "",
    "urls": {
      "paper": "https://doi.org/10.1080/02699206.2025.2489577",
      "publisher": "https://www.tandfonline.com/doi/full/10.1080/02699206.2025.2489577",
      "pdf": "https://www.tandfonline.com/doi/pdf/10.1080/02699206.2025.2489577"
    },
    "citation": "BALL M J. Reply to letter concerning the revisions to some diacritics of the extensions to the IPA (extIPA), Ball (2024)[J]. Clinical Linguistics & Phonetics, 2025, 39(9): 911-912. https://doi.org/10.1080/02699206.2025.2489577.",
    "reference_note": ""
  },
  {
    "id": "SRC-JETBRAINS-MONO",
    "title": "JetBrains Mono",
    "modules": ["工作台与基础架构", "发音卡工坊"],
    "importance": 73.5,
    "acknowledgement_group": "software",
    "authors": "The JetBrains Mono Project Authors",
    "license": "SIL Open Font License 1.1",
    "urls": {
      "homepage": "https://www.jetbrains.com/lp/mono/",
      "source": "https://github.com/JetBrains/JetBrainsMono/tree/v2.304",
      "license": "https://github.com/JetBrains/JetBrainsMono/blob/v2.304/OFL.txt"
    },
    "citation": "JETBRAINS MONO PROJECT AUTHORS. JetBrains Mono v2.304[CP/OL]. https://github.com/JetBrains/JetBrainsMono/tree/v2.304.",
    "reference_note": ""
  },
  {
    "id": "REF-JORDAN-2017-MRI",
    "title": "Examining Velopharyngeal Closure Patterns Based on Anatomic Variables",
    "modules": ["语音合成"],
    "importance": 43,
    "acknowledgement_group": "academic",
    "authors": "Holly Nelson Jordan；Graham C. Schenck；Charles Ellis；Balaji Rangarathnam；Xiangming Fang；Jamie L. Perry",
    "license": "",
    "urls": {
      "doi": "https://doi.org/10.1097/SCS.0000000000003284",
      "paper": "https://pmc.ncbi.nlm.nih.gov/articles/PMC5218844/",
      "figure": "https://cdn.ncbi.nlm.nih.gov/pmc/blobs/6e4d/5218844/263855b1205b/nihms818229f1.jpg"
    },
    "citation": "JORDAN H N, SCHENCK G C, ELLIS C, et al. Examining Velopharyngeal Closure Patterns Based on Anatomic Variables[J]. Journal of Craniofacial Surgery, 2017, 28(1): 270-274. DOI: 10.1097/SCS.0000000000003284.",
    "reference_note": ""
  },
  {
    "id": "REF-OLIVEIRA-2012-MRI",
    "title": "An MRI study of the oral articulation of European Portuguese nasal vowels",
    "modules": ["语音合成"],
    "importance": 42.5,
    "acknowledgement_group": "academic",
    "authors": "Catarina Oliveira；Paula Martins；Samuel Silva；António Teixeira",
    "license": "",
    "urls": {
      "doi": "https://doi.org/10.21437/Interspeech.2012-668",
      "paper": "https://www.isca-archive.org/interspeech_2012/oliveira12b_interspeech.html",
      "pdf": "https://www.isca-archive.org/interspeech_2012/oliveira12b_interspeech.pdf"
    },
    "citation": "OLIVEIRA C, MARTINS P, SILVA S, et al. An MRI study of the oral articulation of European Portuguese nasal vowels[C]//Interspeech 2012. ISCA, 2012: 2690-2693. DOI: 10.21437/Interspeech.2012-668.",
    "reference_note": ""
  },
  {
    "id": "PKG-PYAV",
    "title": "PyAV",
    "modules": ["剪辑", "核心引擎与模型"],
    "importance": 61.5,
    "acknowledgement_group": "software",
    "authors": "PyAV contributors",
    "license": "BSD-3-Clause (binding); bundled FFmpeg codecs have separate build-dependent terms",
    "urls": {
      "homepage": "https://pyav.basswood-io.com",
      "source": "https://github.com/PyAV-Org/PyAV"
    },
    "citation": "PYAV CONTRIBUTORS. PyAV[CP/OL]. https://github.com/PyAV-Org/PyAV.",
    "reference_note": ""
  },
  {
    "id": "REF-LEE-ZEE-2003",
    "title": "Standard Chinese (Beijing)",
    "modules": ["发音字典管理"],
    "importance": 68,
    "acknowledgement_group": "academic",
    "authors": "Wai-Sum Lee；Eric Zee",
    "license": "",
    "urls": {
      "论文 DOI": "https://doi.org/10.1017/S0025100303001208"
    },
    "citation": "LEE W S, ZEE E. Standard Chinese (Beijing)[J]. Journal of the International Phonetic Association, 2003, 33(1): 109-112. DOI: 10.1017/S0025100303001208.",
    "reference_note": "对应 Standard Chinese (Beijing) 及其严式选项。论文书目已核实，宽严两列与论文的逐字对应尚待核对。"
  },
  {
    "id": "REF-HU-1995",
    "title": "现代汉语: 重订本",
    "modules": ["发音字典管理"],
    "importance": 48.5,
    "acknowledgement_group": "academic",
    "authors": "胡裕树（主编）",
    "license": "",
    "urls": {
      "馆藏书目": "https://ci.nii.ac.jp/ncid/BA71639299"
    },
    "citation": "胡裕树, 主编. 现代汉语: 重订本[M]. 上海: 上海教育出版社, 1995.",
    "reference_note": "对应胡裕树《现代汉语》选项。此处列出1995年重订本；历史字表未记录所据版次和页码。"
  },
  {
    "id": "REF-HUANG-LIAO-2012",
    "title": "现代汉语: 上册",
    "modules": ["发音字典管理"],
    "importance": 50,
    "acknowledgement_group": "academic",
    "authors": "黄伯荣；廖序东（主编）",
    "license": "",
    "urls": {
      "出版社书目": "https://xuanshu.hep.com.cn/front/book/findBookDetails?bookId=59cd328fba9eb884cf819448"
    },
    "citation": "黄伯荣, 廖序东, 主编. 现代汉语: 上册[M]. 增订5版. 北京: 高等教育出版社, 2011.",
    "reference_note": "对应黄伯荣、廖序东《现代汉语》选项。此处列出2011年增订五版上册；历史字表未记录所据版次和页码。"
  },
  {
    "id": "REF-QIAN-1990",
    "title": "现代汉语",
    "modules": ["发音字典管理"],
    "importance": 46.5,
    "acknowledgement_group": "academic",
    "authors": "钱乃荣（主编）",
    "license": "",
    "urls": {
      "编写者著作目录": "https://zhwx.ecnu.edu.cn/ae/57/c14647a175703/page.htm"
    },
    "citation": "钱乃荣, 主编. 现代汉语[M]. 北京: 高等教育出版社, 1990.",
    "reference_note": "对应钱乃荣《现代汉语》选项。此处引用1990年高等教育出版社版；2001年江苏教育出版社修订本另有出版记录，历史字表未记录所据版次和页码。"
  },
  {
    "id": "REF-WU-1992",
    "title": "现代汉语语音概要",
    "modules": ["发音字典管理"],
    "importance": 44.5,
    "acknowledgement_group": "academic",
    "authors": "吴宗济（主编）；赵金铭、朱竹、刘骥（编写）",
    "license": "",
    "urls": {
      "馆藏书目": "https://ci.nii.ac.jp/ncid/BA3058811X"
    },
    "citation": "吴宗济, 主编. 现代汉语语音概要[M]. 北京: 华语教学出版社, 1992.",
    "reference_note": "为吴宗济选项补充的语音学参考。历史列只记作者名，尚未确认具体依据是否为本书及相应页码。"
  },
  {
    "id": "REF-CHAO-1979",
    "title": "汉语口语语法",
    "modules": ["发音字典管理"],
    "importance": 53,
    "acknowledgement_group": "academic",
    "authors": "赵元任；吕叔湘（译）",
    "license": "",
    "urls": {
      "出版社书目": "https://www.cp.com.cn/book/9a9ee7ef-1.html",
      "初版出版记录": "https://www.cp.com.cn/Content/2017/02-16/1622474939.html"
    },
    "citation": "赵元任. 汉语口语语法[M]. 吕叔湘, 译. 北京: 商务印书馆, 1979.",
    "reference_note": "对应赵元任《汉语口语语法》选项。引用吕叔湘译本的1979年初版；出版社产品页为后出的重印版，历史字表所据版次和页码待核对。"
  },
  {
    "id": "REF-FANGYIN-2003",
    "title": "汉语方音字汇（第二版重排本）",
    "modules": ["发音字典管理"],
    "importance": 52,
    "acknowledgement_group": "academic",
    "authors": "北京大学中国语言文学系语言学教研室（编）",
    "license": "",
    "urls": {
      "国家图书馆书目": "https://ndlsearch.ndl.go.jp/books/R100000002-Ia1000027590"
    },
    "citation": "北京大学中国语言文学系语言学教研室. 汉语方音字汇[M]. 2版重排本. 北京: 语文出版社, 2003.",
    "reference_note": "对应《汉语方音字汇》选项。此处引用2003年第二版重排本；历史字表所据版次及北京音条目页码待核对。"
  },
  {
    "id": "REF-UNTPHESOCA-2019",
    "title": "新老派普通话的宽严式记音（含儿化韵）",
    "modules": ["发音字典管理", "语音合成"],
    "importance": 69,
    "acknowledgement_group": "academic",
    "authors": "UntPhesoca",
    "license": "",
    "urls": {
      "作者网站": "https://phesoca.com/aws/268/"
    },
    "citation": "UntPhesoca. 新老派普通话的宽严式记音（含儿化韵）[EB/OL]. (2019-04-22)[2026-10-11]. https://phesoca.com/aws/268/.",
    "reference_note": "对应 UntPhesoca宽、UntPhesoca严。采用作者网站2026-10-11访问正文，更新记录至2024-10-11。两列采用中派基准，自由变体取第一项，宽式上声214、严式上声213。支持自动或手动组合儿化及逐项拆分。"
  },
  {
    "id": "REF-PINYIN-1958",
    "title": "汉语拼音方案",
    "modules": ["发音字典管理"],
    "importance": 66.5,
    "acknowledgement_group": "academic",
    "authors": "全国人民代表大会",
    "license": "",
    "urls": {
      "方案全文": "https://yywz.ecnu.edu.cn/1f/56/c30556a335702/page.htm",
      "批准日期依据": "https://www.moe.gov.cn/ewebeditor/uploadfile/2015/01/13/20150113091717604.pdf"
    },
    "citation": "全国人民代表大会. 汉语拼音方案[S/OL]. (1958-02-11)[2026-11-25]. https://yywz.ecnu.edu.cn/1f/56/c30556a335702/page.htm.",
    "reference_note": "对应汉语拼音选项，供字母、音节及标调规则参考。方案于1958年2月11日批准；当前模块不提供按词分写的正词法转换。"
  },
  {
    "id": "REF-MILLS-2019",
    "title": "What is a tongue tie? Defining the anatomy of the in-situ lingual frenulum",
    "modules": ["语音合成"],
    "importance": 41.5,
    "acknowledgement_group": "academic",
    "authors": "Nikki Mills；Seth M. Pransky；Donna T. Geddes；Seyed Ali Mirjalili",
    "license": "Reference only; no article assets copied",
    "urls": {
      "paper": "https://pubmed.ncbi.nlm.nih.gov/30701608/",
      "doi": "https://doi.org/10.1002/ca.23343"
    },
    "citation": "MILLS N, PRANSKY S M, GEDDES D T, et al. What is a tongue tie? Defining the anatomy of the in-situ lingual frenulum[J]. Clinical Anatomy, 2019, 32(6): 749-761. DOI: 10.1002/ca.23343.",
    "reference_note": ""
  },
  {
    "id": "REF-MILLS-2020",
    "title": "Understanding the Lingual Frenulum: Histological Structure, Tissue Composition, and Implications for Tongue Tie Surgery",
    "modules": ["语音合成"],
    "importance": 41,
    "acknowledgement_group": "academic",
    "authors": "Nikki Mills；Donna T. Geddes；Satya Amirapu；S. Ali Mirjalili",
    "license": "Reference only; no article assets copied",
    "urls": {
      "paper": "https://pubmed.ncbi.nlm.nih.gov/32774383/",
      "doi": "https://doi.org/10.1155/2020/1820978"
    },
    "citation": "MILLS N, GEDDES D T, AMIRAPU S, et al. Understanding the Lingual Frenulum: Histological Structure, Tissue Composition, and Implications for Tongue Tie Surgery[J]. International Journal of Otolaryngology, 2020, 2020: 1820978. DOI: 10.1155/2020/1820978.",
    "reference_note": ""
  },
  {
    "id": "REF-READING-REPAIRS-2021",
    "title": "重編國語辭典修訂本（2021年版）及異體字字典",
    "modules": ["发音字典管理"],
    "importance": 54,
    "acknowledgement_group": "academic",
    "authors": "教育部",
    "license": "",
    "urls": {
      "修訂本": "https://dict.revised.moe.edu.tw/",
      "異體字字典": "https://dict.variants.moe.edu.tw/"
    },
    "citation": "教育部. 重編國語辭典修訂本[DB/OL]. 臺灣學術網路第6版. (2021-11)[2026-10-11]. https://dict.revised.moe.edu.tw/.\n教育部. 異體字字典[DB/OL]. 臺灣學術網路第14版（正式7版）. (2024-03)[2026-10-11]. https://dict.variants.moe.edu.tw/.",
    "reference_note": "用于核对字表中的异常读音和简繁字形，修正应用于全部转换标准。"
  },
  {
    "id": "SRC-PINK-TROMBONE",
    "title": "Pink Trombone",
    "modules": ["工作台与基础架构"],
    "importance": 9,
    "acknowledgement_group": "software",
    "authors": "Neil Thapen",
    "license": "MIT",
    "urls": {
      "homepage": "https://dood.al/pinktrombone/"
    },
    "citation": "THAPEN N. Pink Trombone[CP/OL]. https://dood.al/pinktrombone/.",
    "reference_note": "继承自 PhoneticToolbox；本次未在 VoxFigura 的源代码中找到 Pink Trombone 的直接调用或移植。"
  },
  {
    "id": "LIB-VUE-I18N",
    "title": "Vue I18n and Intlify runtime dependencies",
    "modules": ["工作台与基础架构"],
    "importance": 4,
    "acknowledgement_group": "software",
    "authors": "kazuya kawaguchi and Intlify contributors",
    "license": "MIT",
    "urls": {
      "repository": "https://github.com/intlify/vue-i18n",
      "documentation": "https://vue-i18n.intlify.dev/"
    },
    "citation": "KAWAGUCHI K AND INTLIFY CONTRIBUTORS. Vue I18n[CP/OL]. https://github.com/intlify/vue-i18n.",
    "reference_note": "继承自 PhoneticToolbox；本项目 npm 依赖清单与代码检索未发现 Vue I18n 调用。"
  },
  {
    "id": "SRC-SWIFTF0",
    "title": "SwiftF0",
    "modules": ["核心引擎与模型", "声道动态重建", "发音字典管理", "发声调音台"],
    "importance": 87.5,
    "acknowledgement_group": "software",
    "authors": "Lars Nieradzik",
    "license": "MIT",
    "urls": {
      "code": "https://github.com/lars76/swift-f0"
    },
    "citation": "NIERADZIK L. SwiftF0[CP/OL]. https://github.com/lars76/swift-f0.",
    "reference_note": "本地引擎使用 SwiftF0 ONNX 进行基频估计；模型文件与许可证从 PhoneticToolbox 集成。"
  },
  {
    "id": "SRC-ONNXRUNTIME",
    "title": "ONNX Runtime",
    "modules": ["核心引擎与模型", "声道动态重建", "语音合成", "发声调音台"],
    "importance": 94,
    "acknowledgement_group": "software",
    "authors": "Microsoft contributors",
    "license": "MIT; bundled third-party notices",
    "urls": {
      "code": "https://github.com/microsoft/onnxruntime"
    },
    "citation": "MICROSOFT AND CONTRIBUTORS. ONNX Runtime[CP/OL]. https://github.com/microsoft/onnxruntime.",
    "reference_note": "本地引擎使用 ONNX Runtime 装载与执行 ONNX 模型；具体版本由运行环境决定。"
  },
  {
    "id": "PKG-MEDIABUNNY",
    "title": "mediabunny",
    "modules": ["剪辑", "工作台与基础架构"],
    "importance": 8,
    "acknowledgement_group": "software",
    "authors": "Vanilagy",
    "license": "MPL-2.0",
    "urls": {
      "registry": "https://www.npmjs.com/package/mediabunny/v/1.66.0",
      "repository": "https://github.com/Vanilagy/mediabunny"
    },
    "citation": "VANILAGY. mediabunny 1.66.0[CP/OL]. https://www.npmjs.com/package/mediabunny/v/1.66.0.",
    "reference_note": "继承自 PhoneticToolbox；本项目 npm 依赖清单与代码检索未发现 mediabunny 调用。"
  },
  {
    "id": "PKG-TYPES-DOM-WEBCODECS",
    "title": "@types/dom-webcodecs",
    "modules": ["剪辑", "工作台与基础架构"],
    "importance": 7,
    "acknowledgement_group": "software",
    "authors": "Ben Wagner",
    "license": "MIT",
    "urls": {
      "registry": "https://www.npmjs.com/package/@types/dom-webcodecs/v/0.1.13",
      "repository": "https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/dom-webcodecs"
    },
    "citation": "WAGNER B. @types/dom-webcodecs 0.1.13[CP/OL]. https://www.npmjs.com/package/@types/dom-webcodecs/v/0.1.13.",
    "reference_note": "继承自 PhoneticToolbox；本项目 npm 依赖清单未发现该类型包。浏览器原生 WebCodecs 接口另有参考条目。"
  },
  {
    "id": "PKG-TYPES-DOM-MEDIACAPTURE-TRANSFORM",
    "title": "@types/dom-mediacapture-transform",
    "modules": ["剪辑", "工作台与基础架构"],
    "importance": 6,
    "acknowledgement_group": "software",
    "authors": "Ben Wagner",
    "license": "MIT",
    "urls": {
      "registry": "https://www.npmjs.com/package/@types/dom-mediacapture-transform/v/0.1.12",
      "repository": "https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/dom-mediacapture-transform"
    },
    "citation": "WAGNER B. @types/dom-mediacapture-transform 0.1.12[CP/OL]. https://www.npmjs.com/package/@types/dom-mediacapture-transform/v/0.1.12.",
    "reference_note": "继承自 PhoneticToolbox；本项目 npm 依赖清单未发现该类型包。"
  },
  {
    "id": "DATA-JAPANESE-MFA",
    "title": "Japanese MFA dictionary v3.0.0",
    "modules": ["发音字典管理", "语音合成", "编曲"],
    "importance": 72,
    "acknowledgement_group": "software",
    "authors": "Michael McAuliffe and Morgan Sonderegger；Montreal Forced Aligner",
    "license": "CC BY 4.0",
    "urls": {
      "model_card": "https://mfa-models.readthedocs.io/en/latest/dictionary/Japanese/Japanese%20MFA%20dictionary%20v3_0_0.html",
      "release": "https://github.com/MontrealCorpusTools/mfa-models/releases/tag/dictionary-japanese_mfa-v3.0.0",
      "license": "https://creativecommons.org/licenses/by/4.0/"
    },
    "citation": "MCAULIFFE M, SONDEREGGER M. Japanese MFA dictionary v3.0.0[DS/OL]. 2024. https://mfa-models.readthedocs.io/en/latest/dictionary/Japanese/Japanese%20MFA%20dictionary%20v3_0_0.html.",
    "reference_note": "随包词典由该版本筛选纯假名词条并分片压缩，源地址、摘要和修改范围见 public/vocal-tract/assets/ja-mfa-v3/manifest.json。"
  },
  {
    "id": "DATA-JAPANESE-ACCENT",
    "title": "Open JTalk / NAIST-JDIC & UniDic 日语东京声调词典精简子集",
    "modules": ["发音字典管理", "语音合成"],
    "importance": 74,
    "acknowledgement_group": "software",
    "authors": "Nara Institute of Science and Technology (NAIST)；The UniDic Consortium；HTS Working Group (Nagoya Institute of Technology)",
    "license": "BSD-3-Clause（Modified BSD License）",
    "urls": {
      "open_jtalk": "http://open-jtalk.sourceforge.net/",
      "license_local": "/licenses/naist-jdic.txt"
    },
    "citation": "HTS Working Group, Nara Institute of Science and Technology, The UniDic Consortium. Open JTalk / NAIST-JDIC & UniDic Japanese Dictionary[DS/OL]. 2008–2017. http://open-jtalk.sourceforge.net/.",
    "reference_note": "由开源 Open JTalk NAIST-JDIC 词典只读提取 408,422 条词形、平假名读音、东京音调核与助词标记并压缩为 16 个前端分片（共 2.34 MB），用于离线日语汉字/假名声调标注与 F0 轮廓生成；源摘要与各分片校验见 public/vocal-tract/assets/ja-accent-v1/manifest.json，完整 BSD 版权声明随包附于 public/licenses/naist-jdic.txt。"
  },
  ...additionalReferences,
  ...editionReferences,
].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
