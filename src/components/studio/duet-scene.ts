import { SAMPLE_RATE_HZ, type Syllable, type VcProject } from '@vocalcut/core';
import type { DuetContour, DuetKey, DuetLayer, DuetPoint, DuetScene } from './legacy-duet';
import { drawStageCaption, stageLyricTokens, type StageCaptionBounds } from './stage-caption';
import { readStageTractViewConfig, stageAnatomy, stageClipAnatomy, stagePhraseId } from './stage-tract-renderer';
import { isStageAudioTrack, stageLayer, type NleClip, type StageTargetId } from './nle-timeline';
import { mediaUrl, sessionMedia } from './studio-media';
import { type ActorId, type SceneOptions, type Transform } from './stage-scene';

const WIDTH = 1280;
const HEIGHT = 720;
const RAD = Math.PI / 180;
const images = new WeakMap<DuetScene, Promise<Map<string, HTMLImageElement>>>();
const stills = new Map<string, Promise<HTMLImageElement>>();
const active = (item: NleClip,t: number) => item.startSmp <= t && t < item.endSmp;
const local = (item: NleClip,t: number) => t-item.startSmp+item.sourceStartSmp;

function before<T>(list: readonly T[], value: number, time: (item: T) => number) {
  let left = 0, right = list.length;
  while (left < right) {
    const middle = (left+right) >>> 1;
    if (time(list[middle]) <= value) left=middle+1;
    else right=middle;
  }
  return left-1;
}
function poseAt(keys: DuetKey[] | undefined, t: number, smooth = false) {
  if (!keys?.length) return { x: 0, y: 0, zoom: 1, angle: 0, flip: false, layout: 'ensemble' };
  const i = Math.max(0,before(keys,t,key=>key.sample));
  const a = keys[i], b = keys[i+1] ?? a;
  const fraction = a === b ? 0 : Math.max(0, Math.min(1,(t-a.sample)/(b.sample-a.sample)));
  const u = smooth ? fraction*fraction*(3-2*fraction) : fraction;
  const lerp = (from: number,to: number) => from+u*(to-from);
  return { x: lerp(a.x,b.x), y: lerp(a.y,b.y), zoom: lerp(a.zoom,b.zoom), angle: lerp(a.angle??0,b.angle??0),
    flip: a.flip ?? false, layout: a.layout ?? 'ensemble' };
}
function decodePicture(src: string) {
  let pending = stills.get(src);
  if (!pending) {
    const image = new Image();
    image.src = src;
    pending = image.decode().then(()=>image).catch(error=>{ stills.delete(src); throw error; });
    if (!src.startsWith('data:')) stills.set(src,pending);
  }
  return pending;
}
export function prepareDuetScene(scene: DuetScene) {
  let pending = images.get(scene);
  if (!pending) {
    const picture = (id: string,src: string) => decodePicture(src).then(image => [id,image] as const);
    const list = (scene.stage.layers ?? [])
      .filter(layer => !['lyrics','syllable0','syllable1','spectrum'].includes(layer.id))
      .map(layer => picture(layer.id,layer.atlas));
    if (scene.stage.backgroundImage) list.push(picture('background',scene.stage.backgroundImage));
    pending = Promise.all(list).then(items=>new Map(items)).catch(error => { images.delete(scene); throw error; });
    images.set(scene,pending);
  }
  return pending;
}

function drawPicture(ctx: CanvasRenderingContext2D, layer: DuetLayer, image: HTMLImageElement, sample: number, override: Transform | undefined) {
  const cue = layer.cues[before(layer.cues,sample,key=>key.sample)];
  if (!layer.visible || !cue || cue.cell < 0 || cue.reveal === 0) return;
  const pose = poseAt(layer.keys,sample);
  const sourceWidth = image.naturalWidth/layer.columns, sourceHeight = image.naturalHeight/layer.rows;
  const reveal = cue.reveal ?? 1;
  ctx.save();
  ctx.translate(pose.x,pose.y);
  if (override && layer.id === 'character') {
    ctx.translate((override.x-84)*12.8,(override.y-74)*7.2);
    ctx.scale(override.scale/.9,override.scale/.9);
    ctx.globalAlpha *= override.opacity;
  }
  ctx.rotate(pose.angle*RAD);
  ctx.scale(pose.zoom,pose.zoom);
  ctx.drawImage(image,(cue.cell%layer.columns)*sourceWidth,Math.floor(cue.cell/layer.columns)*sourceHeight,
    sourceWidth*reveal,sourceHeight,-layer.width/2,-layer.height/2,layer.width*reveal,layer.height);
  ctx.restore();
}

