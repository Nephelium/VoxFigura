import {
  analyzeIpaChannels,
  type IpaAnalysisWorkerRequest,
  type IpaAnalysisWorkerResponse,
} from './ipa-recording-analysis';

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<IpaAnalysisWorkerRequest>) => void) | null;
  postMessage: (msg: IpaAnalysisWorkerResponse, transfer?: Transferable[]) => void;
};

scope.onmessage = (ev: MessageEvent<IpaAnalysisWorkerRequest>) => {
  const { id, channels, sampleRate, duration } = ev.data;
  const result = analyzeIpaChannels(channels, sampleRate, duration);
  scope.postMessage({ id, result }, [
    result.waveform.buffer,
    result.waveMean.buffer,
    result.spectrum.buffer,
  ]);
};
