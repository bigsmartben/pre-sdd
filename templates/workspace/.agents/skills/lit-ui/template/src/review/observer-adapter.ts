import type { ProductObservation, ReviewDriver } from './review-host.js';

export class DomObservationAdapter implements ReviewDriver {
  locate(conceptId: string): Element | null {
    for (const element of document.querySelectorAll('[data-concept-id]')) {
      if (element.getAttribute('data-concept-id') === conceptId) return element;
    }
    return null;
  }

  observe(conceptId: string): ProductObservation | null {
    const element = this.locate(conceptId);
    if (!element) return null;
    return { conceptId, state: Object.freeze({ text: element.textContent ?? '', hidden: element.hasAttribute('hidden') }) };
  }

  dispatch(conceptId: string, event: Event): boolean {
    return this.locate(conceptId)?.dispatchEvent(event) ?? false;
  }
}
