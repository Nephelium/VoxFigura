import type { GuideModuleId, OverlayViewId, SettingsTabId } from '@/stores/workbench';

export type GuideDemoKind =
  | 'main-voqs'
  | 'ipa-rounding'
  | 'm27-roundtrip'
  | 'mixer-phonation'
  | 'continuum-suan-swan'
  | 'dialect-sandhi'
  | 'arranger-prebeat'
  | 'stage-cinema'
  | 'explore-compare';

export interface GuideWorkflowStep {
  title: string;
  detail: string;
  uiHint?: string;
}

export interface GuideSyntaxTable {
  caption: string;
  tag: string;
  headers: string[];
  rows: string[][];
}

export interface GuidePitfall {
  title: string;
  detail: string;
}

export interface GuideCodeBlock {
  title: string;
  tag: string;
  code: string;
  caption?: string;
}

export type GuideDiagramKey = 'main-architecture' | 'ipa-architecture' | 'm27-architecture' | 'stage-pipeline' | 'continuum-pipeline' | 'dialect-architecture' | 'mixer-pipeline' | 'card-architecture';

export interface GuideDemoSpec {
  id: string;
  kind: GuideDemoKind;
  title: string;
  subtitle: string;
  requiresEngine: 'none' | 'required' | 'optional-audio' | 'optional-pose';
  phoneticGoal: string;
  expectedObservation: string;
  buttonLabel: string;
}

export interface GuideDemoPlaceholder {
  badge: string;
  title: string;
  detail: string;
}

export interface GuideModuleDoc {
  id: GuideModuleId;
  sectionAnchor: string;
  navTitle: string;
  title: string;
  code: string;
  icon: string;
  perspectiveBadge: string;
  summary: string;
  phoneticBasisTitle: string;
  phoneticBasis: string[];
  workflowSteps: GuideWorkflowStep[];
  demoSpec?: GuideDemoSpec;
  demoPlaceholder?: GuideDemoPlaceholder;
  diagramKey?: GuideDiagramKey;
  chartKey?: 'mainSynthesisPhysics' | 'coarticulation' | 'voqsScale' | 'arrangerOverview' | 'stageCinemaCurves' | 'm27RealtimeBudget' | 'cardExportBudget';
  tables?: GuideSyntaxTable[];
  referenceCodeBlocks?: GuideCodeBlock[];
  pitfalls: GuidePitfall[];
  shortcuts: Array<[string, string]>;
  jumpAction?: {
    label: string;
    overlay?: OverlayViewId;
    settingsTab?: SettingsTabId;
    guideSection?: string;
  };
}

export interface GuideAppendixSection {
  id: string;
  icon: string;
  nav: string;
  code: string;
  title: string;
  lead: string;
  bullets: Array<{ head: string; body: string }>;
  callout?: { kind: 'note' | 'warn'; title: string; text: string };
  tables?: GuideSyntaxTable[];
  chartKey?: 'coarticulation' | 'voqsScale' | 'arrangerOverview';
  showVoqsBadges?: boolean;
  showShortcutGroups?: boolean;
  actionButton?: {
    label: string;
    overlay: OverlayViewId;
    settingsTab?: SettingsTabId;
  };
}
