export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_EDGE_PX = 1280;
export const JPEG_QUALITY = 0.86;
const MAX_RAW_FILE_BYTES = 25 * 1024 * 1024;

export interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
}

function loadHtmlImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('无法解码所选图片，请确认文件未损坏'));
    };
    img.src = objectUrl;
  });
}

function detectTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

export async function compressImageFile(file: File): Promise<AttachedImage> {
  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error('仅支持图片文件（PNG / JPEG / WebP / GIF）');
  }
  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error('单张原图不能超过 25 MB');
  }
  const img = await loadHtmlImage(file);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) {
    throw new Error('无法读取图片有效尺寸');
  }

  const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('当前浏览器不支持 Canvas 图像压缩');
  }
  ctx.drawImage(img, 0, 0, width, height);

  const isJpeg = file.type === 'image/jpeg' || file.type === 'image/jpg';
  const keepPng = !isJpeg && detectTransparency(ctx, width, height);
  const mimeType: 'image/jpeg' | 'image/png' = keepPng ? 'image/png' : 'image/jpeg';
  const dataUrl = keepPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', JPEG_QUALITY);

  return {
    id: crypto.randomUUID(),
    name: file.name || '剪贴板图片',
    dataUrl,
    width,
    height,
    mimeType,
  };
}