function anatomyAt(scene: DuetScene, c: NleClip, sample: number) {
  const motion = scene.motion.get(c.assetId ?? '');
  if (!motion?.geometry.length) return;
  let source = sample;
  const map = motion.timeMap;
  if (map.length) {
    const i = before(map,sample,item=>item.dstStart);
    const left = map[i], right = map[i+1];
    const scale = (s: number,a: number,b: number,c: number,d: number) => c+(d-c)*(s-a)/Math.max(1,b-a);
    source = left && sample < left.dstEnd
      ? scale(sample,left.dstStart,left.dstEnd,left.srcStart,left.srcEnd)
      : right && left ? scale(sample,left.dstEnd,right.dstStart,left.srcEnd,right.srcStart)
      : left ? left.srcEnd+(sample-left.dstEnd) : right.srcStart-(right.dstStart-sample);
  }
  const time = source/SAMPLE_RATE_HZ;
  const i = Math.max(0,before(motion.geometry,time,f=>f.time));
  const from = motion.geometry[i], to = motion.geometry[i+1];
  if (!from.contours.tongue?.length) return;
  const mix = to ? Math.max(0,Math.min(1,(time-from.time)/Math.max(.00001,to.time-from.time))) : 0;
  return {
    t_s: time,
    contours: interpolateContours(from.contours, to?.contours, mix * mix * (3 - 2 * mix)),
    params: [],
    nasal_area_cm2: 0,
  };
}
function interpolateContours(from: DuetContour, to: DuetContour | undefined, fraction: number): DuetContour {
  if (!to || !fraction) return from;
  return Object.fromEntries(Object.entries(from).map(([key, points]) => {
    const next = to[key];
    const blend = next?.length === points.length
      ? points.map(([x, y], index): DuetPoint => [x + (next[index][0] - x) * fraction, y + (next[index][1] - y) * fraction])
      : points;
    return [key, blend];
  }));
}
function syllableLine(syllables: Syllable[], sample: number) {
  const current = before(syllables,sample,s=>s.start_smp);
  let first = 0, last = 1;
  for (;last<syllables.length;last++) {
    const gap = syllables[last].start_smp-syllables[last-1].end_smp;
    if (last-first<12 && gap<10600) continue;
    if (last > current) break;
    first = last;
  }
  const focus = current >= 0 && sample < syllables[current].end_smp ? syllables[current] : undefined;
  return { line: syllables.slice(first,last), focus };
}
function drawSubtitles(ctx: CanvasRenderingContext2D, project: VcProject, clips: readonly NleClip[], trackClips: NleClip[], sample: number, placement: Transform) {
  const bounds: StageCaptionBounds[] = [];
  if (placement.opacity <= 0) return bounds;
  const style = stageLayer(project,'v3')?.style;
  const accent = style?.highlight_color ?? '#a8f6ff';
  const size = (style?.font_size_px ?? 54)/1.5;
  ctx.save();
  ctx.translate((placement.x-50)*12.8,(placement.y-88)*7.2);
  ctx.globalAlpha *= placement.opacity;
  const states = trackClips.flatMap(clip => {
    const phrase = project.clips[stagePhraseId(clip, clips) ?? ''];
    if (!phrase) return [];
    const t = local(clip,sample);
    const syllables = phrase.syllable_order.map(id=>phrase.syllables[id]).filter(Boolean);
    return [{ clip, phrase, t, ...syllableLine(syllables,t) }];
  });
  for (const [index, { clip, phrase, t, focus }] of states.entries()) if (focus) {
    const isRight = clip.duetVoice === 1;
    const x = clip.duetVoice === undefined ? (index + .5) * WIDTH / states.length : isRight ? 1018 : 262;
    ctx.save();
    ctx.translate(x,579);
    ctx.rotate((style?.tilt_deg ?? -7)*(isRight?-1:1)*RAD);
    ctx.scale(placement.scale,placement.scale);
    const color = isRight ? '#f6aff4' : accent;
    const ipa = focus.ipa.length ? '[' + focus.ipa.join('') + ']' : '';
    const tokens = style?.reveal_mode === 'single_char' ? stageLyricTokens(phrase, t, 'single_char').map(token => ({ ...token, color }))
      : [{ key: focus.id, text: focus.text, ipa, color }];
    const extent = drawStageCaption(ctx,tokens,style,size,0,0,{ weight: 800, shadow: color });
    if (extent) bounds.push({ ...extent, clipId: clip.id });
    ctx.restore();
  }
  const lead = states.find(state=>state.clip.duetVoice===0) ?? states[0];
  if (lead && style?.reveal_mode !== 'single_char') {
    ctx.translate(640,642);
    ctx.scale(placement.scale,placement.scale);
    const extent = drawStageCaption(ctx,lead.line.map(syllable => ({
      key: syllable.id, text: syllable.text,
      color: style?.reveal_mode === 'line' || lead.t >= syllable.start_smp ? style?.text_color ?? '#e8dcff' : 'rgba(201,213,241,.34)',
    })),style,size * .7,0,0,{ shadow: '#9454cd' });
    if (extent) bounds.push(extent);
  }
  ctx.restore();
  return bounds;
}

