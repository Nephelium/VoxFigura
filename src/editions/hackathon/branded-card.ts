import type { CardOptions } from '@/components/phonetic-card/card-options';
import { formattedZhihuSignature, showZhihuSignature, zhihuAuthorNickname } from './card/author-profile';

const recordingModules = import.meta.glob('./recordings/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const optionalRecordings =
  recordingModules['./recordings/suan.mp3'] &&
  recordingModules['./recordings/swan.mp3'] &&
  recordingModules['./recordings/modal.mp3'] &&
  recordingModules['./recordings/breathy.mp3']
    ? {
        suan: recordingModules['./recordings/suan.mp3'],
        swan: recordingModules['./recordings/swan.mp3'],
        modal: recordingModules['./recordings/modal.mp3'],
        breathy: recordingModules['./recordings/breathy.mp3'],
      }
    : undefined;

export const brandedCard: CardOptions = {
  titlePrefix: '知乎',
  filePrefix: 'zhihu_',
  signature: {
    heading: '知乎署名',
    prefix: '知乎@',
    enabled: showZhihuSignature,
    nickname: zhihuAuthorNickname,
    formatted: formattedZhihuSignature,
  },
  ...(optionalRecordings ? { recordings: optionalRecordings } : {}),
};
