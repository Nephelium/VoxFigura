interface ExportHelp {
  format: string;
  data: string[];
  use: string;
  reimport: string;
}

interface ExportOption {
  kind: string;
  suffix: string;
  badge: string;
  label: string;
  detail: string;
  help: ExportHelp;
}

export const exportOptions = [
  {
    kind: 'mid',
    suffix: 'mid',
    badge: 'mid',
    label: 'MIDI 乐谱',
    detail: '导出多轨标准 MIDI（含轨名、歌词、力度与速度/拍号）',
    help: {
      format: 'Standard MIDI Format 1（960 PPQ），UTF-8 编码轨名与歌词，所有启用轨道同步写入。',
      data: [
        '保存全部已启用轨道（遵循静音 M 与独奏 S 状态）的音高、时值、力度、GM 乐器音色、控制器、变速图与拍号变化。',
        '人声轨的歌词会按音节起音时刻写入 MIDI Lyrics 事件；单端口最多支持 15 条旋律轨与 1 条鼓轨。',
      ],
      use: '可直接导入任意 DAW、制谱软件（MuseScore / Guitar Pro）或其他歌声合成软件继续编曲。',
      reimport: '在编曲页左栏顶部点击「导入乐谱」，选择 .mid 文件即可按轨挑选并导回工作台。',
    },
  },
  {
    kind: 'vsqx',
    suffix: 'vsqx',
    badge: 'vsqx',
    label: 'VOCALOID 工程 (VSQX)',
    detail: '导出 VOCALOID 4 多轨歌声工程（含歌词、拖腔与音素）',
    help: {
      format: 'VOCALOID 4 XML 工程文件（<vsq4>，480 PPQ，含 1 小节预备拍），兼容 VOCALOID 4/5/6、OpenUtau 与 UtaFormatix。',
      data: [
        '保存全部启用轨道的音符起止、音高、力度、静音/独奏/音量、速度图与拍号变化。',
        '人声轨自动保留一字多音拖腔（续音记为 -），并自动将中文/英语/日语 IPA 转换为对应 VOCALOID X-SAMPA 音素（导入自 VSQX 且未改音标时原样保留原始音素）。',
      ],
      use: '可直接在 VOCALOID 编辑器、OpenUtau 或支持 VSQX 的歌声软件中打开调教与渲染。',
      reimport: '在编曲页左栏顶部点击「导入乐谱」，选择 .vsqx 文件即可完整恢复多轨音符、歌词与音素。',
    },
  },
  {
    kind: 'svp',
    suffix: 'svp',
    badge: 'svp',
    label: 'Synthesizer V 工程 (SVP)',
    detail: '导出 SynthV Studio 多轨工程（含歌词、拖腔、音素与混音）',
    help: {
      format: 'Synthesizer V Studio JSON 工程文件（705,600,000 blicks/拍），UTF-8 编码。',
      data: [
        '保存全部启用轨道的音符起止、音高、轨道混音增益/静音/独奏、速度变化与拍号变化。',
        '人声轨自动保留一字多音拖腔（续音记为 -），按语种设置数据库语言与音标集，并将中文 IPA 映射为 X-SAMPA、英语 IPA 映射为 ARPAbet（未改音标时原样保留导入的原始音素）。',
      ],
      use: '可直接在 Synthesizer V Studio 中打开，挂接任意 AI 声库继续调校音高、气声与唱法。',
      reimport: '在编曲页左栏顶部点击「导入乐谱」，选择 .svp 文件即可完整恢复多轨音符、歌词与音素。',
    },
  },
  {
    kind: 'vcproj',
    suffix: 'vcproj',
    badge: 'vcproj',
    label: '工程文件',
    detail: '保存可继续编辑的标注、参数与剪辑时间线',
    help: {
      format: 'VoxFigura 的 JSON 工程文件，带格式版本号，可用文本编辑器查看。时间字段中的 _smp 是 48 kHz 整数采样位置，48,000 个采样等于 1 秒。',
      data: [
        '工程设置（settings）存画幅、速度等全局配置。声部（voices）存说话人、模型构型配置和参考基频。',
        '片段（clips）下有音节，音节下有音素区间。声道构型、发声态锚点和基频控制数据随工程保存。轨道（tracks）与图层（layers）记录字幕、剪辑位置和图层关键帧。',
        '素材表（assets）以 ID 关联片段和图层，记录文件引用和校验信息。自行导入的录音、视频、图片需另外保留。各项的 _order 字段记录排列顺序。',
      ],
      use: '用于备份当前编辑状态、换机交接或日后继续修改。试听音频和仅存在于声道重建会话中的轨迹，可在需要时另行导出。',
      reimport: '将 .vcproj 拖入「语音合成」的语料库或时间轴，或在「剪辑 → 媒体库 → 导入」打开工程。导入会切换当前工程，建议先下载当前工程副本。剪辑素材缺失时，在媒体库中选回原文件以重新关联。',
    },
  },
  {
    kind: 'srt',
    suffix: 'srt',
    badge: 'srt',
    label: '时间轴字幕',
    detail: '按字幕片段的剪切、移动和源位置导出',
    help: {
      format: 'SubRip 纯文本字幕，每条包含序号、起止时间与字幕文字。',
      data: ['取剪辑时间线上的可见音节，反映字幕片段的剪切和移动位置。开启字幕图层的 IPA 显示时会附音标。'],
      use: '可与视频一起在支持外部字幕的播放器中打开，或导入支持 SRT 的剪辑软件。',
      reimport: '工作台目前没有 SRT 字幕导入入口。要在 VoxFigura 继续编辑字幕轨，请另存并打开 .vcproj。',
    },
  },
  {
    kind: 'ass',
    suffix: 'ass',
    badge: 'ass',
    label: '卡拉 OK 字幕',
    detail: '保存字幕时序与音节持续时间',
    help: {
      format: 'Advanced SubStation Alpha 文本字幕，包含画面尺寸、字幕样式与带卡拉 OK 时长标签的事件。',
      data: ['取剪辑时间线上的可见音节与持续时间。开启字幕图层的 IPA 显示时会附音标。'],
      use: '可与视频一起在支持 ASS 卡拉 OK 效果的播放器中打开，或在 ASS 字幕编辑器中进一步调整。',
      reimport: '工作台目前没有 ASS 字幕导入入口。要在 VoxFigura 继续编辑字幕轨，请另存并打开 .vcproj。',
    },
  },
  {
    kind: 'textgrid',
    suffix: 'TextGrid',
    badge: 'TextGrid',
    label: 'Praat 音节与音素标注',
    detail: '导出标注区间与发声态锚点',
    help: {
      format: 'Praat 文本标注文件，时间单位为秒，音频需单独保存。',
      data: ['syllable 层是音节文字，phone 层是音素 IPA，两层都记录起止时间。重叠片段另排编号层。phonation 点层记录工程发声态锚点的时间和标签。'],
      use: '在 Praat 中与时间轴对应的录音或合成音频一起打开，可校对边界、查看音标或按区间提取声学数据。',
      reimport: '将文件拖到「语音合成」的时间轴上轨，可载入音节与音素标注。也可在「声道动态重建 → 导入 TextGrid」给录音附加边界。多组重叠层的剪辑和可编辑发声态锚点请用 .vcproj 恢复。',
    },
  },
  {
    kind: 'pitchtier',
    suffix: 'PitchTier',
    badge: 'PitchTier',
    label: '控制基频',
    detail: '导出当前乐句的 qTA 曲线与钉住点结果',
    help: {
      format: 'Praat 基频点序列。每个点包含工程时间（秒）与控制基频（Hz），采样间隔约 10 ms。',
      data: ['记录当前乐句根据 qTA、基频钉住点等控制生成的目标曲线。录音中实测的基频需另行测量。'],
      use: '在 Praat 中查看或编辑控制曲线，也可与对应音频的实测基频做对照。',
      reimport: '工作台目前没有 PitchTier 导入入口。要继续编辑工程里保存的基频目标与钉住点，请使用 .vcproj。',
    },
  },
  {
    kind: 'csv_50hz',
    suffix: '50hz.csv',
    badge: 'CSV·50Hz',
    label: '动态时间序列长表 (50 Hz)',
    detail: '每 20 ms 一行，保存声道、声源与音段信息',
    help: {
      format: 'UTF-8 CSV（含 BOM），每 20 ms 一行。time_s、time_ms 分别记录秒和毫秒。',
      data: [
        '包含音节与音素标签、段内位置、声道 19 列，以及基频、气压和 8 个声门控制量。声道重建源的 17 个声道参数会补为 19 列，TRX、TRY 为默认值。',
        'source_mode 区分标注合成与声道重建。声道重建可配合 TextGrid 提供标签。最小截面积和 F1–F3 在有相应数据时填入。',
      ],
      use: '用 Excel、R 或 Python 按真实时间绘制参数轨迹，查看变化速度、时长与标注边界的关系。',
      reimport: '这是分析表格，工作台目前没有此类 CSV 的轨迹导入入口。需要回到工程继续编辑时，请另存 .vcproj。',
    },
  },
  {
    kind: 'csv_norm10',
    suffix: 'norm10.csv',
    badge: 'CSV·u10',
    label: '音段等分长表 (每音素 10 点)',
    detail: '按音段相对位置取样，便于比较不同时长的音素',
    help: {
      format: 'UTF-8 CSV（含 BOM）。每个非静音音素取 10 个等距点，u_phone 从 0（起点）到 1（终点），另保留原时间。',
      data: [
        '与 50 Hz 长表使用相同的列，记录标注、声道、声源和可用的声学指标。各音素的取样间隔随音素时长变化。',
        '导出声道重建轨迹前可导入含音素区间的 TextGrid。缺少有效音素区间时，声道重建轨迹会整段取 10 个点。',
      ],
      use: '在 R 或 Python 中按 u_phone 对齐长短不同的音段，可用于画归一化轨迹或做 GAMM、SSANOVA 等分析。',
      reimport: '工作台目前没有此类 CSV 的轨迹导入入口。标注边界可用 TextGrid 导入，工程编辑状态请用 .vcproj 恢复。',
    },
  },
  {
    kind: 'csv',
    suffix: 'csv',
    badge: 'CSV·单帧',
    label: '当前瞬时声道参数',
    detail: '保存播放头处的构型、基频、气压与声学指标',
    help: {
      format: 'UTF-8 CSV（含 BOM），表头下只有一行数据。playhead_smp 是当前播放头的 48 kHz 采样位置。',
      data: ['保存当前声道构型、控制基频（Hz）、气压（Pa）、最小截面积（cm²）和 F1、F2（Hz）。metric_source 标明声学指标来自 VTL 引擎还是解析预览。'],
      use: '用于记录一个构型的数值，或对照不同播放位置、不同构型的参数。需要完整轨迹时可选 50 Hz 长表。',
      reimport: '工作台目前没有此类 CSV 的构型导入入口。需要保存可继续编辑的工程内构型时，请使用 .vcproj。',
    },
  },
  {
    kind: 'wav',
    suffix: 'wav',
    badge: 'wav',
    label: '试听音频',
    detail: '保存当前试听缓冲里的音频',
    help: {
      format: '16 位 PCM WAV，采样率和声道数沿用试听缓冲。',
      data: ['保存最近生成、载入或编辑后留在试听缓冲中的音频波形。生成或载入可试听的音频后即可下载。'],
      use: '可直接播放，也可在 Praat、音频编辑器或播放器中打开。若要和 TextGrid 对照，请选时间范围一致的音频。',
      reimport: '拖到「语音合成」的多轨联动时间轴工具栏可载入试听，也可通过「剪辑 → 媒体库 → 导入」添加为素材。要恢复标注或工程编辑状态，请另存对应的 TextGrid 或 .vcproj。',
    },
  },
] as const satisfies readonly ExportOption[];

export type ExportOptionEntry = typeof exportOptions[number];
