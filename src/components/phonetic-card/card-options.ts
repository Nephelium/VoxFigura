import type { ComputedRef, Ref } from 'vue';
import type { RasterCardImage } from './card/blocks/acoustic-blocks';

export interface CardOptions {
  titlePrefix?: string;
  filePrefix?: string;
  signature?: {
    heading: string;
    prefix: string;
    enabled: Ref<boolean>;
    nickname: Ref<string>;
    formatted: ComputedRef<string>;
  };
  stickers?: {
    name: string;
    items: readonly { id: string; label: string; url: string; isGif: boolean }[];
    resolveFrame: (id: string, time_s: number, animated: boolean) => Promise<RasterCardImage | null>;
  };
  recordings?: { suan: string; swan: string; modal: string; breathy: string };
}
