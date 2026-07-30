import '../ui/main.js';
import './inconsistency-annotator.js';
import { DomObservationAdapter } from './observer-adapter.js';
import type { InconsistencyAnnotator } from './inconsistency-annotator.js';

const tool = document.createElement('psp-inconsistency-annotator') as InconsistencyAnnotator;
tool.connect(new DomObservationAdapter());
document.querySelector('#review-tools')?.append(tool);