const FFT_SIZE = 1024;
const halfFft = FFT_SIZE/2;
const hann = Float32Array.from({length: FFT_SIZE},(_,i)=>(1-Math.cos(i*2*Math.PI/(FFT_SIZE-1)))*.5);
const octaveBands=Array.from({length:84},(_,i)=>Math.floor(1+470*((i+1)/84)**2));
function drawSpectrum(ctx: CanvasRenderingContext2D, clips: readonly NleClip[], sample: number, theme: string) {
  const real = new Float32Array(FFT_SIZE), imaginary = new Float32Array(FFT_SIZE);
  for (const clip of clips) {
    if (!active(clip,sample) || !isStageAudioTrack(clip.track) || clip.muted || !clip.assetId) continue;
    const audio = sessionMedia.get(clip.assetId)?.audio;
    if (!audio) continue;
    const left = audio.getChannelData(0), right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
    const gain = (clip.gain ?? 1)*.5, offset = local(clip,sample)-halfFft;
    for (let i=0;i<FFT_SIZE;i++) real[i] += ((left[offset+i]??0)+(right[offset+i]??0))*gain*hann[i];
  }
  for (let i=1,j=0;i<FFT_SIZE;i++) {
    let bit = halfFft;
    while (j&bit) { j^=bit; bit>>=1; }
    j^=bit;
    if (j>i) { const value=real[i]; real[i]=real[j]; real[j]=value; }
  }
  for (let span=2;span<=FFT_SIZE;span*=2) {
    const half=span/2;
    for (let k=0;k<half;k++) {
      const angle=-2*Math.PI*k/span, c=Math.cos(angle), s=Math.sin(angle);
      for (let i=k;i<FFT_SIZE;i+=span) {
        const j=i+half, re=c*real[j]-s*imaginary[j], im=c*imaginary[j]+s*real[j];
        real[j]=real[i]-re; imaginary[j]=imaginary[i]-im;
        real[i]+=re; imaginary[i]+=im;
      }
    }
  }
  ctx.save();
  const tint=ctx.createLinearGradient(46,0,1234,0);
  tint.addColorStop(0,theme); tint.addColorStop(.5,'#d7c5ff'); tint.addColorStop(1,'#f0b3eb');
  ctx.fillStyle=tint;
  for (let i=0;i<84;i++) {
    const first = octaveBands[i], last = Math.max(first+1,octaveBands[i+1] ?? halfFft);
    let magnitude = 0;
    for (let bin=first;bin<last;bin++) magnitude=Math.max(magnitude,Math.hypot(real[bin],imaginary[bin])/FFT_SIZE);
    const height=Math.max(1,Math.min(23,15*Math.log1p(280*magnitude)));
    ctx.globalAlpha = .20+.62*height/23;
    ctx.fillRect(46+i*14.3,713-height,9.5,height);
  }
  ctx.restore();
}

