import {
  PHONATION_M27_ANCHORS,
  activePhonationAnchorAt,
  interpolateGlottis10D,
  type PhonationAnchor,
} from '@vocalcut/core';
import {
  voqsAnchorLabel,
  voqsAnchorPatch,
  voqsLane,
  voqsProfile,
  type VoqsProfile,
  type VoqsTake,
} from '@/data/voqs-library';
import type { useWorkbenchStore } from '@/stores/workbench';

const DEGREE_BLEND_MAP: Record<1 | 2 | 3, number> = {
  1: 0.35,
  2: 0.7,
  3: 1.0,
};

function buildAnchorFromProfile(
  profile: VoqsProfile,
  take: VoqsTake,
  tSmp: number,
  options?: {
    existing?: PhonationAnchor;
    height?: number;
    degree?: 1 | 2 | 3;
    syllableId?: string;
  },
): PhonationAnchor {
  const basePatch = voqsAnchorPatch(profile, take, options?.height);
  const degree = options?.degree ?? 3;
  const blend = profile.group === 'height' ? 1 : DEGREE_BLEND_MAP[degree];
  let glottis = { ...take.glottis };
  if (profile.group !== 'height' && blend < 0.999) {
    const mixed = interpolateGlottis10D(PHONATION_M27_ANCHORS.modal, take.glottis, blend);
    if (mixed.ok) {
      glottis = {
        ...mixed.value,
        f0_hz: profile.group === 'closure' ? PHONATION_M27_ANCHORS.modal.f0_hz : mixed.value.f0_hz,
      };
    }
  }
  return {
    ...options?.existing,
    ...basePatch,
    blend,
    glottis,
    id: options?.existing?.id ?? `pa_${crypto.randomUUID()}`,
    t_smp: Math.max(0, Math.round(tSmp)),
    ...(options?.syllableId ? { syllable_id: options.syllableId } : {}),
  };
}

export function writeRecordedVoqs(
  store: ReturnType<typeof useWorkbenchStore>,
  profile: VoqsProfile,
  take: VoqsTake,
  tSmp: number,
  update?: PhonationAnchor,
  height?: number,
  degree?: 1 | 2 | 3,
) {
  const t_smp = update?.t_smp ?? tSmp;
  const anchor = buildAnchorFromProfile(profile, take, t_smp, {
    existing: update,
    height,
    degree,
  });
  const result = store.executeCommand({
    type: 'phonation.set_anchors',
    label: `写入 VoQS ${profile.symbol} · ${profile.label}`,
    payload: {
      anchors: [
        ...store.phonationAnchors.value.filter((a) => a.id !== anchor.id && a.t_smp !== anchor.t_smp),
        anchor,
      ],
    },
  });
  if (!result.ok) {
    store.pushToast(result.error?.hint ?? 'VoQS 实录锚点写入失败', 'warning');
    return;
  }
  store.selectedPhonationAnchorId.value = anchor.id;
  if (anchor.glottis) store.currentGlottisParams.value = { ...anchor.glottis };
  store.pushToast(`已写入 VoQS ${profile.symbol} · ${profile.label}`, 'success');
  return anchor;
}

/**
 * Write a paired start + automatic end-restoration VoQS anchor span onto `[startSmp, endSmp)`
 * (used when dragging a VoQS tag onto a phoneme/syllable or lane interval in PhonationEditor, T-13).
 */
