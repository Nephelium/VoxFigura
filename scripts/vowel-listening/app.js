import { measureRecordingSilence } from '/recording-silence.js';
import { startMicrophone } from '/microphone.js';

const get = id => document.getElementById(id);
const canvas = get('plot');
const context = canvas.getContext('2d');
const audio = get('audio');
const rangeStart = get('range-start');
const rangeEnd = get('range-end');
const detail = get('point-detail');
const currentFile = get('current-file');
const emptyPlayerMessage = currentFile.textContent;
const groups = [];
const groupStyles = [
  { color: '#006b64', shape: 'circle' },
  { color: '#a13d31', shape: 'diamond' },
  { color: '#2c6095', shape: 'square' },
  { color: '#785092', shape: 'triangle' },
  { color: '#8a590c', shape: 'circle' },
  { color: '#496924', shape: 'diamond' },
  { color: '#9c426c', shape: 'square' },
  { color: '#4d6170', shape: 'triangle' },
];
let references = [];
let current = null;
let plotted = [];
let showSilence = false;
let axis = 'linear';
let capture = null;
let groupIndex = 0;
let lastDeletion = null;

function candidateSummary(take) {
  const point = take.analysis?.measurement;
  if (take.pending) return '测量中…';
  if (take.error && !point) return take.error;
  if (point) return `F1 ${point.f1} · F2 ${point.f2} Hz`;
  return '稳定有声帧不足';
}

function renderTake(take) {
  take.metrics.textContent = candidateSummary(take);
  take.button.setAttribute('aria-pressed', String(current === take));
}

function renderGroup(group) {
  group.empty.hidden = group.takes.length > 0;
  group.keptBox.hidden = !group.kept;
  for (const take of group.takes) renderTake(take);
  if (!group.kept) {
    group.download.removeAttribute('href');
    return;
  }
  group.keptName.textContent = `已选 ${group.kept.id} · ${group.kept.file.name}`;
  group.download.href = group.kept.url;
  group.download.download = group.kept.file.name;
}

function renderPlayer() {
  const take = current;
  get('player-controls').hidden = !take;
  if (!take) {
    currentFile.textContent = emptyPlayerMessage;
    return;
  }
  currentFile.textContent = `${take.id} · ${take.file.name} · ${candidateSummary(take)}`;
  const kept = take.group.kept === take;
  get('keep').setAttribute('aria-pressed', String(kept));
  get('keep').textContent = kept ? '取消保留' : '保留这条';
  const full = take.analysis;
  rangeStart.value = full?.start_s ?? '';
  rangeEnd.value = full?.end_s ?? '';
  rangeEnd.max = rangeStart.max = full?.duration_s ?? '';
  get('remeasure').disabled = !full || take.pending;
  const point = full?.measurement;
  get('range-info').textContent = take.error || (point
    ? `核心区间 ${point.core_start_s.toFixed(3)}–${point.core_end_s.toFixed(3)} 秒 · ${point.frames} 个有效帧`
    : full ? '可缩小到单独一个元音的声段后再测。' : '');
}