export async function drawDuetScene(canvas: HTMLCanvasElement, project: VcProject, scene: DuetScene, clips: readonly NleClip[], sample: number,
  placement: Record<ActorId,Transform>, isCurrent: () => boolean, options: SceneOptions) {
  const playing = (track: StageTargetId) => clips.filter(clip=>clip.track===track && active(clip,sample));
  const track = stageLayer(project,'v1');
  const style = track?.tract_render_style ?? 'natural';
  const tractView = readStageTractViewConfig(track);
  const voices = track?.visible ? playing('v1').reverse() : [];
  const extraV2Specs = (!options.overlay && stageLayer(project, 'v2')?.visible)
    ? playing('v2')
      .map(clip => ({ clip, url: !clip.duetLayer && clip.assetId ? mediaUrl(project.assets[clip.assetId]) : undefined }))
      .filter((entry): entry is { clip: NleClip; url: string } => Boolean(entry.url))
    : [];
  const [pictures, anatomy, extraV2Pictures] = await Promise.all([
    prepareDuetScene(scene),
    Promise.all(voices.map(async clip => {
      const motion = anatomyAt(scene,clip,local(clip,sample));
      if (motion) return {
        clip,
        art: await stageAnatomy(motion, style, project.id + '/' + clip.assetId + '/' + Math.round(motion.t_s * 1000), {
          showHead: tractView.headMode !== 'none',
          bustBase: true,
        }),
      };
      if (scene.motion.has(clip.assetId ?? '')) return null;
      return { clip, art: await stageClipAnatomy(project,clip,clips,sample,style,options.tractDraft,undefined,options.monitor) };
    })),
    Promise.all(extraV2Specs.map(async entry => ({ clip: entry.clip, picture: await decodePicture(entry.url) }))),
    document.fonts.ready,
  ]);
  if (!isCurrent()) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建双人剪辑画布');
  const stage = scene.stage;
  const appearance = stage.appearanceKeys?.[before(stage.appearanceKeys,sample,key=>key.sample)];
  const theme = appearance?.theme ?? stage.theme ?? '#72edeb';
  ctx.setTransform(canvas.width/WIDTH,0,0,canvas.height/HEIGHT,0,0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0,0,WIDTH,HEIGHT);
  if (!options.overlay) { ctx.fillStyle=appearance?.background ?? stage.background ?? '#10132e'; ctx.fillRect(0,0,WIDTH,HEIGHT); }
  const bg = pictures.get('background');
  if (!options.overlay && stageLayer(project,'v0')?.visible && bg && playing('v0').length) ctx.drawImage(bg,0,0,WIDTH,HEIGHT);
  if (stageLayer(project,'v1')?.visible) {
    const camera = poseAt(stage.cameraKeys,sample,true);
    const layout = stage.cameraKeys?.length ? camera.layout : stage.layout ?? 'ensemble';
    const solo = layout === 'solo-a' || layout === 'solo-b';
    const visibleAnatomy = anatomy.filter(entry => entry !== null);
    const originalVoices = visibleAnatomy.filter(({ clip }, index) => clip.duetVoice !== undefined &&
      visibleAnatomy.findIndex(candidate => candidate.clip.duetVoice === clip.duetVoice) === index);
    for (const { clip, art } of originalVoices) {
      const index = clip.duetVoice!;
      if (solo && index !== (layout==='solo-a'?0:1)) continue;
      const pose = poseAt(stage.keyframes?.[scene.voices[index]],sample);
      ctx.save();
      ctx.translate(640+camera.x+(placement.v1.x-50)*12.8,360+camera.y+(placement.v1.y-46)*7.2);
      ctx.scale(camera.zoom*placement.v1.scale,camera.zoom*placement.v1.scale);
      ctx.translate(-640,-360);
      ctx.translate((solo?640:index===0?321:959)+pose.x,(solo?342:layout==='split'?336:index===0?368:316)+pose.y);
      ctx.rotate(pose.angle*RAD);
      const size = (solo?42:34)*pose.zoom;
      ctx.scale(pose.flip !== (!solo && index===1) ? -size : size,-size);
      ctx.translate(-.85,1.6);
      ctx.globalAlpha *= placement.v1.opacity;
      ctx.scale(1,-1);
      const { x, y, width, height } = art.bounds;
      const fit = height > 16 ? 13.8 / height : 1;
      ctx.drawImage(art.image, x * fit, y * fit, width * fit, height * fit);
      ctx.restore();
    }
    const extraVoices = visibleAnatomy.filter(({clip}) => clip.duetVoice === undefined);
    for (const [index, { art }] of extraVoices.entries()) {
      ctx.save();
      ctx.globalAlpha *= placement.v1.opacity;
      const offsetX = (placement.v1.x - 50) * 12.8;
      const offsetY = (placement.v1.y - 46) * 7.2;
      const x = WIDTH * (index + .5) / extraVoices.length + offsetX;
      const w = 380 * placement.v1.scale, h = w * art.bounds.height / art.bounds.width;
      ctx.drawImage(art.image,x-w/2,295+offsetY-h/2,w,h);
      ctx.restore();
    }
  }
  if (!options.overlay && stageLayer(project,'v2')?.visible) {
    const layers = playing('v2');
    for (const layer of stage.layers ?? []) {
      const clip = layers.find(item=>item.duetLayer===layer.id);
      if (!clip) continue;
      const picture = pictures.get(layer.id);
      if (picture) drawPicture(ctx,layer,picture,local(clip,sample),placement.v2);
      if (layer.id === 'spectrum') drawSpectrum(ctx,clips,sample,theme);
    }
    for (const { picture } of extraV2Pictures) {
      const pose = placement.v2, w=WIDTH*.19*pose.scale, h=w*picture.height/picture.width;
      ctx.save(); ctx.globalAlpha *= pose.opacity;
      ctx.drawImage(picture,WIDTH*pose.x/100-w/2,HEIGHT*pose.y/100-h/2,w,h); ctx.restore();
    }
  }
  const subtitles = stageLayer(project,'v3')?.visible ? drawSubtitles(ctx,project,clips,playing('v3'),sample,placement.v3) : [];
  options.onSubtitleBounds?.(subtitles);
}
