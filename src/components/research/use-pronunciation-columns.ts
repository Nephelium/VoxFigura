import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { getActiveSplitterValue, PRONUNCIATION_SPLITTERS } from '@/data/splitter-layout';
import { useWorkbenchStore } from '@/stores/workbench';

const minWidths = [145, 200, 212, 246];
const trackProperties = ['--pd-library-track', '--pd-list-track', '--pd-editor-track', '--pd-tools-track'] as const;
const gutterWidth = 12;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const storedPositions = () => PRONUNCIATION_SPLITTERS.map(spec => getActiveSplitterValue(spec.storageKey));

export function usePronunciationColumns(host: Ref<HTMLElement | null>) {
  const store = useWorkbenchStore();
  const requested = ref(storedPositions());
  const contentWidth = ref(1100);
  const minimums = computed(() => {
    const trackWidth = Math.max(885, contentWidth.value - gutterWidth * 3);
    return minWidths.map(width => Math.ceil(100 * width / trackWidth));
  });
  const positions = computed(() => {
    const [library, list, editor, tools] = minimums.value;
    const [libraryEnd, listEnd, editorEnd] = requested.value;
    const first = clamp(libraryEnd, library, 100 - list - editor - tools);
    const second = clamp(listEnd, first + list, 100 - editor - tools);
    return [first, second, clamp(editorEnd, second + editor, 100 - tools)];
  });
  const splitters = computed(() => {
    const edges = [0, ...positions.value, 100];
    return PRONUNCIATION_SPLITTERS.map((spec, i) => ({
      ...spec,
      value: edges[i + 1],
      min: Math.max(spec.min, edges[i] + minimums.value[i]),
      max: Math.min(spec.max, edges[i + 2] - minimums.value[i + 1]),
    }));
  });
  const columnStyles = computed(() => {
    const edges = [0, ...positions.value, 100];
    return Object.fromEntries(trackProperties.map((property, i) => [property, `${edges[i + 1] - edges[i]}fr`]));
  });
  function setPosition(index: number, value: number) {
    const next = [...positions.value];
    next[index] = value;
    requested.value = next;
  }
  let observer: ResizeObserver | undefined;
  onMounted(() => {
    if (!host.value || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(([entry]) => { contentWidth.value = entry.contentRect.width; });
    observer.observe(host.value);
  });
  watch(() => store.splitterLayoutVersion.value, () => { requested.value = storedPositions(); });
  onBeforeUnmount(() => observer?.disconnect());
  return { columnStyles, splitters, setPosition };
}
