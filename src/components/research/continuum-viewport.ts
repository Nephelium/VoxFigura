import { computed, ref } from 'vue';

const WIDTH = 15.15;
const HEIGHT = 12.35;
const CENTER = { x: -5.85 + WIDTH / 2, y: -3.05 + HEIGHT / 2 };
const minZoom = 0.65;
const maxZoom = 5;

export function useContinuumViewport() {
  const center = ref(CENTER);
  const zoom = ref(1);
  const viewBoxObj = computed(() => {
    const w = WIDTH / zoom.value;
    const h = HEIGHT / zoom.value;
    return { x: center.value.x - w / 2, y: center.value.y - h / 2, w, h };
  });
  const viewBox = computed(() => {
    const { x, y, w, h } = viewBoxObj.value;
    return `${x} ${y} ${w} ${h}`;
  });
  const dragging = ref(false);
  let suppressClick = false;
  let drag: { id: number; transform: DOMMatrix; origin: DOMPoint; center: typeof CENTER; x: number; y: number } | undefined;

  function setCenter(x: number, y: number) {
    center.value = {
      x: Math.max(CENTER.x - WIDTH / 2, Math.min(CENTER.x + WIDTH / 2, x)),
      y: Math.max(CENTER.y - HEIGHT / 2, Math.min(CENTER.y + HEIGHT / 2, y)),
    };
  }

  function zoomBy(factor: number, point = center.value) {
    const next = Math.max(minZoom, Math.min(maxZoom, zoom.value * factor));
    const ratio = zoom.value / next;
    setCenter(point.x + (center.value.x - point.x) * ratio, point.y + (center.value.y - point.y) * ratio);
    zoom.value = next;
  }

  function wheel(event: WheelEvent) {
    const matrix = (event.currentTarget as SVGSVGElement).getScreenCTM()?.inverse();
    if (!matrix || !event.deltaY) return;
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix));
  }

  function pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    suppressClick = false;
    const svg = event.currentTarget as SVGSVGElement;
    const transform = svg.getScreenCTM()?.inverse();
    if (!transform) return;
    drag = {
      id: event.pointerId, transform, center: center.value, x: event.clientX, y: event.clientY,
      origin: new DOMPoint(event.clientX, event.clientY).matrixTransform(transform),
    };
    svg.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return;
    if (!dragging.value && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    dragging.value = true;
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.transform);
    setCenter(drag.center.x + drag.origin.x - at.x, drag.center.y + drag.origin.y - at.y);
  }

  function pointerEnd(event: PointerEvent) {
    if (drag?.id !== event.pointerId) return;
    suppressClick = dragging.value;
    drag = undefined;
    dragging.value = false;
  }

  function consumeDragClick() {
    const skip = suppressClick;
    suppressClick = false;
    return skip;
  }

  function reset() {
    zoom.value = 1;
    center.value = CENTER;
  }

  return { viewBox, viewBoxObj, zoom, dragging, zoomBy, wheel, pointerDown, pointerMove, pointerEnd, consumeDragClick, reset };
}