export function writeRecordedVoqsSpan(
  store: ReturnType<typeof useWorkbenchStore>,
  profile: VoqsProfile,
  take: VoqsTake,
  startSmp: number,
  endSmp: number,
  durationSmp: number,
  options?: {
    height?: number;
    degree?: 1 | 2 | 3;
    targetLabel?: string;
    syllableId?: string;
  },
): PhonationAnchor | undefined {
  if (!Number.isFinite(durationSmp) || durationSmp <= 0) return undefined;
  const s0 = Math.max(0, Math.min(Math.max(0, durationSmp - 1), Math.round(Math.min(startSmp, endSmp))));
  const s1 = Math.max(s0 + 1, Math.min(durationSmp, Math.round(Math.max(startSmp, endSmp))));
  const currentAnchors = store.phonationAnchors.value;

  // Record prior phonation at `s0` for history metadata, and sample active state at `s1` for restoration
  // so downstream transitions swallowed inside `[s0, s1)` are accurately resumed at `s1`.
  const priorActive = activePhonationAnchorAt(currentAnchors, Math.max(0, s0 - 1));
  const afterActive = activePhonationAnchorAt(currentAnchors, s1);
  const beforeLabel = priorActive ? voqsLane(priorActive) : 'V';

  const startAnchor = buildAnchorFromProfile(profile, take, s0, {
    height: options?.height,
    degree: options?.degree,
    syllableId: options?.syllableId,
  });

  // Keep anchors strictly outside `[s0, s1]` (and if `s1 < durationSmp` without an exact anchor at `s1`, emit restoration)
  const hasExactEndAnchor = currentAnchors.some((a) => a.t_smp === s1);
  const filtered = currentAnchors.filter((a) => a.t_smp < s0 || a.t_smp > s1 || (hasExactEndAnchor && a.t_smp === s1));
  const nextAnchors: PhonationAnchor[] = [...filtered, startAnchor];

  if (s1 < durationSmp && !hasExactEndAnchor) {
    const modalProfile = voqsProfile('V');
    const restoreAnchor: PhonationAnchor = afterActive
      ? {
          ...afterActive,
          id: `pa_${crypto.randomUUID()}`,
          t_smp: s1,
          glottis: afterActive.glottis ? { ...afterActive.glottis } : { ...PHONATION_M27_ANCHORS.modal },
          voqs: afterActive.voqs ? { ...afterActive.voqs } : undefined,
        }
      : modalProfile && modalProfile.takes[0]
        ? buildAnchorFromProfile(modalProfile, modalProfile.takes[0], s1)
        : {
            id: `pa_${crypto.randomUUID()}`,
            t_smp: s1,
            regime: 'modal',
            blend: 1,
            glottis: { ...PHONATION_M27_ANCHORS.modal },
          };
    nextAnchors.push(restoreAnchor);
  }

  const targetDesc = options?.targetLabel ?? `${(s0 / 48000).toFixed(2)}–${(s1 / 48000).toFixed(2)}s`;
  const result = store.executeCommand({
    type: 'phonation.set_anchors',
    label: `赋予 ${targetDesc} VoQS ${profile.symbol} · ${profile.label}`,
    payload: {
      anchors: nextAnchors,
      editSpan: {
        start_smp: s0,
        end_smp: s1,
        before: beforeLabel,
        after: profile.symbol,
        target: targetDesc,
      },
    },
  });
  if (!result.ok) {
    store.pushToast(result.error?.hint ?? '区间 VoQS 锚点写入失败', 'warning');
    return undefined;
  }
  store.selectedPhonationAnchorId.value = startAnchor.id;
  if (startAnchor.glottis) store.currentGlottisParams.value = { ...startAnchor.glottis };
  store.pushToast(`已为 ${targetDesc} 配对写入 ${profile.symbol}（末尾自动还原）`, 'success', 2600);
  return startAnchor;
}

export function moveRecordedVoqsAnchor(
  store: ReturnType<typeof useWorkbenchStore>,
  anchorId: string,
  nextSmp: number,
  durationSmp: number,
): boolean {
  const current = store.phonationAnchors.value.find((a) => a.id === anchorId);
  if (!current) return false;
  const clampedSmp = Math.max(0, Math.min(durationSmp, Math.round(nextSmp)));
  if (clampedSmp === current.t_smp) return true;
  const updated: PhonationAnchor = { ...current, t_smp: clampedSmp };
  const anchors = [
    ...store.phonationAnchors.value.filter((a) => a.id !== anchorId && a.t_smp !== clampedSmp),
    updated,
  ];
  const res = store.executeCommand({
    type: 'phonation.set_anchors',
    label: `移动发声类型锚点 ${voqsAnchorLabel(updated)} 至 ${(clampedSmp / 48000).toFixed(3)}s`,
    payload: { anchors },
  });
  return res.ok;
}
