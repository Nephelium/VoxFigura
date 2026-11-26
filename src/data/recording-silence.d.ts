export interface RecordingSilence {
  duration_s: number;
  intervals: { start_s: number; end_s: number }[];
}

export function measureRecordingSilence(bytes: ArrayBuffer): Promise<RecordingSilence>;