function selectTake(take, play) {
  const previous = current;
  current = take;
  if (previous !== take) {
    if (take) {
      audio.src = take.url;
    } else {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (previous) renderTake(previous);
  }
  if (take) renderTake(take);
  renderPlayer();
  draw();
  if (previous !== take && showSilence) void renderSilence();
  if (take && play && !capture) void audio.play().catch(() => {
    if (current === take) get('range-info').textContent = '浏览器无法播放该格式，可改用 PCM WAV。';
  });
}

async function renderSilence() {
  const take = current;
  const status = get('silence-status');
  const track = get('silence-track');
  track.hidden = true;
  track.replaceChildren();
  if (!take) {
    status.textContent = '点选一条候选录音以查看静音段';
    return;
  }
  status.textContent = '正在读取原录音…';
  take.silence ??= take.file.arrayBuffer().then(measureRecordingSilence).catch(() => null);
  const data = await take.silence;
  if (!showSilence || current !== take) return;
  if (!data) {
    status.textContent = '原录音静音段暂不可用';
    return;
  }
  track.replaceChildren();
  for (const { start_s, end_s } of data.intervals) {
    const span = document.createElement('span');
    span.style.left = `${100 * start_s / data.duration_s}%`;
    span.style.width = `${100 * (end_s - start_s) / data.duration_s}%`;
    track.append(span);
  }
  track.hidden = false;
  status.textContent = data.intervals.length
    ? data.intervals.map(({ start_s, end_s }) => `${start_s.toFixed(2)}–${end_s.toFixed(2)} s`).join('、')
    : '未检测到静音段';
}

async function measure(take, interval) {
  take.pending = true;
  take.error = '';
  renderTake(take);
  if (current === take) get('remeasure').disabled = true;
  try {
    const path = interval ? '/measure?' + new URLSearchParams(interval) : '/measure';
    const response = await fetch(path, { method: 'POST', body: take.file, signal: AbortSignal.timeout(25000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    take.analysis = data;
  } catch (error) {
    take.error = error.name === 'TimeoutError' || error instanceof TypeError ? '本机测量服务未响应。' : error.message;
  } finally {
    take.pending = false;
    renderTake(take);
    if (current === take) renderPlayer();
    draw();
  }
}

function makeTake(group, file) {
  const take = { group, file, id: group.id + group.nextTake++, url: URL.createObjectURL(file), pending: true };
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'take';
  button.title = file.name;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = take.id;
  const name = document.createElement('span');
  name.className = 'filename';
  name.textContent = file.name;
  const metrics = document.createElement('span');
  metrics.className = 'metrics';
  button.append(tag, name, metrics);
  button.addEventListener('click', () => selectTake(take, true));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'delete-take';
  remove.textContent = '删除';
  remove.setAttribute('aria-label', `删除录音 ${take.id}`);
  remove.addEventListener('click', () => deleteTake(take));
  item.append(button, remove);
  group.list.append(item);
  take.item = item;
  take.button = button;
  take.metrics = metrics;
  group.takes.push(take);
  return take;
}

async function addTakes(group, files, selectNewest = false) {
  const takes = Array.from(files, file => makeTake(group, file));
  renderGroup(group);
  if ((!current || selectNewest) && takes.length) selectTake(selectNewest ? takes.at(-1) : takes[0], false);
  for (const take of takes) await measure(take);
}

function recordStatus(group, message) {
  group.recordStatus.textContent = message;
  group.recordStatus.hidden = !message;
}

function renderRecordingButtons() {
  for (const group of groups) {
    const ownsCapture = capture?.group === group;
    const canStop = ownsCapture && capture.state === 'recording';
    const button = group.record;
    button.disabled = Boolean(capture && !canStop);
    button.dataset.active = String(Boolean(canStop));
    button.textContent = canStop ? '停止录音' : ownsCapture && capture.state === 'stopping' ? '正在保存…' : '录音';
    button.setAttribute('aria-label', canStop ? `停止音 ${group.id} 的录音` : `为音 ${group.id} 录音`);
    group.remove.disabled = ownsCapture;
  }
}

async function toggleRecording(group) {
  if (capture) {
    if (capture.group === group && capture.state === 'recording') {
      capture.state = 'stopping';
      capture.microphone.stop();
      renderRecordingButtons();
    }
    return;
  }
  const session = { group, state: 'starting' };
  capture = session;
  audio.pause();
  renderRecordingButtons();
  recordStatus(group, '正在连接麦克风…');
  try {
    session.microphone = await startMicrophone((wav, error) => {
      if (capture !== session) return;
      capture = null;
      renderRecordingButtons();
      recordStatus(group, error);
      if (wav) {
        const name = `录音-${group.id}${group.nextTake}.wav`;
        void addTakes(group, [new File([wav], name, { type: wav.type })], true);
      }
    });
    if (capture !== session) return;
    session.state = 'recording';
    renderRecordingButtons();
    recordStatus(group, '录音中 · 最长 30 秒');
  } catch (error) {
    if (capture !== session) return;
    capture = null;
    renderRecordingButtons();
    const message = {
      NotAllowedError: '请在浏览器中允许此页面使用麦克风。',
      NotFoundError: '未找到麦克风，请连接输入设备后重试。',
      NotReadableError: '无法读取麦克风，请检查系统输入设置。',
    }[error.name];
    recordStatus(group, message ?? `无法开始录音 · ${error.message}`);
  }
}

function groupLabel(index) {
  let label = '';
  for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) {
    label = String.fromCharCode(65 + (i - 1) % 26) + label;
  }
  return label;
}

function addGroup() {
  const index = groupIndex++;
  const id = groupLabel(index);
  const { color, shape } = groupStyles[index % groupStyles.length];
  const node = get('group-template').content.firstElementChild.cloneNode(true);
  node.dataset.group = id;
  node.style.setProperty('--group', color);
  node.querySelector('.group-title').textContent = `音 ${id}`;
  node.querySelector('h2 .dot').dataset.shape = shape;
  const target = node.querySelector('.target');
  target.setAttribute('aria-label', `音 ${id} 的目标音标`);
  const files = node.querySelector('.files');
  files.setAttribute('aria-label', `为音 ${id} 添加录音`);
  const group = {
    id, node, target, takes: [], nextTake: 1, kept: null, color, shape,
    remove: node.querySelector('.delete-group'),
    record: node.querySelector('.record'), recordStatus: node.querySelector('.record-status'),
    list: node.querySelector('.takes'), empty: node.querySelector('.empty'),
    keptBox: node.querySelector('.kept'), keptName: node.querySelector('.kept-name'), download: node.querySelector('.save'),
  };
  groups.push(group);
  get('add-group').before(node);
  const legend = document.createElement('span');
  const dot = document.createElement('i');
  dot.className = 'dot';
  dot.dataset.shape = shape;
  dot.style.setProperty('--group', color);
  legend.append(dot, `音 ${id}`);
  get('group-legend').append(legend);
  group.legend = legend;

  target.addEventListener('input', draw);
  group.record.addEventListener('click', () => void toggleRecording(group));
  group.remove.setAttribute('aria-label', `删除音 ${id} 整组`);
  group.remove.addEventListener('click', () => deleteGroup(group));
  files.addEventListener('change', () => {
    const selection = Array.from(files.files);
    files.value = '';
    void addTakes(group, selection);
  });
  renderRecordingButtons();
  return group;
}

function rememberDeletion(message, takes, restore) {
  for (const take of lastDeletion?.takes ?? []) URL.revokeObjectURL(take.url);
  lastDeletion = { takes, restore };
  get('undo-message').textContent = message;
  get('undo-notice').hidden = false;
  get('undo-delete').focus();
  detail.hidden = true;
}

function deleteTake(take) {
  const group = take.group;
  const index = group.takes.indexOf(take);
  const wasKept = group.kept === take;
  const wasCurrent = current === take;
  group.takes.splice(index, 1);
  take.item.remove();
  if (wasKept) group.kept = null;
  renderGroup(group);
  if (wasCurrent) selectTake(null, false);
  else draw();
  rememberDeletion(`已删除录音 ${take.id}`, [take], () => {
    group.takes.splice(index, 0, take);
    group.list.insertBefore(take.item, group.takes[index + 1]?.item ?? null);
    if (wasKept && !group.kept) group.kept = take;
    renderGroup(group);
    if (wasCurrent && !current) selectTake(take, false);
    else draw();
    take.button.focus();
  });
}

function deleteGroup(group) {
  if (capture?.group === group) return;
  const index = groups.indexOf(group);
  const previous = current?.group === group ? current : null;
  groups.splice(index, 1);
  group.node.remove();
  group.legend.remove();
  if (previous) selectTake(null, false);
  else draw();
  rememberDeletion(`已删除音 ${group.id} 整组`, group.takes, () => {
    const next = groups[index];
    groups.splice(index, 0, group);
    (next?.node ?? get('add-group')).before(group.node);
    get('group-legend').insertBefore(group.legend, next?.legend ?? null);
    renderRecordingButtons();
    if (previous && !current) selectTake(previous, false);
    else draw();
    group.target.focus();
  });
}

get('undo-delete').addEventListener('click', () => {
  const deletion = lastDeletion;
  lastDeletion = null;
  get('undo-notice').hidden = true;
  deletion?.restore();
});

addGroup();
addGroup();
get('add-group').addEventListener('click', () => addGroup().target.focus());

get('keep').addEventListener('click', () => {
  if (!current) return;
  const group = current.group;
  group.kept = group.kept === current ? null : current;
  renderGroup(group);
  renderPlayer();
  draw();
});

get('toggle-silence').addEventListener('click', event => {
  showSilence = !showSilence;
  event.currentTarget.setAttribute('aria-pressed', String(showSilence));
  get('silence-row').hidden = !showSilence;
  if (showSilence) void renderSilence();
});

get('range').addEventListener('submit', event => {
  event.preventDefault();
  if (current?.analysis && !current.pending) {
    void measure(current, { start_s: rangeStart.value, end_s: rangeEnd.value });
  }
});

const axisButtons = document.querySelectorAll('[data-axis]');
for (const button of axisButtons) {
  button.addEventListener('click', () => {
    axis = button.dataset.axis;
    for (const choice of axisButtons) choice.setAttribute('aria-pressed', String(choice === button));
    canvas.setAttribute('aria-label', `F2 与 F1 声学元音图，${button.textContent}坐标。也可从右侧列表选择候选录音。`);
    detail.hidden = true;
    draw();
  });
}

function labelPoint(point, boxes, bounds, text, color, font, offset) {
  context.font = font;
  context.textAlign = 'left';
  const w = context.measureText(text).width;
  for (const [dx, dy] of [[offset, -offset], [offset, offset + 8], [-w - offset, -offset], [-w - offset, offset + 8]]) {
    const x = point.x + dx;
    const y = point.y + dy;
    const rect = { x: x - 2, y: y - 11, w: w + 4, h: 15 };
    if (rect.x < bounds.left || rect.x + rect.w > bounds.right ||
        rect.y < bounds.top || rect.y + rect.h > bounds.bottom ||
        boxes.some(b => b.x < rect.x + rect.w && b.x + b.w > rect.x && b.y < rect.y + rect.h && b.y + b.h > rect.y)) continue;
    context.fillStyle = color;
    context.fillText(text, x, y);
    boxes.push(rect);
    return;
  }
}

function frequencyPosition(min, max, start, end) {
  const transform = axis === 'logarithmic' ? Math.log10 : value => value;
  const origin = transform(min);
  const span = transform(max) - origin;
  return frequency => start + (end - start) * (transform(frequency) - origin) / span;
}

function traceMarker(x, y, radius, shape) {
  if (shape === 'diamond') {
    context.moveTo(x, y - radius - 1);
    context.lineTo(x + radius + 1, y);
    context.lineTo(x, y + radius + 1);
    context.lineTo(x - radius - 1, y);
    context.closePath();
  } else if (shape === 'square') {
    context.rect(x - radius, y - radius, 2 * radius, 2 * radius);
  } else if (shape === 'triangle') {
    context.moveTo(x, y - radius - 1);
    context.lineTo(x + radius + 1, y + radius);
    context.lineTo(x - radius - 1, y + radius);
    context.closePath();
  } else {
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
}

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const takes = groups.flatMap(group => group.takes);
  const candidates = takes.flatMap(take => take.analysis?.measurement ? [{ ...take.analysis.measurement, take }] : []);
  const points = [...references, ...candidates];
  const f1Min = Math.max(50, 100 * Math.floor(Math.min(200, ...points.map(p => p.f1 - 30)) / 100));
  const f1Max = 100 * Math.ceil(Math.max(900, ...points.map(p => p.f1 + 40)) / 100);
  const f2Min = Math.max(100, 200 * Math.floor(Math.min(400, ...points.map(p => p.f2 - 50)) / 200));
  const f2Max = 200 * Math.ceil(Math.max(2400, ...points.map(p => p.f2 + 60)) / 200);
  const bounds = { left: 45, right: width - 20, top: 38, bottom: height - 22 };
  const xAt = frequencyPosition(f2Min, f2Max, bounds.right, bounds.left);
  const yAt = frequencyPosition(f1Min, f1Max, bounds.top, bounds.bottom);
  context.font = '12px Consolas, monospace';
  context.fillStyle = '#566661';
  context.textAlign = 'center';
  context.fillText('F2 / Hz', (bounds.left + bounds.right) / 2, 12);
  const f2Step = width < 465 || f2Max - f2Min > 2600 ? 400 : 200;
  let previousX = -Infinity;
  for (let f2 = f2Max; f2 >= f2Min; f2 -= f2Step) {
    const x = xAt(f2);
    if (axis === 'logarithmic' && x - previousX < 34) continue;
    previousX = x;
    context.fillText(f2, x, bounds.top - 8);
    context.beginPath();
    context.moveTo(x, bounds.top);
    context.lineTo(x, bounds.bottom);
    context.strokeStyle = '#e2e5dc';
    context.stroke();
  }
  context.textAlign = 'right';
  context.fillText('F1 / Hz', bounds.left + 2, 12);
  const f1Step = f1Max - f1Min > 900 ? 200 : 100;
  let previousY = -Infinity;
  for (let f1 = f1Min; f1 <= f1Max; f1 += f1Step) {
    const y = yAt(f1);
    if (axis === 'logarithmic' && y - previousY < 17) continue;
    previousY = y;
    context.fillText(f1, bounds.left - 7, y + 4);
    context.beginPath();
    context.moveTo(bounds.left, y);
    context.lineTo(bounds.right, y);
    context.stroke();
  }
  context.strokeStyle = '#acb7ac';
  context.strokeRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  plotted = points.map(point => ({ ...point, x: xAt(point.f2), y: yAt(point.f1) }));
  const boxes = plotted.map(point => ({ x: point.x - 5, y: point.y - 5, w: 10, h: 10 }));
  const targets = groups.map(group => ({
    symbol: group.target.value.trim().replace(/^\[|\]$/g, '').normalize('NFC'),
    color: group.color,
  }));
  const targetColor = point => targets.find(target => target.symbol === point.symbol.normalize('NFC'))?.color;
  for (const point of plotted) {
    const take = point.take;
    const color = take?.group.color ?? targetColor(point) ?? '#73847a';
    const radius = take ? 5.5 : 3;
    context.beginPath();
    traceMarker(point.x, point.y, radius, take?.group.shape);
    context.fillStyle = color;
    context.fill();
    if (take && (take === current || take === take.group.kept)) {
      context.beginPath();
      context.arc(point.x, point.y, take === current ? 10 : 8, 0, Math.PI * 2);
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.stroke();
      context.lineWidth = 1;
    }
  }
  for (const point of [...plotted].reverse()) {
    const take = point.take;
    labelPoint(point, boxes, bounds, take?.id ?? point.symbol, take?.group.color ?? targetColor(point) ?? '#52655c',
      take ? 'bold 12px Consolas, monospace' : '14px "Charis SIL", "Segoe UI", sans-serif', 8);
  }
}

function closest(event, candidatesOnly = false) {
  const box = canvas.getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  let best;
  let distance = 15;
  for (const point of plotted) {
    if (candidatesOnly && !point.take) continue;
    const d = Math.hypot(x - point.x, y - point.y);
    if (d <= distance) {
      distance = d;
      best = point;
    }
  }
  return best;
}

canvas.addEventListener('pointermove', event => {
  const point = closest(event, true) ?? closest(event);
  detail.hidden = !point;
  canvas.style.cursor = point?.take ? 'pointer' : 'default';
  if (!point) return;
  detail.textContent = `${point.take ? point.take.id + ' · ' + point.take.file.name : '[' + point.symbol + '] 原音参考'} · F1 ${point.f1} / F2 ${point.f2} Hz`;
  detail.style.left = Math.max(0, Math.min(point.x + 12, canvas.clientWidth - detail.offsetWidth)) + 'px';
  detail.style.top = Math.max(0, point.y - detail.offsetHeight - 8) + 'px';
});
canvas.addEventListener('pointerleave', () => { detail.hidden = true; });
canvas.addEventListener('click', event => {
  const point = closest(event, true);
  if (point) selectTake(point.take, true);
});
new ResizeObserver(draw).observe(canvas);

try {
  const response = await fetch('/references');
  if (!response.ok) throw new Error('原音参考不可用');
  const data = await response.json();
  references = data.records.filter(point => Number.isFinite(point.f1) && Number.isFinite(point.f2));
  get('reference-count').textContent = `${references.length} 个原音参考点`;
  draw();
} catch {
  get('reference-count').textContent = '原音参考未载入';
}
