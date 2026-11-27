import type { EngineStatus } from '@/stores/workbench';

export interface EngineStatusPresentation {
  tone: 'ok' | 'checking' | 'warn';
  label: string;
}

export function describeEngineStatus(status: EngineStatus): EngineStatusPresentation {
  if (status === 'python-vtl') {
    return { tone: 'ok', label: 'VTL 2.4 本地物理引擎已就绪' };
  }
  if (status === 'wasm-vtl') {
    return { tone: 'ok', label: 'VTL 2.4 浏览器 WASM 已就绪' };
  }
  if (status === 'checking') {
    return { tone: 'checking', label: '正在探测物理声道引擎…' };
  }
  return { tone: 'warn', label: '离线预渲染模式' };
}
