/* Dedicated local-only MediaPipe FaceLandmarker worker (zero network upload). */
let detector = null;
let activeDelegate = 'CPU';
let generation = 0;

async function createDetector(base, delegate, mode) {
  const { FaceLandmarker, FilesetResolver } = self.exports;
  const fileset = await FilesetResolver.forVisionTasks(base + 'wasm');
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: base + 'face_landmarker.task',
      delegate,
    },
    runningMode: mode || 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

self.onmessage = async ({ data }) => {
  const id = data.id;
  try {
    if (data.op === 'init') {
      if (detector) {
        try { detector.close(); } catch (_) {}
        detector = null;
      }
      const base = new URL('./', self.location.href).href;
      if (!self.exports || !self.exports.FaceLandmarker) {
        self.exports = {};
        importScripts(base + 'vision_bundle.classic.js');
      }
      const started = performance.now();
      const preferred = data.delegate || 'GPU';
      try {
        detector = await createDetector(base, preferred, data.mode || 'VIDEO');
        activeDelegate = preferred;
      } catch (firstErr) {
        if (preferred !== 'CPU') {
          detector = await createDetector(base, 'CPU', data.mode || 'VIDEO');
          activeDelegate = 'CPU';
        } else {
          throw firstErr;
        }
      }
      generation++;
      self.postMessage({
        id,
        ok: true,
        value: {
          generation,
          delegate: activeDelegate,
          init_ms: Math.round((performance.now() - started) * 10) / 10,
        },
      });
    } else if (data.op === 'frame') {
      if (!detector) throw new Error('detector_not_initialized');
      const started = performance.now();
      try {
        const res = data.mode === 'IMAGE'
          ? detector.detect(data.frame)
          : detector.detectForVideo(data.frame, data.time_ms);
        const lm = res.faceLandmarks && res.faceLandmarks[0];
        let flatPoints = null;
        if (lm && lm.length >= 468) {
          flatPoints = new Float32Array(lm.length * 3);
          for (let i = 0; i < lm.length; i++) {
            flatPoints[i * 3] = lm[i].x;
            flatPoints[i * 3 + 1] = lm[i].y;
            flatPoints[i * 3 + 2] = lm[i].z;
          }
        }
        const rawMat = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
        const matrix = rawMat && rawMat.data ? Float32Array.from(rawMat.data) : null;
        const rawShapes = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
        let blendshapes = null;
        if (rawShapes && rawShapes.length) {
          blendshapes = {};
          for (let i = 0; i < rawShapes.length; i++) {
            const c = rawShapes[i];
            if (c && c.categoryName) blendshapes[c.categoryName] = c.score;
          }
        }
        const transfer = [];
        if (flatPoints) transfer.push(flatPoints.buffer);
        if (matrix) transfer.push(matrix.buffer);
        self.postMessage(
          {
            id,
            ok: true,
            value: {
              points: flatPoints,
              pointCount: lm ? lm.length : 0,
              matrix,
              blendshapes,
              inference_ms: Math.round((performance.now() - started) * 10) / 10,
              time_ms: data.time_ms,
              generation,
            },
          },
          transfer,
        );
      } finally {
        if (data.frame && typeof data.frame.close === 'function') {
          data.frame.close();
        }
      }
    } else if (data.op === 'close') {
      if (detector) {
        try { detector.close(); } catch (_) {}
        detector = null;
      }
      self.postMessage({ id, ok: true, value: null });
    } else {
      throw new Error('unsupported_worker_operation');
    }
  } catch (error) {
    if (data && data.frame && typeof data.frame.close === 'function') {
      try { data.frame.close(); } catch (_) {}
    }
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
