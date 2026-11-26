import type { CardOptions } from '@/components/phonetic-card/card-options';
import { formattedZhihuSignature, showZhihuSignature, zhihuAuthorNickname } from './card/author-profile';
import suan from './recordings/suan.mp3?url';
import swan from './recordings/swan.mp3?url';
import modal from './recordings/modal.mp3?url';
import breathy from './recordings/breathy.mp3?url';

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
  recordings: { suan, swan, modal, breathy },
};
